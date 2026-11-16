import {Injectable, Logger} from '@nestjs/common';
import {PostTarget, Prisma} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {PrismaService} from '../prisma/prisma.service';
import {graphRequest} from '../social/meta-graph';
import {PLATFORMS} from '../social/platforms';
import {SocialAccountsService} from '../social/social-accounts.service';
import {ExperimentsService} from '../intelligence/experiments.service';
import {MemoryService} from '../intelligence/memory.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';

const METRICS = ['reach', 'impressions', 'engagements', 'clicks'] as const;
type Metric = (typeof METRICS)[number];
const REFRESH_WINDOW_DAYS = 90;

/** Sums available values; returns null when no target reported the metric (never a fake zero). */
function sumAvailable(targets: Pick<PostTarget, Metric>[], metric: Metric) {
  const values = targets.map(t => t[metric]).filter((v): v is number => v !== null);
  return {value: values.length ? values.reduce((a, b) => a + b, 0) : null, reported: values.length};
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    private readonly audit: AuditService,
    private readonly memory: MemoryService,
    private readonly experiments: ExperimentsService,
  ) {}

  private range(from?: string, to?: string) {
    const end = to ? new Date(to) : new Date();
    const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86_400_000);
    return {start, end};
  }

  private publishedTargets(workspaceId: string, start: Date, end: Date) {
    return this.prisma.postTarget.findMany({
      where: {status: 'PUBLISHED', publishedAt: {gte: start, lt: end}, post: {workspaceId}},
      include: {post: {select: {id: true, title: true, caption: true}}, socialAccount: {select: {name: true}}},
      orderBy: {publishedAt: 'desc'},
    });
  }

  async overview(ctx: WorkspaceContext, from?: string, to?: string) {
    const {start, end} = this.range(from, to);
    const targets = await this.publishedTargets(ctx.id, start, end);
    const statusCounts = await this.prisma.post.groupBy({
      by: ['status'],
      where: {workspaceId: ctx.id},
      _count: true,
    });

    const byPlatform = Object.values(
      targets.reduce<Record<string, {platform: string; label: string; targets: typeof targets}>>((acc, t) => {
        acc[t.platform] ||= {platform: t.platform, label: PLATFORMS[t.platform].label, targets: []};
        acc[t.platform].targets.push(t);
        return acc;
      }, {}),
    ).map(group => ({
      platform: group.platform,
      label: group.label,
      published: group.targets.length,
      metricsSupported: PLATFORMS[group.platform as keyof typeof PLATFORMS].metrics,
      metrics: Object.fromEntries(METRICS.map(m => [m, sumAvailable(group.targets, m)])),
    }));

    const fetched = targets.map(t => t.metricsFetchedAt?.getTime()).filter((v): v is number => Boolean(v));
    const daily = new Map<string, number>();
    for (const t of targets) {
      const day = t.publishedAt!.toISOString().slice(0, 10);
      daily.set(day, (daily.get(day) || 0) + 1);
    }

    return {
      range: {from: start, to: end},
      totals: {
        published: targets.length,
        ...Object.fromEntries(METRICS.map(m => [m, sumAvailable(targets, m)])),
      },
      statusCounts: Object.fromEntries(statusCounts.map(s => [s.status, s._count])),
      byPlatform,
      publishedPerDay: [...daily.entries()].sort().map(([date, count]) => ({date, count})),
      metricsRefreshedAt: fetched.length ? new Date(Math.min(...fetched)) : null,
      posts: targets.slice(0, 50).map(t => ({
        targetId: t.id,
        postId: t.post.id,
        title: t.post.title || t.post.caption.slice(0, 80),
        platform: t.platform,
        account: t.socialAccount?.name || null,
        publishedAt: t.publishedAt,
        remoteUrl: t.remoteUrl,
        metrics: Object.fromEntries(METRICS.map(m => [m, t[m]])),
        metricsFetchedAt: t.metricsFetchedAt,
      })),
    };
  }

  async exportCsv(ctx: WorkspaceContext, from?: string, to?: string) {
    const {start, end} = this.range(from, to);
    const targets = await this.publishedTargets(ctx.id, start, end);
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Prefix formula-like cells so spreadsheets don't execute them.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const header = ['published_at', 'platform', 'account', 'post_title', 'remote_url', ...METRICS, 'metrics_fetched_at'];
    const rows = targets.map(t => [
      t.publishedAt?.toISOString(),
      t.platform,
      t.socialAccount?.name,
      t.post.title || t.post.caption.slice(0, 80),
      t.remoteUrl,
      ...METRICS.map(m => (t[m] === null ? 'unavailable' : t[m])),
      t.metricsFetchedAt?.toISOString() || 'never',
    ]);
    return [header, ...rows].map(r => r.map(escape).join(',')).join('\n');
  }

  /** Pulls Facebook post metrics the Page token is permitted to read; failures stay null. */
  async refresh(ctx: WorkspaceContext, actorId: string) {
    const since = new Date(Date.now() - REFRESH_WINDOW_DAYS * 86_400_000);
    const targets = await this.prisma.postTarget.findMany({
      where: {
        status: 'PUBLISHED',
        platform: 'FACEBOOK',
        remotePostId: {not: null},
        publishedAt: {gte: since},
        post: {workspaceId: ctx.id},
        socialAccount: {status: 'CONNECTED'},
      },
      include: {socialAccount: true},
      take: 200,
    });
    let updated = 0;
    for (const target of targets) {
      const token = this.accounts.accessToken(target.socialAccount!);
      const data: Prisma.PostTargetUpdateInput = {metricsFetchedAt: new Date()};
      try {
        const insights = await graphRequest<{data?: {name: string; values?: {value: number}[]}[]}>(
          'GET',
          `/${encodeURIComponent(target.remotePostId!)}/insights`,
          token,
          {metric: 'post_impressions_unique,post_impressions,post_clicks'},
        );
        const value = (name: string) => insights.data?.find(d => d.name === name)?.values?.[0]?.value ?? null;
        data.reach = value('post_impressions_unique');
        data.impressions = value('post_impressions');
        data.clicks = value('post_clicks');
      } catch (error) {
        this.logger.warn(`Insights unavailable for target ${target.id}: ${error instanceof Error ? error.message : error}`);
      }
      try {
        const post = await graphRequest<{
          shares?: {count?: number};
          comments?: {summary?: {total_count?: number}};
          reactions?: {summary?: {total_count?: number}};
        }>('GET', `/${encodeURIComponent(target.remotePostId!)}`, token, {
          fields: 'shares,comments.summary(true).limit(0),reactions.summary(true).limit(0)',
        });
        data.engagements =
          (post.shares?.count || 0) + (post.comments?.summary?.total_count || 0) + (post.reactions?.summary?.total_count || 0);
      } catch {
        // Leave engagements as they were.
      }
      await this.prisma.postTarget.update({where: {id: target.id}, data});
      updated++;
    }
    const igTargets = await this.prisma.postTarget.findMany({
      where: {
        status: 'PUBLISHED',
        platform: 'INSTAGRAM',
        remotePostId: {not: null},
        publishedAt: {gte: since},
        post: {workspaceId: ctx.id},
        socialAccount: {status: 'CONNECTED'},
      },
      include: {socialAccount: true},
      take: 200,
    });
    for (const target of igTargets) {
      const token = this.accounts.accessToken(target.socialAccount!);
      const data = await this.instagramInsights(token, target.remotePostId!);
      await this.prisma.postTarget.update({where: {id: target.id}, data: {...data, metricsFetchedAt: new Date()}});
      updated++;
    }
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: 'analytics.refreshed',
      entityType: 'workspace',
      entityId: ctx.id,
      metadata: {targets: updated},
    });
    const memory = await this.memory.sync(ctx.id, ctx.timezone);
    const experiments = await this.experiments.evaluate(ctx.id);
    return {refreshed: updated, memory: memory.rows, experiments};
  }

  /** Instagram insights the professional account token is allowed to read. Missing metrics stay unset. */
  private async instagramInsights(token: string, mediaId: string): Promise<Prisma.PostTargetUpdateInput> {
    const sets = ['reach,saved,shares,total_interactions,views', 'reach,saved,total_interactions', 'reach'];
    for (const metric of sets) {
      try {
        const insights = await graphRequest<{data?: {name: string; values?: {value: number}[]}[]}>(
          'GET',
          `/${encodeURIComponent(mediaId)}/insights`,
          token,
          {metric},
        );
        const value = (name: string) => insights.data?.find(item => item.name === name)?.values?.[0]?.value ?? null;
        return {
          reach: value('reach'),
          saves: value('saved'),
          shares: value('shares'),
          engagements: value('total_interactions'),
          videoViews: value('views') ?? value('plays'),
          impressions: value('impressions'),
        };
      } catch (error) {
        this.logger.warn(`Instagram insights unavailable for ${mediaId}: ${error instanceof Error ? error.message : error}`);
      }
    }
    return {};
  }
}
