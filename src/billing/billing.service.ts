import {BadRequestException, Injectable, Logger, UnauthorizedException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PlanCode, Prisma} from '@prisma/client';
import {createHmac, timingSafeEqual} from 'crypto';
import {AuditService} from '../audit/audit.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {EntitlementsService} from './entitlements.service';
import {GRACE_DAYS, PAID_PLANS, PLANS, priceFor} from './plans';

const DAY_MS = 86_400_000;

export type BillingCycle = 'monthly' | 'annual';

type WebhookEvent = {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'subscription.cancelled';
  data: {
    workspaceId: string;
    plan?: PlanCode;
    cycle?: BillingCycle;
    amount?: number;
    reference?: string;
  };
};

function addPeriod(from: Date, cycle: BillingCycle) {
  const next = new Date(from);
  if (cycle === 'annual') {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  } else {
    next.setUTCMonth(next.getUTCMonth() + 1);
  }
  return next;
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async overview(workspaceId: string) {
    const snapshot = await this.entitlements.snapshot(workspaceId);
    const invoices = await this.prisma.invoice.findMany({
      where: {workspaceId},
      orderBy: {issuedAt: 'desc'},
      take: 24,
    });
    return {
      ...snapshot,
      invoices,
      provider: this.provider(),
      catalog: PAID_PLANS.map(code => ({
        ...PLANS[code],
        monthlyBdt: priceFor(code, 'monthly'),
        annualBdt: priceFor(code, 'annual'),
      })),
    };
  }

  private provider() {
    return this.config.get<string>('BILLING_PROVIDER') || 'manual';
  }

  /**
   * Starts a plan purchase. With the manual provider this records a pending invoice and returns
   * payment instructions; an admin activates the plan once payment is confirmed.
   */
  async checkout(ctx: WorkspaceContext, actorId: string, plan: PlanCode, cycle: BillingCycle) {
    if (!PAID_PLANS.includes(plan)) {
      throw new BadRequestException('Choose Starter, Growth or Agency');
    }
    const amount = priceFor(plan, cycle);
    const now = new Date();
    const reference = `PP-${now.getTime().toString(36).toUpperCase()}`;
    const invoice = await this.prisma.invoice.create({
      data: {
        workspaceId: ctx.id,
        plan,
        amount: amount * 100,
        status: 'pending',
        periodStart: now,
        periodEnd: addPeriod(now, cycle),
        provider: this.provider(),
        providerRef: reference,
      },
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: 'billing.checkout_started',
      entityType: 'invoice',
      entityId: invoice.id,
      metadata: {plan, cycle, amount},
    });
    return {
      mode: this.provider(),
      invoice,
      instructions:
        this.config.get<string>('BILLING_MANUAL_INSTRUCTIONS') ||
        `Pay ৳${amount.toLocaleString('en-US')} and quote reference ${reference}. Your plan activates once the payment is confirmed.`,
    };
  }

  async cancelAtPeriodEnd(ctx: WorkspaceContext, actorId: string, cancel: boolean) {
    const sub = await this.entitlements.subscription(ctx.id);
    const updated = await this.prisma.subscription.update({
      where: {id: sub.id},
      data: {cancelAtPeriodEnd: cancel},
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: cancel ? 'billing.cancel_scheduled' : 'billing.cancel_reverted',
      entityType: 'subscription',
      entityId: sub.id,
    });
    return updated;
  }

  /** Verifies `x-postpilot-signature: sha256=<hex HMAC of the raw body>`. */
  verifySignature(rawBody: Buffer | undefined, signatureHeader: string | undefined) {
    const secret = this.config.get<string>('BILLING_WEBHOOK_SECRET');
    if (!secret) {
      throw new UnauthorizedException('Billing webhooks are not configured');
    }
    if (!rawBody || !signatureHeader?.startsWith('sha256=')) {
      throw new UnauthorizedException('Missing webhook signature');
    }
    const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
    const given = Buffer.from(signatureHeader.slice('sha256='.length));
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  /** Applies a verified event once; replays of the same event id are acknowledged and ignored. */
  async handleEvent(provider: string, event: WebhookEvent) {
    if (!event?.id || !event?.type || !event?.data?.workspaceId) {
      throw new BadRequestException('Malformed billing event');
    }
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.billingEvent.create({
          data: {
            provider,
            eventId: event.id,
            type: event.type,
            workspaceId: event.data.workspaceId,
            payload: event as unknown as Prisma.InputJsonValue,
          },
        });
        await this.apply(tx, provider, event);
        return {received: true, duplicate: false};
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return {received: true, duplicate: true};
      }
      throw error;
    }
  }

  private async apply(tx: Prisma.TransactionClient, provider: string, event: WebhookEvent) {
    const {workspaceId} = event.data;
    const sub = await this.entitlements.subscription(workspaceId, tx);
    const now = new Date();

    if (event.type === 'payment.succeeded') {
      const plan = event.data.plan;
      if (!plan || !PAID_PLANS.includes(plan)) {
        throw new BadRequestException('payment.succeeded requires a paid plan');
      }
      const cycle: BillingCycle = event.data.cycle === 'annual' ? 'annual' : 'monthly';
      // Renewing the same plan extends from the current period end; anything else starts now.
      const renewing = sub.status === 'ACTIVE' && sub.plan === plan && sub.currentPeriodEnd > now;
      const start = renewing ? sub.currentPeriodStart : now;
      const end = addPeriod(renewing ? sub.currentPeriodEnd : now, cycle);
      await tx.subscription.update({
        where: {id: sub.id},
        data: {
          plan,
          status: 'ACTIVE',
          billingCycle: cycle,
          currentPeriodStart: start,
          currentPeriodEnd: end,
          graceEndsAt: null,
          cancelAtPeriodEnd: false,
          trialEndsAt: null,
          provider,
        },
      });
      const pending = event.data.reference
        ? await tx.invoice.findFirst({where: {workspaceId, providerRef: event.data.reference}})
        : null;
      if (pending) {
        await tx.invoice.update({where: {id: pending.id}, data: {status: 'paid'}});
      } else {
        await tx.invoice.create({
          data: {
            workspaceId,
            plan,
            amount: event.data.amount ?? priceFor(plan, cycle) * 100,
            status: 'paid',
            periodStart: now,
            periodEnd: end,
            provider,
            providerRef: event.data.reference || event.id,
          },
        });
      }
    } else if (event.type === 'payment.failed') {
      await tx.subscription.update({
        where: {id: sub.id},
        data: {status: 'PAST_DUE', graceEndsAt: new Date(now.getTime() + GRACE_DAYS * DAY_MS)},
      });
    } else if (event.type === 'subscription.cancelled') {
      await tx.subscription.update({where: {id: sub.id}, data: {status: 'CANCELLED'}});
    } else {
      throw new BadRequestException(`Unsupported billing event type ${String(event.type)}`);
    }

    await this.audit.record(
      {
        workspaceId,
        actorId: null,
        action: `billing.${event.type}`,
        entityType: 'subscription',
        entityId: sub.id,
        metadata: {provider, eventId: event.id, plan: event.data.plan},
      },
      tx,
    );

    const owner = await tx.workspace.findUnique({where: {id: workspaceId}, select: {ownerId: true}});
    if (owner) {
      await this.notifications.notify({
        userId: owner.ownerId,
        workspaceId,
        type: `billing_${event.type.replace('.', '_')}`,
        title: event.type === 'payment.succeeded' ? 'Payment received' : 'Billing needs attention',
        body:
          event.type === 'payment.succeeded'
            ? `Your ${PLANS[event.data.plan as PlanCode].name} plan is active.`
            : event.type === 'payment.failed'
              ? `Payment failed. Scheduling keeps working for ${GRACE_DAYS} days while you update billing.`
              : 'Your subscription was cancelled.',
        dedupeKey: `billing:${provider}:${event.id}`,
        email: true,
      });
    }
  }
}
