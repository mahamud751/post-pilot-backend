import {BadRequestException, Injectable, NotFoundException, ServiceUnavailableException} from '@nestjs/common';
import {Prisma, SocialPlatform} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {AI_CREDIT_COST, PLANS} from '../billing/plans';
import {BrandFacts, BrandService} from '../brand/brand.service';
import {addDays, localDate, zonedToUtc} from '../common/timezone';
import {hourToTime} from '../intelligence/performance';
import {MemoryService} from '../intelligence/memory.service';
import {ResearchService} from '../intelligence/research.service';
import {PostsService} from '../posts/posts.service';
import {PrismaService} from '../prisma/prisma.service';
import {PLATFORMS} from '../social/platforms';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {AiProviderRegistry, AiResult, estimateCostUsd, JsonSchema} from './ai-provider';
import {checkCompliance} from './compliance';
import {CaptionRequestDto, ContentPlanRequestDto, RegenerateDto} from './ai.dto';

export type CaptionOption = {
  headline: string;
  caption: string;
  hashtags: string[];
  cta: string;
  contentPillar: string;
  visualIdea: string;
  complianceFlags: {code: string; message: string; excerpt: string}[];
};

const STR = {type: 'STRING'};
const STR_ARRAY = {type: 'ARRAY', items: STR};

const CAPTION_ITEM: JsonSchema = {
  type: 'OBJECT',
  properties: {
    headline: STR,
    caption: STR,
    hashtags: STR_ARRAY,
    cta: STR,
    contentPillar: STR,
    visualIdea: STR,
    complianceFlags: STR_ARRAY,
  },
  required: ['headline', 'caption', 'hashtags', 'cta', 'contentPillar', 'visualIdea', 'complianceFlags'],
};

const CAPTIONS_SCHEMA: JsonSchema = {
  type: 'OBJECT',
  properties: {options: {type: 'ARRAY', items: CAPTION_ITEM}},
  required: ['options'],
};

const PLAN_SCHEMA: JsonSchema = {
  type: 'OBJECT',
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          dayOffset: {type: 'INTEGER'},
          platform: STR,
          contentPillar: STR,
          postIdea: STR,
          caption: STR,
          hashtags: STR_ARRAY,
          cta: STR,
          visualBrief: STR,
        },
        required: ['dayOffset', 'platform', 'contentPillar', 'postIdea', 'caption', 'hashtags', 'cta', 'visualBrief'],
      },
    },
  },
  required: ['items'],
};

const LANGUAGE_RULES: Record<string, string> = {
  en: 'Write in natural English.',
  bn: 'Write in Bangla (Bengali script). Keep brand and product names as given.',
  mixed: 'Write in the code-mixed Bangla/English style common on Bangladeshi social media (Bangla script with English terms where natural).',
};

const AUTOPILOT_SCHEMA: JsonSchema = {
  type: 'OBJECT',
  properties: {
    hypothesis: STR,
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          dayOffset: {type: 'INTEGER'},
          platform: STR,
          contentPillar: STR,
          hook: STR,
          postIdea: STR,
          caption: STR,
          hashtags: STR_ARRAY,
          cta: STR,
        },
        required: ['dayOffset', 'platform', 'contentPillar', 'hook', 'postIdea', 'caption', 'hashtags', 'cta'],
      },
    },
  },
  required: ['hypothesis', 'items'],
};

const SYSTEM = [
  'You are PostPilot, a social media copywriter for small businesses.',
  'Use ONLY the facts in the BRAND FACTS block. Never invent prices, discounts, promotions, deadlines,',
  'statistics, awards, customer quotes, testimonials or ratings. If a fact is not provided, leave it out.',
  'Never use any phrase listed under doNotSay.',
  'If the request asks for a claim the facts do not support, write the post without it and add a short note',
  'to complianceFlags explaining what was left out. Otherwise return complianceFlags as an empty array.',
  'Hashtags are returned without the # sign and are not repeated inside the caption.',
].join(' ');

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, max: number, each: number) =>
  Array.isArray(v) ? v.map(x => str(x, each)).filter(Boolean).slice(0, max) : [];

