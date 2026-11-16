import {BadRequestException, Injectable} from '@nestjs/common';
import {AutopilotMode, Prisma, SocialPlatform} from '@prisma/client';
import {checkCompliance} from '../ai/compliance';
import {AiService} from '../ai/ai.service';
import {AuditService} from '../audit/audit.service';
import {PLANS} from '../billing/plans';
import {EntitlementsService} from '../billing/entitlements.service';
import {BrandService} from '../brand/brand.service';
import {addDays, localDate, zonedToUtc} from '../common/timezone';
import {ExperimentsService} from '../intelligence/experiments.service';
import {hourToTime} from '../intelligence/performance';
import {asGoal, MemoryService} from '../intelligence/memory.service';
import {CreativeService} from '../intelligence/creative.service';
import {ResearchService} from '../intelligence/research.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PostsService} from '../posts/posts.service';
import {PrismaService} from '../prisma/prisma.service';
import {PLATFORMS} from '../social/platforms';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {BLOCKING_COMPLIANCE, decideDisposition} from './disposition';
import {UpdateAutopilotDto} from './autopilot.dto';

const DEFAULTS = {
  enabled: false,
  mode: 'DRAFT' as AutopilotMode,
  autopublishEnabled: false,
  goal: 'ENGAGEMENT' as const,
  postsPerWeek: 3,
  dailyPostLimit: 2,
  analyzeEnabled: true,
  generateEnabled: true,
  optimizeSchedule: true,
  researchEnabled: true,
  creativesEnabled: false,
};

