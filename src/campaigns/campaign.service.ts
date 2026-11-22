import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {Campaign, Prisma, SocialPlatform} from '@prisma/client';
import {randomUUID} from 'crypto';
import {AiProviderRegistry} from '../ai/ai-provider';
import {AiService} from '../ai/ai.service';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {AI_CREDIT_COST, PLANS} from '../billing/plans';
import {addDays, localDate, zonedToUtc} from '../common/timezone';
import {CreativeService} from '../intelligence/creative.service';
import {MediaService} from '../media/media.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PostsService} from '../posts/posts.service';
import {PrismaService} from '../prisma/prisma.service';
import {PLATFORMS, validateForPlatform} from '../social/platforms';
import {WorkspaceContext, CONTENT_WRITERS} from '../workspaces/workspace.guard';
import {BLOCKING_COMPLIANCE} from '../autopilot/disposition';
import {
  CampaignActionDto,
  CreateCampaignDto,
  UpdateCampaignItemDto,
} from './campaign.dto';

export const CAMPAIGN_LEASE_MS = 5 * 60_000;
class CampaignStopped extends Error {}
export const campaignCreditEstimate = (days: number, mode: string) =>
  days *
  (AI_CREDIT_COST.captions +
    (mode.startsWith('AI_') ? AI_CREDIT_COST.image : 0));
function dayMedia(mode: string, dayIndex: number) {
  if (mode === 'AI_MIXED') return [2, 5].includes(dayIndex % 7) ? 'AI_VIDEO' : 'AI_IMAGE';
  return mode;
}
type Generated = Awaited<ReturnType<AiService['campaignPost']>>;
const postInclude = {
  targets: {include: {socialAccount: true}},
} satisfies Prisma.PostInclude;