@Injectable()
export class AiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: AiProviderRegistry,
    private readonly brand: BrandService,
    private readonly entitlements: EntitlementsService,
    private readonly posts: PostsService,
    private readonly audit: AuditService,
    private readonly memory: MemoryService,
    private readonly research: ResearchService,
  ) {}

  private brandBlock(brand: BrandFacts) {
    // Only brand-kit facts go to the model: no tokens, no customer data (section 12).
    return JSON.stringify(
      {
        name: brand.name,
        description: brand.description,
        audience: brand.audience,
        website: brand.website,
        tone: brand.tone,
        products: brand.products,
        approvedOffers: brand.approvedOffers,
        callsToAction: brand.ctas,
        doNotSay: brand.doNotSay,
        mediaGuidelines: brand.mediaGuidelines,
      },
      null,
      1,
    );
  }

  private platformRules(platform: SocialPlatform) {
    const caps = PLATFORMS[platform];
    const rules = [`Platform: ${caps.label}. Keep the caption under ${Math.min(caps.maxTextLength, 2000)} characters.`];
    if (platform === 'INSTAGRAM') rules.push('Use at most 15 hashtags. A post may be a photo, a carousel, or a Reel.');
    if (platform === 'FACEBOOK') rules.push('Use at most 5 hashtags.');
    return rules.join(' ');
  }

  /** Runs a metered generation; failures are recorded but do not consume credits. */
  private async run(
    ctx: WorkspaceContext,
    userId: string,
    feature: keyof typeof AI_CREDIT_COST,
    request: object,
    prompt: string,
    schema: JsonSchema,
  ): Promise<{result: AiResult; generationId: string}> {
    const credits = AI_CREDIT_COST[feature];
    await this.entitlements.assertAiCredits(ctx.id, credits);
    const provider = this.providers.get();
    try {
      const result = await provider.generateJson(SYSTEM, prompt, schema);
      const generation = await this.prisma.aiGeneration.create({
        data: {
          workspaceId: ctx.id,
          userId,
          feature,
          provider: result.provider,
          model: result.model,
          credits,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          estimatedCost: estimateCostUsd(result.model, result.inputTokens, result.outputTokens),
          request: request as Prisma.InputJsonValue,
          output: result.json as Prisma.InputJsonValue,
        },
      });
      return {result, generationId: generation.id};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.aiGeneration.create({
        data: {
          workspaceId: ctx.id,
          userId,
          feature,
          provider: provider.name,
          model: provider.model,
          credits: 0,
          request: request as Prisma.InputJsonValue,
          error: message.slice(0, 1000),
        },
      });
      throw error;
    }
  }

  private async usage(workspaceId: string) {
    const snapshot = await this.entitlements.snapshot(workspaceId);
    return {used: snapshot.usage.aiCredits, limit: PLANS[snapshot.subscription.plan].limits.aiCreditsPerPeriod};
  }

  private normaliseOption(raw: unknown, brand: BrandFacts): CaptionOption {
    const o = (raw || {}) as Record<string, unknown>;
    const option = {
      headline: str(o.headline, 200),
      caption: str(o.caption, 5000),
      hashtags: strList(o.hashtags, 30, 60).map(h => h.replace(/^#+/, '').replace(/\s+/g, '')),
      cta: str(o.cta, 300),
      contentPillar: str(o.contentPillar, 80),
      visualIdea: str(o.visualIdea, 500),
    };
    const modelNotes = strList(o.complianceFlags, 5, 300).map(note => ({code: 'model_note', message: note, excerpt: ''}));
    const text = [option.headline, option.caption, option.cta].join('\n');
    return {...option, complianceFlags: [...checkCompliance(text, brand), ...modelNotes]};
  }

  /** FR-04: caption options grounded in the brand kit. */
  async captions(ctx: WorkspaceContext, userId: string, input: CaptionRequestDto) {
    const brand = await this.brand.get(ctx.id);
    const count = input.count || 3;
    const prompt = [
      `BRAND FACTS:\n${this.brandBlock(brand)}`,
      this.platformRules(input.platform),
      LANGUAGE_RULES[input.language || brand.languages[0] || 'en'],
      `Tone: ${input.tone || brand.tone}.`,
      input.goal ? `Goal: ${input.goal}.` : '',
      input.product ? `Focus product or service: ${input.product}.` : '',
      `Topic: ${input.topic}`,
      `Return exactly ${count} distinct options.`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const {result, generationId} = await this.run(ctx, userId, 'captions', input, prompt, CAPTIONS_SCHEMA);
    const rawOptions = (result.json as {options?: unknown[]})?.options;
    const options = (Array.isArray(rawOptions) ? rawOptions : [])
      .map(o => this.normaliseOption(o, brand))
      .filter(o => o.caption)
      .slice(0, count);
    if (options.length === 0) {
      throw new ServiceUnavailableException('The AI returned no usable captions. Please try again.');
    }
    await this.prisma.aiGeneration.update({where: {id: generationId}, data: {output: {options} as Prisma.InputJsonValue}});
    return {
      generationId,
      options,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: estimateCostUsd(result.model, result.inputTokens, result.outputTokens),
        model: result.model,
      },
      credits: await this.usage(ctx.id),
    };
  }

  /** FR-04 "regenerate a section": rewrites one field of a previous option. */
  async regenerate(ctx: WorkspaceContext, userId: string, input: RegenerateDto) {
    const previous = await this.prisma.aiGeneration.findFirst({
      where: {id: input.generationId, workspaceId: ctx.id, feature: 'captions'},
    });
    const options = (previous?.output as {options?: CaptionOption[]} | null)?.options;
    const option = options?.[input.optionIndex];
    if (!option) {
      throw new NotFoundException('That caption option was not found');
    }
    const request = previous!.request as unknown as CaptionRequestDto;
    const brand = await this.brand.get(ctx.id);
    const prompt = [
      `BRAND FACTS:\n${this.brandBlock(brand)}`,
      this.platformRules(request.platform),
      LANGUAGE_RULES[request.language || brand.languages[0] || 'en'],
      `Current post:\n${JSON.stringify({headline: option.headline, caption: option.caption, hashtags: option.hashtags, cta: option.cta})}`,
      `Rewrite ONLY the "${input.section}" so it is fresher, keeping everything else identical.`,
      input.instruction ? `Extra instruction: ${input.instruction}` : '',
      'Return one option containing the full post with the rewritten section.',
    ]
      .filter(Boolean)
      .join('\n\n');
    const {result, generationId} = await this.run(ctx, userId, 'captions', {...input, regenerate: true}, prompt, CAPTIONS_SCHEMA);
    const raw = (result.json as {options?: unknown[]})?.options?.[0];
    const fresh = this.normaliseOption(raw, brand);
    const merged = this.normaliseOption({...option, [input.section]: fresh[input.section]}, brand);
    return {generationId, option: merged, credits: await this.usage(ctx.id)};
  }

  /**
   * FR-05: a 7/15/30-day editorial plan saved as drafts for review. Slots repeated by the model
   * (same day and channel) move to the next free day in the period, or are dropped.
   */
  async contentPlan(ctx: WorkspaceContext, userId: string, input: ContentPlanRequestDto) {
    const platforms = [...new Set(input.platforms)];
    for (const p of platforms) {
      if (!PLATFORMS[p].available) {
        throw new BadRequestException(`${PLATFORMS[p].label} is not available yet`);
      }
    }
    const brand = await this.brand.get(ctx.id);
    const startDate = input.startDate || addDays(localDate(new Date(), ctx.timezone), 1);
    const postsPerWeek = input.postsPerWeek || 4;
    const totalPosts = Math.max(1, Math.round((input.days / 7) * postsPerWeek * platforms.length));
    const brief = await this.memory.brief(ctx.id, ctx.timezone, 'ENGAGEMENT', true);
    const research = await this.research.contextBlock(ctx.id);
    const signals = input.postTime ? null : await this.memory.signals(ctx.id, ctx.timezone, 'ENGAGEMENT');
    const time = input.postTime || hourToTime(signals?.bestHour.hour ?? null);
    const prompt = [
      `BRAND FACTS:\n${this.brandBlock(brand)}`,
      brief,
      research,
      LANGUAGE_RULES[input.language || brand.languages[0] || 'en'],
      `Create a ${input.days}-day content plan starting ${startDate} (dayOffset 0 = that day, max ${input.days - 1}).`,
      `Channels: ${platforms.map(p => p).join(', ')} (use these exact values for "platform").`,
      platforms.map(p => this.platformRules(p)).join('\n'),
      `About ${totalPosts} posts in total, spread evenly; at most one post per channel per day.`,
      input.goal ? `Goal: ${input.goal}.` : '',
      input.themes ? `Themes to cover: ${input.themes}.` : '',
      'Mix 3-5 content pillars (e.g. product, behind the scenes, education, community). Each item needs a ready-to-edit caption and a short visual brief for the photo or design.',
    ]
      .filter(Boolean)
      .join('\n\n');

    const {result, generationId} = await this.run(ctx, userId, 'content_plan', input, prompt, PLAN_SCHEMA);
    const rawItems = (result.json as {items?: unknown[]})?.items;
    const used = new Set<string>();
    const items: {
      date: string;
      platform: SocialPlatform;
      contentPillar: string;
      postIdea: string;
      caption: string;
      hashtags: string[];
      cta: string;
      visualBrief: string;
    }[] = [];
    for (const raw of Array.isArray(rawItems) ? rawItems : []) {
      const r = (raw || {}) as Record<string, unknown>;
      const platform = String(r.platform || '').toUpperCase() as SocialPlatform;
      if (!platforms.includes(platform)) continue;
      let offset = Math.min(Math.max(Math.round(Number(r.dayOffset) || 0), 0), input.days - 1);
      while (offset < input.days && used.has(`${offset}:${platform}`)) offset++;
      if (offset >= input.days) continue;
      used.add(`${offset}:${platform}`);
      const hashtags = strList(r.hashtags, 15, 60).map(h => h.replace(/^#+/, ''));
      const body = str(r.caption, 5000);
      const cta = str(r.cta, 300);
      if (!body) continue;
      items.push({
        date: addDays(startDate, offset),
        platform,
        contentPillar: str(r.contentPillar, 80),
        postIdea: str(r.postIdea, 300),
        caption: [body, cta && !body.includes(cta) ? cta : '', hashtags.length ? hashtags.map(h => `#${h}`).join(' ') : '']
          .filter(Boolean)
          .join('\n\n'),
        hashtags,
        cta,
        visualBrief: str(r.visualBrief, 500),
      });
    }
    if (items.length === 0) {
      throw new ServiceUnavailableException('The AI returned no usable plan items. Please try again.');
    }
    items.sort((a, b) => a.date.localeCompare(b.date));

    const plan = await this.prisma.contentPlan.create({
      data: {
        workspaceId: ctx.id,
        authorId: userId,
        periodDays: input.days,
        startDate: zonedToUtc(startDate, '00:00', ctx.timezone),
        prompt: input as unknown as Prisma.InputJsonValue,
        items: items as unknown as Prisma.InputJsonValue,
      },
    });
    const postIds = await this.posts.createPlanDrafts(
      ctx,
      userId,
      plan.id,
      generationId,
      items.map(i => ({
        plannedAt: zonedToUtc(i.date, time, ctx.timezone),
        platform: i.platform,
        title: i.postIdea.slice(0, 200) || i.contentPillar,
        caption: i.caption,
        contentPillar: i.contentPillar,
        source: 'content_plan',
      })),
    );
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'ai.content_plan_created',
      entityType: 'content_plan',
      entityId: plan.id,
      metadata: {days: input.days, drafts: postIds.length, generationId},
    });
    return {
      plan: {id: plan.id, periodDays: plan.periodDays, startDate, postTime: time, items: items.map((item, i) => ({...item, postId: postIds[i]}))},
      credits: await this.usage(ctx.id),
    };
  }

  /**
   * Drafts the next autopilot batch. Does not publish. The caller decides draft, review or schedule.
   */
  async generateAutopilot(
    ctx: WorkspaceContext,
    userId: string,
    input: {platforms: SocialPlatform[]; count: number; days: number; goal: string; postTime: string; brief: string},
  ) {
    const brand = await this.brand.get(ctx.id);
    const startDate = addDays(localDate(new Date(), ctx.timezone), 1);
    const prompt = [
      `BRAND FACTS:\n${this.brandBlock(brand)}`,
      input.brief,
      LANGUAGE_RULES[brand.languages[0] || 'en'],
      `Goal: ${input.goal}. Optimise the copy for that goal. Do not promise results.`,
      `Prepare exactly ${input.count} posts for the next ${input.days} days starting ${startDate} (dayOffset 0 = that day).`,
      `Channels: ${input.platforms.join(', ')} (use these exact values for "platform").`,
      input.platforms.map(platform => this.platformRules(platform)).join('\n'),
      'At most one post per channel per day.',
      'Also return one hypothesis: a testable bet about topic, hook or format, based only on the history above and the brand kit.',
      'The hypothesis must not claim a future reach, virality or sales number.',
      'Each item needs a distinct hook, a ready-to-edit caption, hashtags and a call to action.',
      `Intended local publish time is ${input.postTime}. Do not mention that clock time unless it belongs in the caption.`,
    ].join('\n\n');

    const {result, generationId} = await this.run(ctx, userId, 'autopilot', input, prompt, AUTOPILOT_SCHEMA);
    const payload = (result.json || {}) as {hypothesis?: unknown; items?: unknown[]};
    const used = new Set<string>();
    const items: {
      date: string;
      platform: SocialPlatform;
      contentPillar: string;
      hook: string;
      postIdea: string;
      caption: string;
      hashtags: string[];
      cta: string;
    }[] = [];
    for (const raw of Array.isArray(payload.items) ? payload.items : []) {
      const row = (raw || {}) as Record<string, unknown>;
      const platform = String(row.platform || '').toUpperCase() as SocialPlatform;
      if (!input.platforms.includes(platform)) continue;
      let offset = Math.min(Math.max(Math.round(Number(row.dayOffset) || 0), 0), input.days - 1);
      while (offset < input.days && used.has(`${offset}:${platform}`)) offset++;
      if (offset >= input.days) continue;
      used.add(`${offset}:${platform}`);
      const hashtags = strList(row.hashtags, 15, 60).map(tag => tag.replace(/^#+/, ''));
      const body = str(row.caption, 5000);
      const cta = str(row.cta, 300);
      if (!body) continue;
      items.push({
        date: addDays(startDate, offset),
        platform,
        contentPillar: str(row.contentPillar, 80),
        hook: str(row.hook, 180),
        postIdea: str(row.postIdea, 300),
        caption: [body, cta && !body.includes(cta) ? cta : '', hashtags.length ? hashtags.map(tag => `#${tag}`).join(' ') : '']
          .filter(Boolean)
          .join('\n\n'),
        hashtags,
        cta,
      });
    }
    const kept = items.slice(0, input.count);
    if (kept.length === 0) {
      throw new ServiceUnavailableException('The AI returned no usable drafts. Please try again.');
    }
    const hypothesis = str(payload.hypothesis, 500);
    await this.prisma.aiGeneration.update({
      where: {id: generationId},
      data: {output: {hypothesis, items: kept} as Prisma.InputJsonValue},
    });
    return {generationId, hypothesis, items: kept, credits: await this.usage(ctx.id)};
  }

  async feedback(ctx: WorkspaceContext, generationId: string, value: 1 | -1) {
    const updated = await this.prisma.aiGeneration.updateMany({
      where: {id: generationId, workspaceId: ctx.id},
      data: {feedback: value},
    });
    if (updated.count === 0) {
      throw new NotFoundException('Generation not found');
    }
    return {ok: true};
  }

  async history(ctx: WorkspaceContext) {
    const [generations, plans] = await Promise.all([
      this.prisma.aiGeneration.findMany({
        where: {workspaceId: ctx.id},
        orderBy: {createdAt: 'desc'},
        take: 30,
        select: {
          id: true,
          feature: true,
          model: true,
          credits: true,
          inputTokens: true,
          outputTokens: true,
          estimatedCost: true,
          feedback: true,
          error: true,
          createdAt: true,
          request: true,
        },
      }),
      this.prisma.contentPlan.findMany({
        where: {workspaceId: ctx.id},
        orderBy: {createdAt: 'desc'},
        take: 10,
        select: {id: true, periodDays: true, startDate: true, createdAt: true, _count: {select: {posts: true}}},
      }),
    ]);
    return {generations, plans, credits: await this.usage(ctx.id)};
  }
}
