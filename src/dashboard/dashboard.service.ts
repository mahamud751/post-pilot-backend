import {Injectable} from '@nestjs/common';
import {EntitlementsService} from '../billing/entitlements.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PostsService} from '../posts/posts.service';
import {PrismaService} from '../prisma/prisma.service';
import {SocialAccountsService} from '../social/social-accounts.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';

/** Overview screen (PRD section 14): upcoming posts, status mix, channel health, activity. */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly posts: PostsService,
    private readonly accounts: SocialAccountsService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async getDashboard(ctx: WorkspaceContext, userId: string) {
    const now = new Date();
    const weekAhead = new Date(now.getTime() + 7 * 86_400_000);
    const [statusCounts, upcoming, accounts, activity, unread, snapshot, workspace, needsAttention] = await Promise.all([
      this.prisma.post.groupBy({by: ['status'], where: {workspaceId: ctx.id}, _count: true}),
      this.prisma.post.findMany({
        where: {workspaceId: ctx.id, status: 'scheduled', scheduledAt: {gte: now, lt: weekAhead}},
        include: {targets: {include: {socialAccount: true}, orderBy: {createdAt: 'asc'}}},
        orderBy: {scheduledAt: 'asc'},
        take: 8,
      }),
      this.accounts.list(ctx.id),
      this.prisma.auditLog.findMany({
        where: {workspaceId: ctx.id},
        orderBy: {createdAt: 'desc'},
        take: 10,
      }),
      this.notifications.unreadCount(userId),
      this.entitlements.snapshot(ctx.id),
      this.prisma.workspace.findUniqueOrThrow({where: {id: ctx.id}, select: {onboardingStep: true, name: true}}),
      this.prisma.postTarget.count({
        where: {post: {workspaceId: ctx.id}, status: {in: ['NEEDS_ACTION', 'FAILED']}},
      }),
    ]);
    const actorIds = [...new Set(activity.map(a => a.actorId).filter((id): id is string => Boolean(id)))];
    const actors = await this.prisma.user.findMany({where: {id: {in: actorIds}}, select: {id: true, name: true}});
    const names = new Map(actors.map(a => [a.id, a.name]));
    const counts = Object.fromEntries(statusCounts.map(s => [s.status, s._count])) as Record<string, number>;

    return {
      workspace: {name: workspace.name, onboardingStep: workspace.onboardingStep, role: ctx.role, timezone: ctx.timezone},
      statusCounts: counts,
      stats: {
        drafts: counts.draft || 0,
        inReview: counts.in_review || 0,
        scheduled: counts.scheduled || 0,
        published: counts.published || 0,
        needsAttention,
      },
      upcoming: await this.posts.serializeMany(upcoming),
      accounts,
      disconnectedAccounts: accounts.filter(a => a.status !== 'CONNECTED'),
      activity: activity.map(a => ({
        id: a.id,
        action: a.action,
        entityType: a.entityType,
        entityId: a.entityId,
        actor: a.actorId ? names.get(a.actorId) || 'Former member' : 'PostPilot',
        createdAt: a.createdAt,
      })),
      plan: {
        code: snapshot.subscription.plan,
        name: snapshot.plan.name,
        state: snapshot.state,
        periodEnd: snapshot.subscription.currentPeriodEnd,
        usage: snapshot.usage,
        limits: snapshot.plan.limits,
      },
      unreadNotifications: unread,
    };
  }
}