@Injectable()
export class CampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    private readonly providers: AiProviderRegistry,
    private readonly creatives: CreativeService,
    private readonly posts: PostsService,
    private readonly media: MediaService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async options(ctx: WorkspaceContext) {
    const [snapshot, capabilities, members] = await Promise.all([
      this.entitlements.snapshot(ctx.id),
      this.creatives.capabilities(),
      this.prisma.workspaceMember.findMany({
        where: {workspaceId: ctx.id, inviteStatus: 'ACTIVE', role: {in: CONTENT_WRITERS}},
        select: {id: true, user: {select: {name: true}}},
        orderBy: [{user: {name: 'asc'}}, {id: 'asc'}],
      }),
    ]);
    let aiConfigured = true;
    try {
      this.providers.get();
    } catch {
      aiConfigured = false;
    }
    return {
      aiConfigured,
      weeklyMediaMix: Array.from({length: 7}, (_, i) => dayMedia('AI_MIXED', i)),
      creators: members.map(member => ({id: member.id, name: member.user.name})),
      ...capabilities,
      credits: {
        used: snapshot.usage.aiCredits,
        limit: PLANS[snapshot.subscription.plan].limits.aiCreditsPerPeriod,
      },
      scheduling: {
        used: snapshot.usage.scheduledPosts,
        limit: PLANS[snapshot.subscription.plan].limits.scheduledPostsPerPeriod,
      },
      costs: {
        captionPerDay: AI_CREDIT_COST.captions,
        mediaPerDay: AI_CREDIT_COST.image,
      },
    };
  }

  async create(
    ctx: WorkspaceContext,
    userId: string,
    input: CreateCampaignDto,
  ) {
    if (!input.name.trim())
      throw new BadRequestException('Give this campaign a name.');
    const existing = await this.prisma.campaign.findUnique({
      where: {
        workspaceId_requestId: {
          workspaceId: ctx.id,
          requestId: input.requestId,
        },
      },
    });
    if (existing) return this.get(ctx, existing.id);
    const midnight = new Date(input.startDate + 'T00:00:00Z');
    if (
      Number.isNaN(midnight.getTime()) ||
      midnight.toISOString().slice(0, 10) !== input.startDate
    )
      throw new BadRequestException('Choose a valid starting date.');
    const start = zonedToUtc(input.startDate, input.postTime, ctx.timezone);
    const last = zonedToUtc(
      addDays(input.startDate, input.days - 1),
      input.postTime,
      ctx.timezone,
    );
    if (
      start.getTime() < Date.now() + 60_000 ||
      last.getTime() > Date.now() + 366 * 86_400_000
    )
      throw new BadRequestException(
        'Start at least one minute in the future and keep the campaign within one year.',
      );
    this.providers.get();
    const accounts = await this.prisma.socialAccount.findMany({
      where: {
        workspaceId: ctx.id,
        id: {in: input.accountIds},
        status: 'CONNECTED',
      },
    });
    if (
      accounts.length !== input.accountIds.length ||
      accounts.some(
        (account) =>
          !PLATFORMS[account.platform].available ||
          (account.expiresAt && account.expiresAt <= last),
      )
    )
      throw new BadRequestException(
        'Choose connected, supported accounts with access valid through the campaign. Reconnect expired accounts first.',
      );
    if (input.autoSchedule && !['OWNER', 'ADMIN'].includes(ctx.role))
      throw new ForbiddenException(
        'An owner or admin must enable automatic campaign scheduling.',
      );
    const creators = input.creatorIds || [];
    const eligible = creators.length ? await this.prisma.workspaceMember.findMany({
      where: {workspaceId: ctx.id, id: {in: creators}, inviteStatus: 'ACTIVE', role: {in: CONTENT_WRITERS}},
      select: {id: true, userId: true},
    }) : [];
    if (creators.length > input.days) throw new BadRequestException('Choose at most one creator per campaign day.');
    if (eligible.length !== creators.length)
        throw new BadRequestException('Choose current creators from this workspace.');
    const selectedMedia =
      input.mediaMode === 'UPLOAD' ? input.mediaIds || [] : [];
    const media = selectedMedia.length
      ? await this.media.findMany(ctx.id, selectedMedia)
      : [];
    if (
      input.mediaMode === 'UPLOAD' &&
      (!media.length ||
        media.length !== selectedMedia.length ||
        media.some((item) => item.deletedAt))
    )
      throw new BadRequestException(
        'Choose available images or videos from this workspace.',
      );
    if (
      input.mediaMode === 'TEXT' &&
      accounts.some((account) => PLATFORMS[account.platform].requiresMedia)
    )
      throw new BadRequestException(
        'Instagram needs an image or video. Choose uploaded media or AI media.',
      );
    for (const asset of media) {
      for (const platform of [
        ...new Set(accounts.map((account) => account.platform)),
      ]) {
        const problems = validateForPlatform(platform, 'Campaign caption', [
          asset,
        ]);
        if (problems.length)
          throw new BadRequestException(
            `${asset.originalName}: ${problems.join(' ')}`,
          );
      }
    }
    if (input.mediaMode.startsWith('AI_')) {
      const capabilities = await this.creatives.capabilities();
      if (!capabilities.imageConfigured)
        throw new BadRequestException(
          'An image generation provider must be configured first.',
        );
      if (
        !capabilities.ffmpeg &&
        (['AI_VIDEO', 'AI_MIXED'].includes(input.mediaMode) ||
          accounts.some((account) => account.platform === 'INSTAGRAM'))
      )
        throw new BadRequestException(
          'FFmpeg must be installed to prepare these AI images or clips for the selected channels. You can use uploaded media instead.',
        );
    }
    await this.entitlements.assertAiCredits(
      ctx.id,
      campaignCreditEstimate(input.days, input.mediaMode),
    );
    if (input.autoSchedule)
      await this.entitlements.assertCanSchedule(
        ctx.id,
        input.days * accounts.length,
      );
    // The unique request key protects against a double click or an HTTP retry.
    const campaign = await this.prisma.campaign.upsert({
      where: {
        workspaceId_requestId: {
          workspaceId: ctx.id,
          requestId: input.requestId,
        },
      },
      update: {},
      create: {
        workspaceId: ctx.id,
        authorId: userId,
        requestId: input.requestId,
        name: input.name.trim(),
        days: input.days,
        startDate: input.startDate,
        postTime: input.postTime,
        timezone: ctx.timezone,
        accountIds: input.accountIds,
        language: input.language,
        goal: input.goal,
        themes: input.themes,
        mediaMode: input.mediaMode,
        mediaIds: selectedMedia,
        autoSchedule: input.autoSchedule,
        items: {
          create: Array.from({length: input.days}, (_, dayIndex) => ({
            dayIndex,
            creatorId: creators.length ? creators[dayIndex % creators.length] : null,
            plannedAt: zonedToUtc(
              addDays(input.startDate, dayIndex),
              input.postTime,
              ctx.timezone,
            ),
          })),
        },
      },
    });
    // Read the saved assignments because a concurrent request may have created this campaign.
    const assignments = await this.prisma.campaignItem.groupBy({
      by: ['creatorId'], where: {campaignId: campaign.id, creatorId: {not: null}}, _count: true,
    });
    await Promise.all(assignments.map(async assignment => {
      const member = eligible.find(person => person.id === assignment.creatorId);
      if (member) await this.notifications.notify({
        workspaceId: ctx.id, userId: member.userId, type: 'campaign_assigned',
        title: 'New campaign assignment',
        body: `${campaign.name} · ${assignment._count} daily posts assigned to you.`,
        meta: {campaignId: campaign.id, creatorId: member.id},
        dedupeKey: `campaign:${campaign.id}:assigned:${member.id}`,
      });
    }));
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'campaign.created',
      entityType: 'campaign',
      entityId: campaign.id,
      metadata: {
        days: campaign.days,
        destinations: accounts.length,
        autoSchedule: campaign.autoSchedule,
      },
    });
    return this.get(ctx, campaign.id);
  }

  private publicConfig(campaign: Campaign) {
    const {leaseToken, leaseUntil, requestId, ...config} = campaign;
    return config;
  }

  async list(ctx: WorkspaceContext) {
    const campaigns = await this.prisma.campaign.findMany({
      where: {workspaceId: ctx.id},
      orderBy: {createdAt: 'desc'},
      take: 50,
      include: {
        items: {select: {status: true, post: {select: {status: true}}}},
      },
    });
    return {
      campaigns: campaigns.map((campaign) => ({
        ...this.publicConfig(campaign),
        progress: {
          total: campaign.days,
          prepared: campaign.items.filter((item) => item.status === 'READY')
            .length,
          failed: campaign.items.filter((item) => item.status === 'FAILED')
            .length,
          skipped: campaign.items.filter((item) => item.status === 'SKIPPED')
            .length,
          scheduled: campaign.items.filter(
            (item) => item.post?.status === 'scheduled',
          ).length,
          published: campaign.items.filter(
            (item) => item.post?.status === 'published',
          ).length,
        },
        items: undefined,
      })),
    };
  }

  async get(ctx: WorkspaceContext, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: {id, workspaceId: ctx.id},
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    const items = await this.prisma.campaignItem.findMany({
      where: {campaignId: id},
      orderBy: {dayIndex: 'asc'},
      include: {post: {include: postInclude}, creator: {select: {id: true, user: {select: {name: true}}}}},
    });
    const serialized = await this.posts.serializeMany(
      items.flatMap((item) => (item.post ? [item.post] : [])),
    );
    const byId = new Map(serialized.map((post) => [post.id, post]));
    return {
      campaign: {
        ...this.publicConfig(campaign),
        items: items.map((item) => ({
          id: item.id,
          dayIndex: item.dayIndex,
          creator: item.creator ? {id: item.creator.id, name: item.creator.user.name} : null,
          mediaMode: dayMedia(campaign.mediaMode, item.dayIndex),
          visualBrief: (item.generatedContent as unknown as Generated | null)?.channels?.[0]?.visualBrief ?? null,
          plannedAt: item.plannedAt,
          status: item.status,
          error: item.error,
          post: item.post ? byId.get(item.post.id) : null,
        })),
      },
    };
  }

  async action(
    ctx: WorkspaceContext,
    userId: string,
    id: string,
    action: CampaignActionDto['action'],
  ) {
    const campaign = await this.prisma.campaign.findFirst({
      where: {id, workspaceId: ctx.id},
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    if (action === 'pause' || action === 'cancel') {
      await this.prisma.campaign.update({
        where: {id},
        data: {
          status: action === 'pause' ? 'PAUSED' : 'CANCELLED',
          leaseToken: null,
          leaseUntil: null,
        },
      });
      // Pause stops generation. Cancel additionally withdraws scheduled targets; published posts stay on their platforms.
      if (action === 'cancel') {
        const posts = await this.prisma.post.findMany({
          where: {
            campaignItem: {campaignId: id},
            targets: {some: {status: 'SCHEDULED'}},
          },
          select: {id: true},
        });
        for (const post of posts)
          await this.posts.cancelPost(ctx, userId, post.id);
      }
    } else {
      if (campaign.status === 'CANCELLED')
        throw new BadRequestException(
          'This campaign was cancelled. Create a new campaign to continue.',
        );
      if (['QUEUED', 'GENERATING'].includes(campaign.status))
        throw new ConflictException('The campaign is already running.');
      if (action === 'schedule' && !['OWNER', 'ADMIN'].includes(ctx.role))
        throw new ForbiddenException(
          'Only owners and admins can schedule a campaign automatically.',
        );
      await this.prisma.$transaction(async (tx) => {
        await tx.campaignItem.updateMany({
          where: {
            campaignId: id,
            status: {
              in:
                action === 'schedule'
                  ? ['FAILED', 'READY', 'PROCESSING']
                  : ['FAILED', 'PROCESSING'],
            },
          },
          data: {status: 'PENDING', error: null},
        });
        await tx.campaign.update({
          where: {id},
          data: {
            status: 'QUEUED',
            error: null,
            leaseToken: null,
            leaseUntil: null,
            authorId: userId,
            ...(action === 'schedule' ? {autoSchedule: true} : {}),
          },
        });
      });
    }
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: `campaign.${action}`,
      entityType: 'campaign',
      entityId: id,
    });
    return this.get(ctx, id);
  }

  async updateItem(
    ctx: WorkspaceContext,
    userId: string,
    campaignId: string,
    itemId: string,
    input: UpdateCampaignItemDto,
  ) {
    if (!input.skip && !input.plannedAt)
      throw new BadRequestException('Choose a future time or remove this day.');
    await this.prisma.$transaction(async (tx) => {
      const campaigns = await tx.$queryRaw<
        {status: string}[]
      >`SELECT "status" FROM "Campaign" WHERE "id" = ${campaignId} AND "workspaceId" = ${ctx.id} FOR UPDATE`;
      if (!campaigns.length) throw new NotFoundException('Campaign not found');
      if (['QUEUED', 'GENERATING', 'CANCELLED'].includes(campaigns[0].status))
        throw new ConflictException(
          'Pause preparation before changing an unfinished day.',
        );
      const item = await tx.campaignItem.findFirst({
        where: {id: itemId, campaignId},
        include: {post: {select: {id: true}}},
      });
      if (!item) throw new NotFoundException('Campaign day not found');
      if (item.post)
        throw new BadRequestException(
          'Use the post editor to change or delete a prepared post.',
        );
      if (item.status === 'SKIPPED')
        throw new BadRequestException('This day has already been removed.');
      if (input.plannedAt) {
        const time = new Date(input.plannedAt).getTime();
        if (time < Date.now() + 60_000 || time > Date.now() + 366 * 86400_000)
          throw new BadRequestException(
            'Choose a time at least one minute in the future and within one year.',
          );
      }
      await tx.campaignItem.update({
        where: {id: item.id},
        data: input.skip
          ? {status: 'SKIPPED', error: 'Removed by a workspace member.'}
          : {
              plannedAt: new Date(input.plannedAt!),
              status: 'PENDING',
              error: null,
            },
      });
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: input.skip ? 'campaign.day_removed' : 'campaign.day_rescheduled',
      entityType: 'campaign',
      entityId: campaignId,
      metadata: {itemId},
    });
    return this.get(ctx, campaignId);
  }

  /** Database claim, shared by API and standalone workers. A lost process is recoverable after its lease expires. */
  async process(id: string, stopping = () => false) {
    const token = randomUUID();
    const now = new Date();
    const claim = await this.prisma.campaign.updateMany({
      where: {
        id,
        status: {in: ['QUEUED', 'GENERATING']},
        OR: [{leaseUntil: null}, {leaseUntil: {lt: now}}],
      },
      data: {
        status: 'GENERATING',
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + CAMPAIGN_LEASE_MS),
      },
    });
    if (!claim.count) return;
    let leaseLost = false;
    let authority: Pick<
      Campaign,
      'workspaceId' | 'authorId' | 'autoSchedule'
    > | null = null;
    const heartbeat = setInterval(() => {
      void this.prisma.campaign
        .updateMany({
          where: {id, status: 'GENERATING', leaseToken: token},
          data: {leaseUntil: new Date(Date.now() + CAMPAIGN_LEASE_MS)},
        })
        .then(
          (result) => {
            if (!result.count) leaseLost = true;
          },
          () => {
            leaseLost = true;
          },
        );
    }, 30_000);
    const check = async () => {
      if (
        stopping() ||
        leaseLost ||
        !(await this.prisma.campaign.count({
          where: {
            id,
            status: 'GENERATING',
            leaseToken: token,
            leaseUntil: {gt: new Date()},
            workspace: {state: 'active'},
          },
        }))
      )
        throw new CampaignStopped();
      if (
        authority &&
        !(await this.prisma.workspaceMember.count({
          where: {
            workspaceId: authority.workspaceId,
            userId: authority.authorId,
            inviteStatus: 'ACTIVE',
            role: {
              in: authority.autoSchedule ? ['OWNER', 'ADMIN'] : CONTENT_WRITERS,
            },
          },
        }))
      )
        throw new ForbiddenException(
          'The campaign creator no longer has permission. An owner or admin must resume it.',
        );
    };
    try {
      const campaign = await this.prisma.campaign.findUniqueOrThrow({
        where: {id},
        include: {workspace: true},
      });
      authority = campaign;
      const member = await this.prisma.workspaceMember.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: campaign.workspaceId,
            userId: campaign.authorId,
          },
        },
      });
      if (
        campaign.workspace.state !== 'active' ||
        member?.inviteStatus !== 'ACTIVE' ||
        !CONTENT_WRITERS.includes(member.role)
      )
        throw new ForbiddenException(
          'The campaign creator needs an active editor, admin, or owner role.',
        );
      if (campaign.autoSchedule && !['OWNER', 'ADMIN'].includes(member.role))
        throw new ForbiddenException(
          'An owner or admin must resume this automatic campaign.',
        );
      const ctx: WorkspaceContext = {
        id: campaign.workspaceId,
        timezone: campaign.timezone,
        approvalRequired: campaign.workspace.approvalRequired,
        ownerId: campaign.workspace.ownerId,
        role: member.role,
      };
      const items = await this.prisma.campaignItem.findMany({
        where: {campaignId: id},
        orderBy: {dayIndex: 'asc'},
      });
      for (const item of items.filter((item) =>
        ['PENDING', 'PROCESSING'].includes(item.status),
      )) {
        await check();
        await this.prisma.campaignItem.updateMany({
          where: {id: item.id, status: {not: 'SKIPPED'}},
          data: {status: 'PROCESSING', error: null},
        });
        try {
          const previousTitles = items
            .slice(0, item.dayIndex)
            .flatMap((previous) =>
              (
                (previous.generatedContent as unknown as Generated | null)
                  ?.channels || []
              )
                .slice(0, 1)
                .map((channel) => channel.title),
            );
          await this.prepareDay(ctx, campaign, item.id, previousTitles, check);
        } catch (error) {
          if (error instanceof CampaignStopped) throw error;
          await check();
          await this.prisma.campaignItem.updateMany({
            where: {id: item.id, status: {not: 'SKIPPED'}},
            data: {status: 'FAILED', error: campaignError(error)},
          });
        }
        // Reload the persisted titles for the next prompt, including items completed by this worker.
        const fresh = await this.prisma.campaignItem.findUnique({
          where: {id: item.id},
        });
        if (fresh) Object.assign(item, fresh);
      }
      await check();
      const failed = await this.prisma.campaignItem.count({
        where: {campaignId: id, status: 'FAILED'},
      });
      await this.prisma.campaign.updateMany({
        where: {id, leaseToken: token, status: 'GENERATING'},
        data: {
          status: failed ? 'NEEDS_ATTENTION' : 'READY',
          error: failed
            ? `${failed} day(s) need attention. Fix the issue and retry; completed posts are kept.`
            : null,
        },
      });
      await this.notifications.notify({
        workspaceId: ctx.id,
        userId: campaign.authorId,
        type: 'campaign_ready',
        title: failed ? 'Campaign needs attention' : 'Your campaign is ready',
        body: `${campaign.name}: ${campaign.days - failed} days prepared, ${failed} needing attention.`,
        meta: {campaignId: id},
        dedupeKey: `campaign:${id}:${token}`,
      });
    } catch (error) {
      if (!(error instanceof CampaignStopped))
        await this.prisma.campaign.updateMany({
          where: {id, leaseToken: token, status: 'GENERATING'},
          data: {status: 'NEEDS_ATTENTION', error: campaignError(error)},
        });
    } finally {
      clearInterval(heartbeat);
      await this.prisma.campaign.updateMany({
        where: {id, leaseToken: token},
        data: {leaseToken: null, leaseUntil: null},
      });
    }
  }

  private async prepareDay(
    ctx: WorkspaceContext,
    campaign: Campaign,
    itemId: string,
    previousTitles: string[],
    check: () => Promise<void>,
  ) {
    const item = await this.prisma.campaignItem.findUniqueOrThrow({
      where: {id: itemId},
      include: {post: true},
    });
    if (item.status === 'SKIPPED') return;
    if (
      item.post &&
      ['processing', 'scheduled', 'published'].includes(item.post.status)
    ) {
      await this.finishItem(item.id, null);
      return;
    }
    if (
      (item.post?.scheduledAt || item.plannedAt).getTime() <=
      Date.now() + 60_000
    )
      throw new BadRequestException(
        'This day’s posting time has passed. Edit its post and choose a future time.',
      );
    const accounts = await this.prisma.socialAccount.findMany({
      where: {
        id: {in: campaign.accountIds},
        workspaceId: ctx.id,
        status: 'CONNECTED',
      },
    });
    if (accounts.length !== campaign.accountIds.length)
      throw new BadRequestException(
        'A selected social account needs reconnecting.',
      );
    const format = dayMedia(campaign.mediaMode, item.dayIndex);
    let generated = item.generatedContent as unknown as Generated | null;
    let post = item.post;
    if (!post) {
      if (!generated) {
        generated = await this.ai.campaignPost(ctx, campaign.authorId, {
          date: localDate(item.plannedAt, campaign.timezone),
          dayIndex: item.dayIndex,
          days: campaign.days,
          platforms: [...new Set(accounts.map((account) => account.platform))],
          language: campaign.language || undefined,
          goal: campaign.goal,
          themes: campaign.themes,
          format,
          campaignName: campaign.name,
          previousTitles,
        });
        await check();
        await this.prisma.campaignItem.updateMany({
          where: {id: item.id, status: 'PROCESSING'},
          data: {
            generatedContent: generated as unknown as Prisma.InputJsonValue,
          },
        });
      }
      await check();
      const current = await this.prisma.campaignItem.findUniqueOrThrow({
        where: {id: item.id},
      });
      if (current.status === 'SKIPPED') return;
      const created = await this.posts.create(
        ctx,
        campaign.authorId,
        {
          title: generated.channels[0].title,
          caption: generated.channels[0].caption,
          plannedAt: item.plannedAt.toISOString(),
          targets: accounts.map((account) => ({
            socialAccountId: account.id,
            channelText: generated!.channels.find(
              (channel) => channel.platform === account.platform,
            )!.caption,
          })),
        },
        {
          campaignItemId: item.id,
          source: 'campaign',
          aiGenerationId: generated.generationId,
          contentPillar: generated.channels[0].contentPillar,
        },
      );
      post = await this.prisma.post.findUniqueOrThrow({
        where: {id: created.id},
      });
    }
    await check();
    if (['processing', 'scheduled', 'published'].includes(post.status)) {
      await this.finishItem(item.id, null);
      return;
    }
    if (!post.mediaIds.length && campaign.mediaMode !== 'TEXT') {
      if (post.contentVersion !== 1)
        throw new ConflictException(
          'This post was edited and has no media. Attach your chosen image or video before retrying.',
        );
      let mediaIds = item.mediaIds;
      if (!mediaIds.length) {
        if (campaign.mediaMode === 'UPLOAD')
          mediaIds = [
            campaign.mediaIds[item.dayIndex % campaign.mediaIds.length],
          ];
        else {
          if (post.contentVersion !== 1)
            throw new ConflictException(
              'This post was edited. Attach your chosen image or video in the editor before retrying.',
            );
          const creative = await this.creatives.create(ctx, campaign.authorId, {
            kind: format === 'AI_VIDEO' ? 'video' : 'image',
            prompt: `Brand: ${campaign.name}. ${generated?.channels[0].visualBrief || post.title}. Do not include text, prices or unsupported claims.`,
          });
          await check();
          if (format === 'AI_VIDEO' && !creative.video)
            throw new BadRequestException(creative.note);
          mediaIds = [creative.video?.id || creative.image.id];
        }
        await this.prisma.campaignItem.updateMany({
          where: {id: item.id, status: 'PROCESSING'},
          data: {mediaIds},
        });
      }
      await check();
      const [asset] = await this.media.findMany(ctx.id, mediaIds);
      if (!asset || asset.deletedAt)
        throw new BadRequestException(
          'The selected media is no longer available. Attach another file in the post editor.',
        );
      // Never overwrite edits, attachments, or a deletion made while an image was being generated.
      const attached = await this.prisma.post.updateMany({
        where: {
          id: post.id,
          contentVersion: post.contentVersion,
          status: 'draft',
          mediaIds: {isEmpty: true},
        },
        data: {
          mediaIds,
          mediaType: asset.mimeType.startsWith('video/') ? 'video' : 'image',
          contentVersion: {increment: 1},
          approvedVersion: null,
        },
      });
      if (!attached.count)
        throw new ConflictException(
          'This post changed during generation. Review its media before retrying.',
        );
    }
    await check();
    const current = await this.prisma.campaignItem.findUniqueOrThrow({
      where: {id: item.id},
      include: {post: true},
    });
    if (current.status === 'SKIPPED' || !current.post) return;
    post = current.post;
    if (
      post.approvedVersion !== post.contentVersion &&
      post.complianceFlags.some((flag) =>
        BLOCKING_COMPLIANCE.has(flag.split(':')[0]),
      )
    ) {
      await this.finishItem(
        item.id,
        'Review the flagged brand facts in the post editor before scheduling.',
      );
      return;
    }
    if (campaign.autoSchedule) {
      // Re-read workspace policy immediately before scheduling; settings may change during generation.
      const workspace = await this.prisma.workspace.findUniqueOrThrow({
        where: {id: ctx.id},
      });
      const latestCtx = {...ctx, approvalRequired: workspace.approvalRequired};
      if (
        latestCtx.approvalRequired &&
        post.approvedVersion !== post.contentVersion
      ) {
        if (post.status !== 'in_review')
          await this.posts.submit(
            latestCtx,
            campaign.authorId,
            post.id,
            'Daily campaign post prepared for review.',
          );
        await this.finishItem(
          item.id,
          'Awaiting approval. Approve this post, then schedule the campaign.',
        );
        return;
      }
      await check();
      await this.posts.schedule(latestCtx, campaign.authorId, post.id, {
        confirm: true,
        scheduledAt:
          post.scheduledAt?.toISOString() || item.plannedAt.toISOString(),
      });
    }
    await this.finishItem(item.id, null);
  }

  private finishItem(id: string, error: string | null) {
    return this.prisma.campaignItem.updateMany({
      where: {id, status: {not: 'SKIPPED'}},
      data: {status: 'READY', error},
    });
  }
}

export function campaignError(error: unknown) {
  const message =
    error instanceof Error
      ? error.message
      : 'Campaign preparation failed. Please retry.';
  return message.slice(0, 500);
}
