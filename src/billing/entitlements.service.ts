import {HttpException, HttpStatus, Injectable} from '@nestjs/common';
import {Prisma, Subscription} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';
import {GRACE_DAYS, PLANS, TRIAL_DAYS} from './plans';

const DAY_MS = 86_400_000;

/** Statuses that consume the scheduled-post allowance. */
const COUNTED_TARGET_STATUSES = ['SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'NEEDS_ACTION'] as const;

export class PlanLimitException extends HttpException {
  constructor(code: string, message: string) {
    super({statusCode: HttpStatus.PAYMENT_REQUIRED, code, message}, HttpStatus.PAYMENT_REQUIRED);
  }
}

export type EffectiveState = 'trialing' | 'active' | 'grace' | 'expired';

/** Server-side plan checks (PRD FR-12). Over-quota calls fail without touching existing drafts. */
@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  static newTrial(now = new Date()) {
    const end = new Date(now.getTime() + TRIAL_DAYS * DAY_MS);
    return {
      plan: 'TRIAL' as const,
      status: 'TRIALING' as const,
      trialEndsAt: end,
      currentPeriodStart: now,
      currentPeriodEnd: end,
    };
  }

  async subscription(workspaceId: string, tx: Prisma.TransactionClient = this.prisma) {
    const existing = await tx.subscription.findUnique({where: {workspaceId}});
    if (existing) {
      return existing;
    }
    return tx.subscription.create({data: {workspaceId, ...EntitlementsService.newTrial()}});
  }

  effectiveState(sub: Subscription, now = new Date()): EffectiveState {
    const periodOver = sub.currentPeriodEnd.getTime() <= now.getTime();
    switch (sub.status) {
      case 'TRIALING':
        return periodOver ? 'expired' : 'trialing';
      case 'ACTIVE': {
        if (!periodOver) {
          return 'active';
        }
        const graceEnd = sub.currentPeriodEnd.getTime() + GRACE_DAYS * DAY_MS;
        return now.getTime() < graceEnd ? 'grace' : 'expired';
      }
      case 'PAST_DUE':
        return sub.graceEndsAt && sub.graceEndsAt.getTime() > now.getTime() ? 'grace' : 'expired';
      case 'CANCELLED':
        return periodOver ? 'expired' : 'active';
      default:
        return 'expired';
    }
  }

  async usage(workspaceId: string, sub?: Subscription) {
    const subscription = sub || (await this.subscription(workspaceId));
    const window = {gte: subscription.currentPeriodStart, lt: subscription.currentPeriodEnd};
    const [channels, scheduledPosts, ai] = await Promise.all([
      this.prisma.socialAccount.count({where: {workspaceId, status: {not: 'REVOKED'}}}),
      this.prisma.postTarget.count({
        where: {
          post: {workspaceId},
          status: {in: [...COUNTED_TARGET_STATUSES]},
          scheduledAt: window,
        },
      }),
      this.prisma.aiGeneration.aggregate({
        where: {workspaceId, error: null, createdAt: window},
        _sum: {credits: true},
      }),
    ]);
    return {channels, scheduledPosts, aiCredits: ai._sum.credits || 0};
  }

  async snapshot(workspaceId: string) {
    const subscription = await this.subscription(workspaceId);
    const plan = PLANS[subscription.plan];
    return {
      subscription,
      plan,
      state: this.effectiveState(subscription),
      usage: await this.usage(workspaceId, subscription),
    };
  }

  async assertActive(workspaceId: string) {
    const sub = await this.subscription(workspaceId);
    const state = this.effectiveState(sub);
    if (state === 'expired') {
      throw new PlanLimitException(
        'SUBSCRIPTION_INACTIVE',
        sub.status === 'TRIALING'
          ? 'Your trial has ended. Choose a plan to keep scheduling and generating content.'
          : 'Your subscription is not active. Update billing to continue.',
      );
    }
    return sub;
  }

  async assertCanConnectChannels(workspaceId: string, adding: number) {
    const sub = await this.assertActive(workspaceId);
    const {channels} = await this.usage(workspaceId, sub);
    const limit = PLANS[sub.plan].limits.channels;
    if (channels + adding > limit) {
      throw new PlanLimitException(
        'CHANNEL_LIMIT',
        `Your ${PLANS[sub.plan].name} plan allows ${limit} channels (${channels} connected).`,
      );
    }
  }

  /** `adding` counts targets whose scheduledAt falls inside the current period. */
  async assertCanSchedule(workspaceId: string, adding: number) {
    const sub = await this.assertActive(workspaceId);
    const {scheduledPosts} = await this.usage(workspaceId, sub);
    const limit = PLANS[sub.plan].limits.scheduledPostsPerPeriod;
    if (scheduledPosts + adding > limit) {
      throw new PlanLimitException(
        'POST_LIMIT',
        `Your ${PLANS[sub.plan].name} plan allows ${limit} scheduled posts per billing period (${scheduledPosts} used).`,
      );
    }
  }

  async assertAiCredits(workspaceId: string, credits: number) {
    const sub = await this.assertActive(workspaceId);
    const {aiCredits} = await this.usage(workspaceId, sub);
    const limit = PLANS[sub.plan].limits.aiCreditsPerPeriod;
    if (aiCredits + credits > limit) {
      throw new PlanLimitException(
        'AI_CREDIT_LIMIT',
        `Your ${PLANS[sub.plan].name} plan includes ${limit} AI credits per billing period (${aiCredits} used).`,
      );
    }
  }

  /** A user may own one workspace, or as many as their best Agency subscription allows. */
  async assertCanCreateWorkspace(userId: string) {
    const owned = await this.prisma.workspace.findMany({
      where: {ownerId: userId, state: 'active'},
      include: {subscription: true},
    });
    if (owned.length === 0) {
      return;
    }
    const allowance = Math.max(
      ...owned.map(w =>
        w.subscription && this.effectiveState(w.subscription) !== 'expired'
          ? PLANS[w.subscription.plan].limits.workspaces
          : 1,
      ),
    );
    if (owned.length >= allowance) {
      throw new PlanLimitException(
        'WORKSPACE_LIMIT',
        'Your plan includes one workspace. Upgrade a workspace to Agency to manage up to 5.',
      );
    }
  }
}
