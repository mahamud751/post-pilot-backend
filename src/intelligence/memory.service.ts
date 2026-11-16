import {Injectable} from '@nestjs/common';
import {GrowthGoal} from '@prisma/client';
import {localParts} from '../common/timezone';
import {PrismaService} from '../prisma/prisma.service';
import {
  describeSignals,
  goalMetric,
  pickBestHour,
  rankGroups,
  type GrowthGoalName,
  type MemorySample,
} from './performance';

const GOAL_NAMES: GrowthGoalName[] = ['AWARENESS', 'ENGAGEMENT', 'LEADS', 'SALES'];

export function asGoal(goal: GrowthGoal | string | null | undefined): GrowthGoalName {
  return GOAL_NAMES.includes(goal as GrowthGoalName) ? (goal as GrowthGoalName) : 'ENGAGEMENT';
}

function formatOf(post: {mediaType: string | null; mediaIds: string[]}) {
  const kind = (post.mediaType || '').toLowerCase();
  if (kind.includes('video')) return 'reel';
  if (post.mediaIds.length > 1) return 'carousel';
  if (kind.includes('image') || kind.includes('photo') || post.mediaIds.length > 0) return 'photo';
  return 'text';
}

function hookOf(post: {title: string | null; caption: string}) {
  const line = (post.title || post.caption || '')
    .split('\n')
    .map(part => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 160) : null;
}

@Injectable()
export class MemoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Rebuilds memory from posts this workspace published. Metrics stay null when the platform did not return them. */
  async sync(workspaceId: string, timeZone: string) {
    const targets = await this.prisma.postTarget.findMany({
      where: {status: 'PUBLISHED', publishedAt: {not: null}, post: {workspaceId}},
      include: {
        post: {select: {id: true, title: true, caption: true, contentPillar: true, mediaType: true, mediaIds: true}},
      },
      orderBy: {publishedAt: 'desc'},
      take: 400,
    });
    const postIds = [...new Set(targets.map(target => target.post.id))];
    const saleGroups = postIds.length
      ? await this.prisma.sale.groupBy({
          by: ['postId'],
          where: {workspaceId, postId: {in: postIds}},
          _sum: {amount: true},
          _count: {_all: true},
        })
      : [];
    const salesByPost = new Map(
      saleGroups.flatMap(group => (group.postId ? [[group.postId, {amount: group._sum.amount || 0, count: group._count._all}] as const] : [])),
    );
    const primaryTarget = new Map<string, string>();
    for (const target of targets) {
      if (target.publishedAt) primaryTarget.set(target.post.id, target.id);
    }
    for (const target of targets) {
      if (!target.publishedAt) continue;
      const parts = localParts(target.publishedAt, timeZone);
      const data = {
        workspaceId,
        platform: target.platform,
        contentPillar: target.post.contentPillar,
        format: formatOf(target.post),
        hook: hookOf(target.post),
        publishedAt: target.publishedAt,
        localHour: parts.hour,
        weekday: parts.weekday,
        reach: target.reach,
        impressions: target.impressions,
        engagements: target.engagements,
        clicks: target.clicks,
        saves: target.saves,
        shares: target.shares,
        videoViews: target.videoViews,
        salesAmount: primaryTarget.get(target.post.id) === target.id ? salesByPost.get(target.post.id)?.amount ?? 0 : null,
        salesCount: primaryTarget.get(target.post.id) === target.id ? salesByPost.get(target.post.id)?.count ?? 0 : null,
      };
      await this.prisma.performanceMemory.upsert({
        where: {postTargetId: target.id},
        create: {postTargetId: target.id, ...data},
        update: data,
      });
    }
    return {rows: targets.length};
  }

  async signals(workspaceId: string, timeZone: string, goal: GrowthGoalName) {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const rows = await this.prisma.performanceMemory.findMany({
      where: {workspaceId, publishedAt: {gte: since}},
      orderBy: {publishedAt: 'desc'},
      take: 400,
    });
    const samples: MemorySample[] = rows.map(row => ({
      platform: row.platform,
      contentPillar: row.contentPillar,
      format: row.format,
      localHour: row.localHour,
      reach: row.reach,
      impressions: row.impressions,
      engagements: row.engagements,
      clicks: row.clicks,
      saves: row.saves,
      shares: row.shares,
      videoViews: row.videoViews,
      salesAmount: row.salesAmount,
    }));
    const measuredWithMetric = samples.filter(sample => goalMetric(sample, goal) != null).length;
    const best = pickBestHour(samples, goal);
    const formats = rankGroups(samples, goal, 'format');
    const pillars = rankGroups(samples, goal, 'contentPillar');
    const learnings = await this.prisma.growthExperiment.findMany({
      where: {workspaceId, status: 'COMPLETED', learning: {not: null}},
      orderBy: {updatedAt: 'desc'},
      take: 3,
      select: {hypothesis: true, learning: true},
    });
    return {
      measured: samples.length,
      measuredWithMetric,
      windowDays: 90,
      timeZone,
      goal,
      bestHour: best,
      formats,
      pillars,
      learnings,
      recommendation: describeSignals({measured: samples.length, best, formats, goal}),
    };
  }

  /** Text block for the model. Numbers come only from this workspace's stored metrics. */
  async brief(workspaceId: string, timeZone: string, goal: GrowthGoalName, includeHistory: boolean) {
    if (!includeHistory) {
      return 'Account analysis is turned off for this run. Do not assume which topics, formats or hours have performed well.';
    }
    const signals = await this.signals(workspaceId, timeZone, goal);
    if (signals.measured === 0) {
      return 'OWN ACCOUNT HISTORY: none yet. Do not claim past reach, virality or a best posting time.';
    }
    const lines = [
      `OWN ACCOUNT HISTORY (last ${signals.windowDays} days, ${signals.measured} published posts, goal ${goal}).`,
      'These figures are this brand\'s connected-account metrics. They are not industry benchmarks and not a forecast.',
      signals.bestHour.reason,
    ];
    if (signals.formats.length) {
      lines.push(
        `Formats by ${goal}: ${signals.formats
          .slice(0, 4)
          .map(row => `${row.name} (${row.posts} posts, avg ${row.average.toFixed(3)})`)
          .join('; ')}.`,
      );
    }
    if (signals.pillars.length) {
      lines.push(
        `Content pillars by ${goal}: ${signals.pillars
          .slice(0, 4)
          .map(row => `${row.name} (${row.posts} posts, avg ${row.average.toFixed(3)})`)
          .join('; ')}.`,
      );
    }
    for (const item of signals.learnings) {
      lines.push(`Completed experiment: ${item.hypothesis} — ${item.learning}`);
    }
    lines.push('Prefer patterns that have at least 2 posts. Leave the pattern out when the sample is smaller. Never promise virality or a reach number.');
    return lines.join('\n');
  }
}
