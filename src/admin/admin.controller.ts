import {BadRequestException, Body, Controller, Get, Logger, NotFoundException, Param, Patch, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {PlanCode, Prisma} from '@prisma/client';
import {IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength} from 'class-validator';
import {AuditService} from '../audit/audit.service';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {BillingService} from '../billing/billing.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {PAID_PLANS, PLANS, priceFor} from '../billing/plans';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {PrismaService} from '../prisma/prisma.service';
import {PublishQueueService} from '../publishing/publish-queue.service';
import {SuperAdminGuard} from './super-admin.guard';

const DAY_MS = 86_400_000;
const FAILED_OUTCOMES = ['permanent_error', 'auth_error', 'ambiguous', 'transient_error', 'precheck_failed'];

class SetPlanDto {
  @IsIn(PAID_PLANS)
  plan: PlanCode;

  @IsIn(['monthly', 'annual'])
  cycle: 'monthly' | 'annual';

  @IsOptional()
  @IsString()
  @MaxLength(80)
  reference?: string;
}

class SetStateDto {
  @IsIn(['active', 'suspended'])
  state: 'active' | 'suspended';

  @IsString()
  @MaxLength(300)
  reason: string;
}

class ExtendTrialDto {
  @IsInt()
  @Min(1)
  @Max(90)
  days: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsBoolean()
  isSuperAdmin?: boolean;

  @IsOptional()
  @IsBoolean()
  verifyEmail?: boolean;
}

class AnnouncementDto {
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title: string;

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  body: string;

  @IsIn(['all', 'owners', 'trialing', 'paid'])
  audience: 'all' | 'owners' | 'trialing' | 'paid';
}

/** Tenant metadata only: no tokens and no post content (PRD section 5). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller('admin')
export class AdminController {
  private readonly logger = new Logger('AdminActions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly queue: PublishQueueService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  async overview() {
    const now = Date.now();
    const dayAgo = new Date(now - DAY_MS);
    const weekAgo = new Date(now - 7 * DAY_MS);
    const monthAgo = new Date(now - 30 * DAY_MS);
    const [users, workspaces, suspended, plans, published24h, failed24h, needsAction, scheduled, queue, signups7d, signups30d, recentUsers, revenue30d, subs, channels] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.workspace.count(),
        this.prisma.workspace.count({where: {state: 'suspended'}}),
        this.prisma.subscription.groupBy({by: ['plan', 'status'], _count: true}),
        this.prisma.postTarget.count({where: {status: 'PUBLISHED', publishedAt: {gte: dayAgo}}}),
        this.prisma.publishAttempt.count({where: {outcome: {in: FAILED_OUTCOMES}, startedAt: {gte: dayAgo}}}),
        this.prisma.postTarget.count({where: {status: 'NEEDS_ACTION'}}),
        this.prisma.postTarget.count({where: {status: 'SCHEDULED'}}),
        this.queue.counts().catch(() => null),
        this.prisma.user.count({where: {createdAt: {gte: weekAgo}}}),
        this.prisma.user.count({where: {createdAt: {gte: monthAgo}}}),
        this.prisma.user.findMany({where: {createdAt: {gte: monthAgo}}, select: {createdAt: true}}),
        this.prisma.invoice.aggregate({where: {status: 'paid', issuedAt: {gte: monthAgo}}, _sum: {amount: true}, _count: true}),
        this.prisma.subscription.findMany({select: {plan: true, status: true, billingCycle: true, currentPeriodEnd: true, graceEndsAt: true, trialEndsAt: true}}),
        this.prisma.socialAccount.groupBy({by: ['status'], _count: true}),
      ]);
    const ai = await this.prisma.aiGeneration.aggregate({
      where: {createdAt: {gte: monthAgo}, error: null},
      _sum: {estimatedCost: true, credits: true},
      _count: true,
    });

    // Monthly recurring revenue from subscriptions that are currently paying (BDT).
    let mrr = 0;
    let paying = 0;
    let trialing = 0;
    let trialsEndingSoon = 0;
    let expired = 0;
    const soon = now + 3 * DAY_MS;
    for (const sub of subs) {
      const state = this.entitlements.effectiveState(sub as never);
      if (state === 'expired') expired++;
      if (sub.status === 'TRIALING' && state === 'trialing') {
        trialing++;
        if (sub.currentPeriodEnd.getTime() <= soon) trialsEndingSoon++;
      }
      if (PAID_PLANS.includes(sub.plan) && (state === 'active' || state === 'grace')) {
        paying++;
        mrr += sub.billingCycle === 'annual' ? priceFor(sub.plan, 'annual') / 12 : PLANS[sub.plan].priceBdt;
      }
    }

    // Signups per day for the last 30 days, oldest first.
    const series: {date: string; count: number}[] = [];
    for (let i = 29; i >= 0; i--) {
      series.push({date: new Date(now - i * DAY_MS).toISOString().slice(0, 10), count: 0});
    }
    const index = new Map(series.map((point, i) => [point.date, i]));
    for (const user of recentUsers) {
      const i = index.get(user.createdAt.toISOString().slice(0, 10));
      if (i !== undefined) series[i].count++;
    }

    const planMix: Record<string, number> = {TRIAL: 0, STARTER: 0, GROWTH: 0, AGENCY: 0};
    for (const row of plans) planMix[row.plan] = (planMix[row.plan] || 0) + row._count;

    return {
      users,
      workspaces,
      suspended,
      plans,
      planMix,
      growth: {signups7d, signups30d, series},
      revenue: {
        mrrBdt: Math.round(mrr),
        paying,
        trialing,
        trialsEndingSoon,
        expired,
        conversionRate: paying + trialing + expired > 0 ? paying / (paying + trialing + expired) : 0,
        collected30dBdt: Math.round((revenue30d._sum.amount || 0) / 100),
        invoices30d: revenue30d._count,
      },
      channels: Object.fromEntries(channels.map(row => [row.status, row._count])),
      publishing: {published24h, failedAttempts24h: failed24h, needsAction, scheduled},
      queue,
      ai30d: {generations: ai._count, credits: ai._sum.credits || 0, estimatedCostUsd: Number(ai._sum.estimatedCost || 0)},
    };
  }

  @Get('workspaces')
  async workspaces(@Query('q') q?: string, @Query('plan') plan?: string, @Query('state') state?: string) {
    const where: Prisma.WorkspaceWhereInput = {};
    if (q) where.OR = [{name: {contains: q, mode: 'insensitive'}}, {owner: {email: {contains: q, mode: 'insensitive'}}}];
    if (plan && (['TRIAL', ...PAID_PLANS] as string[]).includes(plan)) where.subscription = {plan: plan as PlanCode};
    if (state === 'active' || state === 'suspended') where.state = state;
    const rows = await this.prisma.workspace.findMany({
      where,
      include: {
        owner: {select: {email: true, name: true}},
        subscription: true,
        _count: {select: {members: true, posts: true, socialAccounts: true}},
      },
      orderBy: {createdAt: 'desc'},
      take: 200,
    });
    return {
      workspaces: rows.map(w => ({
        id: w.id,
        name: w.name,
        state: w.state,
        owner: w.owner,
        createdAt: w.createdAt,
        businessType: w.businessType,
        plan: w.subscription?.plan,
        billingCycle: w.subscription?.billingCycle,
        subscriptionStatus: w.subscription?.status,
        effectiveState: w.subscription ? this.entitlements.effectiveState(w.subscription) : null,
        periodEnd: w.subscription?.currentPeriodEnd,
        cancelAtPeriodEnd: w.subscription?.cancelAtPeriodEnd ?? false,
        counts: w._count,
      })),
    };
  }

  @Get('workspaces/:id')
  async workspace(@Param('id') id: string) {
    const w = await this.prisma.workspace.findUnique({
      where: {id},
      include: {
        owner: {select: {id: true, email: true, name: true, emailVerifiedAt: true, createdAt: true}},
        subscription: true,
        brand: {select: {name: true}},
        members: {include: {user: {select: {id: true, email: true, name: true}}}, orderBy: {createdAt: 'asc'}},
        socialAccounts: {
          select: {id: true, platform: true, name: true, handle: true, status: true, statusReason: true, expiresAt: true, lastCheckedAt: true, createdAt: true},
        },
        invoices: {orderBy: {issuedAt: 'desc'}, take: 10},
        auditLogs: {orderBy: {createdAt: 'desc'}, take: 25},
        _count: {select: {members: true, posts: true, socialAccounts: true, media: true, campaigns: true, engagementItems: true}},
      },
    });
    if (!w) throw new NotFoundException('Workspace not found');
    const [usage, targets, actors] = await Promise.all([
      w.subscription ? this.entitlements.usage(id, w.subscription).catch(() => null) : null,
      this.prisma.postTarget.groupBy({by: ['status'], where: {post: {workspaceId: id}}, _count: true}),
      this.actorNames(w.auditLogs.map(log => log.actorId)),
    ]);
    return {
      id: w.id,
      name: w.name,
      state: w.state,
      timezone: w.timezone,
      businessType: w.businessType,
      onboardingStep: w.onboardingStep,
      approvalRequired: w.approvalRequired,
      createdAt: w.createdAt,
      brandName: w.brand?.name ?? null,
      owner: w.owner,
      subscription: w.subscription
        ? {...w.subscription, effectiveState: this.entitlements.effectiveState(w.subscription), limits: PLANS[w.subscription.plan].limits}
        : null,
      usage,
      members: w.members.map(m => ({id: m.id, role: m.role, inviteStatus: m.inviteStatus, user: m.user, createdAt: m.createdAt})),
      socialAccounts: w.socialAccounts,
      invoices: w.invoices,
      targets: Object.fromEntries(targets.map(row => [row.status, row._count])),
      activity: w.auditLogs.map(log => ({...log, actor: log.actorId ? actors.get(log.actorId) ?? null : null})),
      counts: w._count,
    };
  }

  @Get('users')
  async users(@Query('q') q?: string, @Query('filter') filter?: string) {
    const where: Prisma.UserWhereInput = {};
    if (q) where.OR = [{email: {contains: q, mode: 'insensitive'}}, {name: {contains: q, mode: 'insensitive'}}];
    if (filter === 'admins') where.isSuperAdmin = true;
    if (filter === 'unverified') where.emailVerifiedAt = null;
    const rows = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        isSuperAdmin: true,
        emailVerifiedAt: true,
        googleId: true,
        createdAt: true,
        memberships: {select: {role: true, workspace: {select: {id: true, name: true}}}},
      },
      orderBy: {createdAt: 'desc'},
      take: 200,
    });
    return {
      users: rows.map(({googleId, memberships, ...user}) => ({
        ...user,
        authMethod: googleId ? 'google' : 'password',
        workspaces: memberships.map(m => ({id: m.workspace.id, name: m.workspace.name, role: m.role})),
      })),
    };
  }

  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @CurrentUserId() adminId: string, @Body() input: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({where: {id}});
    if (!user) throw new NotFoundException('User not found');
    if (input.isSuperAdmin === false && id === adminId) {
      throw new BadRequestException('You cannot remove your own administrator access.');
    }
    const data: Prisma.UserUpdateInput = {};
    if (input.isSuperAdmin !== undefined) data.isSuperAdmin = input.isSuperAdmin;
    if (input.verifyEmail && !user.emailVerifiedAt) data.emailVerifiedAt = new Date();
    const updated = await this.prisma.user.update({where: {id}, data, select: {id: true, isSuperAdmin: true, emailVerifiedAt: true}});
    this.logger.log(`admin ${adminId} updated user ${id}: ${JSON.stringify(input)}`);
    return updated;
  }

  @Get('invoices')
  async invoices(@Query('status') status?: string) {
    const invoices = await this.prisma.invoice.findMany({
      where: status ? {status} : {},
      orderBy: {issuedAt: 'desc'},
      take: 200,
      include: {workspace: {select: {name: true}}},
    });
    const totals = await this.prisma.invoice.groupBy({by: ['status'], _sum: {amount: true}, _count: true});
    return {
      invoices,
      totals: Object.fromEntries(totals.map(row => [row.status, {count: row._count, amountBdt: Math.round((row._sum.amount || 0) / 100)}])),
    };
  }

  /** Recent failed publish attempts across all tenants, newest first. Error text is already sanitized. */
  @Get('failures')
  async failures() {
    const attempts = await this.prisma.publishAttempt.findMany({
      where: {outcome: {in: FAILED_OUTCOMES}},
      orderBy: {startedAt: 'desc'},
      take: 100,
      select: {
        id: true,
        attempt: true,
        outcome: true,
        providerCode: true,
        sanitizedError: true,
        startedAt: true,
        target: {
          select: {
            id: true,
            platform: true,
            status: true,
            socialAccount: {select: {name: true}},
            post: {select: {workspace: {select: {id: true, name: true}}}},
          },
        },
      },
    });
    return {
      failures: attempts.map(a => ({
        id: a.id,
        attempt: a.attempt,
        outcome: a.outcome,
        providerCode: a.providerCode,
        error: a.sanitizedError,
        startedAt: a.startedAt,
        platform: a.target.platform,
        targetStatus: a.target.status,
        account: a.target.socialAccount?.name ?? null,
        workspace: a.target.post.workspace,
      })),
    };
  }

  @Get('audit')
  async auditLog(@Query('scope') scope?: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: scope === 'admin' ? {action: {startsWith: 'admin.'}} : {},
      orderBy: {createdAt: 'desc'},
      take: 150,
      include: {workspace: {select: {id: true, name: true}}},
    });
    const actors = await this.actorNames(logs.map(log => log.actorId));
    return {logs: logs.map(log => ({...log, actor: log.actorId ? actors.get(log.actorId) ?? null : null}))};
  }

  /** Manual billing: activates a plan once payment is confirmed outside the app. */
  @Post('workspaces/:id/plan')
  async setPlan(@Param('id') id: string, @CurrentUserId() adminId: string, @Body() input: SetPlanDto) {
    const result = await this.billing.handleEvent('manual', {
      id: `manual-${id}-${Date.now()}`,
      type: 'payment.succeeded',
      data: {
        workspaceId: id,
        plan: input.plan,
        cycle: input.cycle,
        amount: priceFor(input.plan, input.cycle) * 100,
        reference: input.reference,
      },
    });
    await this.audit.record({
      workspaceId: id,
      actorId: adminId,
      action: 'admin.plan_set',
      entityType: 'subscription',
      metadata: {plan: input.plan, cycle: input.cycle, reference: input.reference, planName: PLANS[input.plan].name},
    });
    return result;
  }

  /** Gives a trialing (or lapsed trial) workspace more trial days, counted from now or the current end, whichever is later. */
  @Post('workspaces/:id/extend-trial')
  async extendTrial(@Param('id') id: string, @CurrentUserId() adminId: string, @Body() input: ExtendTrialDto) {
    const sub = await this.entitlements.subscription(id);
    if (sub.plan !== 'TRIAL' && this.entitlements.effectiveState(sub) !== 'expired') {
      throw new BadRequestException('This workspace is on a paid plan. Use “Set plan” instead.');
    }
    const from = Math.max(Date.now(), sub.currentPeriodEnd.getTime());
    const end = new Date(from + input.days * DAY_MS);
    const updated = await this.prisma.subscription.update({
      where: {id: sub.id},
      data: {plan: 'TRIAL', status: 'TRIALING', currentPeriodEnd: end, trialEndsAt: end, graceEndsAt: null},
    });
    await this.audit.record({
      workspaceId: id,
      actorId: adminId,
      action: 'admin.trial_extended',
      entityType: 'subscription',
      entityId: sub.id,
      metadata: {days: input.days, reason: input.reason, newEnd: end.toISOString()},
    });
    return {ok: true, currentPeriodEnd: updated.currentPeriodEnd};
  }

  @Patch('workspaces/:id/state')
  async setState(@Param('id') id: string, @CurrentUserId() adminId: string, @Body() input: SetStateDto) {
    await this.prisma.workspace.update({where: {id}, data: {state: input.state}});
    await this.audit.record({
      workspaceId: id,
      actorId: adminId,
      action: input.state === 'suspended' ? 'admin.workspace_suspended' : 'admin.workspace_restored',
      entityType: 'workspace',
      entityId: id,
      metadata: {reason: input.reason},
    });
    return {ok: true};
  }

  /** Sends an in-app notification to a group of users. Each announcement is delivered once per user. */
  @Post('announcements')
  async announce(@CurrentUserId() adminId: string, @Body() input: AnnouncementDto) {
    let where: Prisma.UserWhereInput = {};
    if (input.audience === 'owners') where = {ownedWorkspaces: {some: {}}};
    if (input.audience === 'trialing') where = {ownedWorkspaces: {some: {subscription: {status: 'TRIALING'}}}};
    if (input.audience === 'paid') where = {ownedWorkspaces: {some: {subscription: {status: 'ACTIVE', plan: {in: PAID_PLANS}}}}};
    const users = await this.prisma.user.findMany({where, select: {id: true}});
    const key = `announcement:${Date.now()}`;
    const result = await this.prisma.notification.createMany({
      data: users.map(user => ({userId: user.id, type: 'announcement', title: input.title, body: input.body, dedupeKey: key, meta: {audience: input.audience}})),
      skipDuplicates: true,
    });
    this.logger.log(`admin ${adminId} sent announcement "${input.title}" to ${result.count} users (${input.audience})`);
    return {sent: result.count};
  }

  private async actorNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (!unique.length) return new Map<string, {name: string; email: string}>();
    const users = await this.prisma.user.findMany({where: {id: {in: unique}}, select: {id: true, name: true, email: true}});
    return new Map(users.map(user => [user.id, {name: user.name, email: user.email}]));
  }
}