@Injectable()
export class AutopilotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: MemoryService,
    private readonly experiments: ExperimentsService,
    private readonly research: ResearchService,
    private readonly creatives: CreativeService,
    private readonly ai: AiService,
    private readonly posts: PostsService,
    private readonly brand: BrandService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async getConfig(workspaceId: string) {
    const existing = await this.prisma.autopilotConfig.findUnique({where: {workspaceId}});
    if (existing) return existing;
    return this.prisma.autopilotConfig.create({data: {workspaceId, ...DEFAULTS}});
  }

  async update(ctx: WorkspaceContext, userId: string, input: UpdateAutopilotDto) {
    const before = await this.getConfig(ctx.id);
    const config = await this.prisma.autopilotConfig.update({
      where: {workspaceId: ctx.id},
      data: {...input, ...nextRunPatch(before, input)},
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'autopilot.updated',
      entityType: 'autopilot',
      entityId: config.id,
      metadata: {
        enabled: config.enabled,
        mode: config.mode,
        autopublishEnabled: config.autopublishEnabled,
        goal: config.goal,
        scheduleEnabled: config.scheduleEnabled,
        runEveryDays: config.runEveryDays,
      },
    });
    return {config};
  }

  async overview(ctx: WorkspaceContext) {
    const config = await this.getConfig(ctx.id);
    const [signals, experiments, credits, trends, competitors, sales] = await Promise.all([
      this.memory.signals(ctx.id, ctx.timezone, asGoal(config.goal)),
      this.experiments.list(ctx.id),
      this.credits(ctx.id),
      this.research.listTrends(ctx.id),
      this.research.listCompetitors(ctx.id),
      this.research.listSales(ctx.id),
    ]);
    return {
      config,
      signals,
      experiments,
      trends,
      competitors,
      sales,
      hasConversionKey: Boolean(config.conversionKeyHash),
      credits,
      limits: {
        research: 'Trends come from public news for your niche. Competitor posts are read only for accounts you add, and only when Meta allows that token.',
        sales: 'Recorded orders are used for the sales goal. Until an order is logged, sales follow link clicks.',
        creatives: 'Images come from the image model. A video is a short clip of that image when FFmpeg is installed.',
      },
    };
  }

  async sync(ctx: WorkspaceContext) {
    const config = await this.getConfig(ctx.id);
    const memory = await this.memory.sync(ctx.id, ctx.timezone);
    const experiments = await this.experiments.evaluate(ctx.id);
    const signals = await this.memory.signals(ctx.id, ctx.timezone, asGoal(config.goal));
    return {memory, experiments, signals};
  }

  async cancelExperiment(ctx: WorkspaceContext, experimentId: string) {
    return this.experiments.cancel(ctx.id, experimentId);
  }

  createCreative(ctx: WorkspaceContext, userId: string, input: {prompt: string; kind: 'image' | 'thumbnail' | 'video'; postId?: string}) {
    return this.creatives.create(ctx, userId, input);
  }

  /**
   * One assisted run: read this brand's measured posts, draft the next batch, and stop
   * for a person unless full autopilot is explicitly allowed.
   */
  async run(ctx: WorkspaceContext, userId: string) {
    const config = await this.getConfig(ctx.id);
    if (!config.enabled) {
      throw new BadRequestException('Autopilot is paused. Turn it on before preparing drafts.');
    }
    if (!config.generateEnabled) {
      throw new BadRequestException('Post generation is turned off in autopilot settings.');
    }

    if (config.researchEnabled) {
      await this.research.refreshTrends(ctx.id).catch(() => undefined);
      await this.research.refreshCompetitors(ctx.id).catch(() => undefined);
    }

    await this.memory.sync(ctx.id, ctx.timezone);
    await this.experiments.evaluate(ctx.id);

    const today = localDate(new Date(), ctx.timezone);
    const createdToday = await this.prisma.post.count({
      where: {workspaceId: ctx.id, source: 'autopilot', createdAt: {gte: zonedToUtc(today, '00:00', ctx.timezone)}},
    });
    const room = config.dailyPostLimit - createdToday;
    if (room <= 0) {
      return {stopped: 'daily_limit' as const, created: [], dailyPostLimit: config.dailyPostLimit, credits: await this.credits(ctx.id)};
    }

    const accounts = await this.prisma.socialAccount.findMany({
      where: {workspaceId: ctx.id, status: 'CONNECTED'},
      orderBy: {createdAt: 'asc'},
    });
    const platforms = [...new Set(accounts.map(account => account.platform))].filter(platform => PLATFORMS[platform].available);
    if (platforms.length === 0) {
      throw new BadRequestException('Connect a Facebook Page or Instagram professional account before running autopilot.');
    }

    const count = Math.min(config.postsPerWeek, room, 5);
    const goal = asGoal(config.goal);
    const signals = await this.memory.signals(ctx.id, ctx.timezone, goal);
    const postTime = config.optimizeSchedule ? hourToTime(signals.bestHour.hour) : '10:00';
    const brief = [
      await this.memory.brief(ctx.id, ctx.timezone, goal, config.analyzeEnabled),
      config.researchEnabled ? await this.research.contextBlock(ctx.id) : 'Public trend research is turned off for this run.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const generated = await this.ai.generateAutopilot(ctx, userId, {
      platforms,
      count,
      days: 7,
      goal,
      postTime,
      brief,
    });

    const brand = await this.brand.get(ctx.id);
    const startDate = addDays(today, 1);
    const plan = await this.prisma.contentPlan.create({
      data: {
        workspaceId: ctx.id,
        authorId: userId,
        periodDays: 7,
        startDate: zonedToUtc(startDate, '00:00', ctx.timezone),
        prompt: {source: 'autopilot', goal, postTime, count} as Prisma.InputJsonValue,
        items: generated.items as unknown as Prisma.InputJsonValue,
      },
    });

    const postIds = await this.posts.createPlanDrafts(
      ctx,
      userId,
      plan.id,
      generated.generationId,
      generated.items.map(item => ({
        plannedAt: zonedToUtc(item.date, postTime, ctx.timezone),
        platform: item.platform,
        title: (item.hook || item.postIdea).slice(0, 200),
        caption: item.caption,
        contentPillar: item.contentPillar,
        source: 'autopilot',
      })),
    );

    let experimentId: string | null = null;
    if (postIds.length >= 2 && generated.hypothesis) {
      const experiment = await this.prisma.growthExperiment.create({
        data: {
          workspaceId: ctx.id,
          hypothesis: generated.hypothesis.slice(0, 500),
          goal: config.goal,
          variants: {
            create: postIds.map((postId, index) => ({
              postId,
              label: `Variant ${index + 1}`,
              hook: (generated.items[index]?.hook || generated.items[index]?.postIdea || 'Variant').slice(0, 180),
            })),
          },
        },
      });
      experimentId = experiment.id;
    }

    const created: {
      postId: string;
      platform: SocialPlatform;
      action: string;
      reason?: string;
      detail?: string;
    }[] = [];
    const withMedia = new Set<string>();
    if (config.creativesEnabled) {
      let made = 0;
      for (let index = 0; index < postIds.length && made < 2; index++) {
        const item = generated.items[index];
        if (!PLATFORMS[item.platform].requiresMedia && item.platform !== 'FACEBOOK') continue;
        try {
          await this.creatives.create(ctx, userId, {
            prompt: `${item.hook || item.postIdea}. ${item.caption.slice(0, 280)}`,
            kind: item.platform === 'INSTAGRAM' && made === 0 ? 'video' : 'image',
            postId: postIds[index],
          });
          withMedia.add(postIds[index]);
          made++;
        } catch {
          // A missing image model leaves the caption as a draft.
        }
      }
    }
    for (let index = 0; index < postIds.length; index++) {
      const postId = postIds[index];
      const item = generated.items[index];
      const flags = checkCompliance(item.caption, brand);
      const decision = decideDisposition({
        mode: config.mode,
        autopublishEnabled: config.autopublishEnabled,
        approvalRequired: ctx.approvalRequired,
        blocking: flags.some(flag => BLOCKING_COMPLIANCE.has(flag.code)),
        requiresMedia: PLATFORMS[item.platform].requiresMedia && !withMedia.has(postId),
      });
      if (decision.action === 'draft') {
        created.push({postId, platform: item.platform, action: 'draft', reason: decision.reason});
        continue;
      }
      if (decision.action === 'review') {
        try {
          await this.posts.submit(ctx, userId, postId, 'Prepared by autopilot for review.');
          created.push({postId, platform: item.platform, action: 'review'});
        } catch (error) {
          created.push({postId, platform: item.platform, action: 'draft', detail: messageOf(error)});
        }
        continue;
      }
      try {
        await this.posts.schedule(ctx, userId, postId, {
          confirm: true,
          local: {date: item.date, time: postTime},
        });
        created.push({postId, platform: item.platform, action: 'scheduled'});
      } catch (error) {
        created.push({postId, platform: item.platform, action: 'draft', detail: messageOf(error)});
      }
    }

    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'autopilot.ran',
      entityType: 'content_plan',
      entityId: plan.id,
      metadata: {drafts: created.length, mode: config.mode, experimentId, postTime},
    });
    await this.notifications.notify({
      userId,
      workspaceId: ctx.id,
      type: 'autopilot_ran',
      title: 'Autopilot prepared drafts',
      body: `${created.length} post${created.length === 1 ? '' : 's'} prepared in ${config.mode.toLowerCase()} mode.`,
      meta: {planId: plan.id, experimentId},
      dedupeKey: `autopilot:${plan.id}`,
    });

    return {
      stopped: null,
      planId: plan.id,
      experimentId,
      postTime,
      hypothesis: generated.hypothesis,
      recommendation: signals.recommendation,
      created,
      credits: generated.credits,
    };
  }

  private async credits(workspaceId: string) {
    const snapshot = await this.entitlements.snapshot(workspaceId);
    return {used: snapshot.usage.aiCredits, limit: PLANS[snapshot.subscription.plan].limits.aiCreditsPerPeriod};
  }
}

/** When the hands-free schedule is switched on or its cadence changes, pick the next run time. */
function nextRunPatch(
  before: {scheduleEnabled: boolean; runEveryDays: number; lastAutoRunAt: Date | null},
  input: UpdateAutopilotDto,
): {nextAutoRunAt?: Date | null} {
  const scheduleEnabled = input.scheduleEnabled ?? before.scheduleEnabled;
  if (!scheduleEnabled) return input.scheduleEnabled === false ? {nextAutoRunAt: null} : {};
  const days = input.runEveryDays ?? before.runEveryDays;
  const turnedOn = !before.scheduleEnabled;
  if (!turnedOn && days === before.runEveryDays) return {};
  // First switch-on runs within minutes; afterwards keep the cadence from the last run.
  const base = before.lastAutoRunAt ? before.lastAutoRunAt.getTime() + days * 86_400_000 : Date.now();
  return {nextAutoRunAt: new Date(Math.max(base, Date.now()))};
}

function messageOf(error: unknown) {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as {message?: unknown}).message;
    if (typeof message === 'string') return message.slice(0, 300);
    if (Array.isArray(message)) return message.join(' ').slice(0, 300);
  }
  return 'Could not move this draft forward. It was left as a draft.';
}
