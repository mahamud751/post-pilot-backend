import {Body, Controller, Get, Param, Patch, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {PlanCode} from '@prisma/client';
import {IsIn, IsOptional, IsString, MaxLength} from 'class-validator';
import {AuditService} from '../audit/audit.service';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {BillingService} from '../billing/billing.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {PAID_PLANS, PLANS, priceFor} from '../billing/plans';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {PrismaService} from '../prisma/prisma.service';
import {PublishQueueService} from '../publishing/publish-queue.service';
import {SuperAdminGuard} from './super-admin.guard';

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

/** Tenant metadata only: no tokens and no post content (PRD section 5). */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, SuperAdminGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementsService,
    private readonly queue: PublishQueueService,
    private readonly audit: AuditService,
  ) {}

  @Get('overview')
  async overview() {
    const dayAgo = new Date(Date.now() - 86_400_000);
    const [users, workspaces, plans, published24h, failed24h, needsAction, queue] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.workspace.count(),
      this.prisma.subscription.groupBy({by: ['plan', 'status'], _count: true}),
      this.prisma.postTarget.count({where: {status: 'PUBLISHED', publishedAt: {gte: dayAgo}}}),
      this.prisma.publishAttempt.count({
        where: {outcome: {in: ['permanent_error', 'auth_error', 'ambiguous', 'transient_error']}, startedAt: {gte: dayAgo}},
      }),
      this.prisma.postTarget.count({where: {status: 'NEEDS_ACTION'}}),
      this.queue.counts().catch(() => null),
    ]);
    const ai = await this.prisma.aiGeneration.aggregate({
      where: {createdAt: {gte: new Date(Date.now() - 30 * 86_400_000)}, error: null},
      _sum: {estimatedCost: true, credits: true},
      _count: true,
    });
    return {
      users,
      workspaces,
      plans,
      publishing: {published24h, failedAttempts24h: failed24h, needsAction},
      queue,
      ai30d: {generations: ai._count, credits: ai._sum.credits || 0, estimatedCostUsd: Number(ai._sum.estimatedCost || 0)},
    };
  }

  @Get('workspaces')
  async workspaces(@Query('q') q?: string) {
    const rows = await this.prisma.workspace.findMany({
      where: q ? {OR: [{name: {contains: q, mode: 'insensitive'}}, {owner: {email: {contains: q, mode: 'insensitive'}}}]} : {},
      include: {
        owner: {select: {email: true, name: true}},
        subscription: true,
        _count: {select: {members: true, posts: true, socialAccounts: true}},
      },
      orderBy: {createdAt: 'desc'},
      take: 100,
    });
    return {
      workspaces: rows.map(w => ({
        id: w.id,
        name: w.name,
        state: w.state,
        owner: w.owner,
        createdAt: w.createdAt,
        plan: w.subscription?.plan,
        subscriptionStatus: w.subscription?.status,
        effectiveState: w.subscription ? this.entitlements.effectiveState(w.subscription) : null,
        periodEnd: w.subscription?.currentPeriodEnd,
        counts: w._count,
      })),
    };
  }

  @Get('invoices')
  async invoices() {
    const invoices = await this.prisma.invoice.findMany({
      orderBy: {issuedAt: 'desc'},
      take: 100,
      include: {workspace: {select: {name: true}}},
    });
    return {invoices};
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
}
