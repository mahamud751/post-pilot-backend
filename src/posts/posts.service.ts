import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {Media, Post, PostTarget, Prisma, SocialAccount, SocialPlatform} from '@prisma/client';
import {randomUUID} from 'crypto';
import {checkCompliance, flagKey} from '../ai/compliance';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {BrandService} from '../brand/brand.service';
import {zonedToUtc} from '../common/timezone';
import {MediaService} from '../media/media.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import {PublishQueueService} from '../publishing/publish-queue.service';
import {PLATFORMS, validateForPlatform} from '../social/platforms';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {
  ApproveDto,
  CreatePostDto,
  ListPostsQuery,
  ScheduleDto,
  TargetInputDto,
  UpdatePostDto,
} from './dto/post.dto';
import {recomputePostStatus} from './post-status';

const MIN_LEAD_MS = 60_000;
const MAX_AHEAD_MS = 366 * 86_400_000;
/** Statuses in which content may still be edited. */
const EDITABLE = new Set(['draft', 'in_review', 'approved', 'scheduled', 'failed', 'needs_action', 'cancelled']);
const REVIEWERS = ['OWNER', 'ADMIN', 'APPROVER'] as const;

type TargetWithAccount = PostTarget & {socialAccount: SocialAccount | null};
type FullPost = Post & {targets: TargetWithAccount[]};

const includeTargets = {
  targets: {include: {socialAccount: true}, orderBy: {createdAt: 'asc'}},
} satisfies Prisma.PostInclude;

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly media: MediaService,
    private readonly brand: BrandService,
    private readonly entitlements: EntitlementsService,
    private readonly queue: PublishQueueService,
  ) {}

  // ---------- serialization ----------

  async serialize(post: FullPost) {
    const media = await this.media.findMany(post.workspaceId, post.mediaIds);
    return this.serializeWith(post, media);
  }

  async serializeMany(posts: FullPost[]) {
    const ids = [...new Set(posts.flatMap(p => p.mediaIds))];
    const all = ids.length ? await this.prisma.media.findMany({where: {id: {in: ids}}}) : [];
    const byId = new Map(all.map(m => [m.id, m]));
    return posts.map(p =>
      this.serializeWith(
        p,
        p.mediaIds.map(id => byId.get(id)).filter((m): m is Media => Boolean(m)),
      ),
    );
  }

  private serializeWith(post: FullPost, media: Media[]) {
    const items = media.map(m => this.media.serialize(m));
    return {
      id: post.id,
      title: post.title,
      caption: post.caption,
      status: post.status,
      scheduledAt: post.scheduledAt,
      contentVersion: post.contentVersion,
      approvedVersion: post.approvedVersion,
      approved: post.approvedVersion === post.contentVersion,
      approvedAt: post.approvedAt,
      complianceFlags: post.complianceFlags,
      contentPlanId: post.contentPlanId,
      createdBy: post.userId,
      createdAt: post.createdAt,
      updatedAt: post.updatedAt,
      media: items,
      // Compatibility fields for clients that predate media ids and targets.
      mediaUrl: items[0]?.url ?? post.mediaUrl,
      mediaType: items[0]?.mimeType ?? post.mediaType,
      thumbnailUrl: post.thumbnailUrl,
      platforms: [...new Set(post.targets.map(t => t.platform.toLowerCase()))],
      targets: post.targets.map(t => ({
        id: t.id,
        platform: t.platform,
        socialAccountId: t.socialAccountId,
        account: t.socialAccount
          ? {
              id: t.socialAccount.id,
              name: t.socialAccount.name,
              status: t.socialAccount.status,
              pictureUrl: t.socialAccount.pictureUrl,
            }
          : null,
        channelText: t.channelText,
        text: t.channelText ?? post.caption,
        scheduledAt: t.scheduledAt,
        status: t.status,
        remotePostId: t.remotePostId,
        remoteUrl: t.remoteUrl,
        lastError: t.lastError,
        attemptCount: t.attemptCount,
        publishedAt: t.publishedAt,
        metrics: {
          reach: t.reach,
          impressions: t.impressions,
          engagements: t.engagements,
          clicks: t.clicks,
          fetchedAt: t.metricsFetchedAt,
        },
      })),
    };
  }

  // ---------- reads ----------

  private async load(workspaceId: string, id: string): Promise<FullPost> {
    const post = await this.prisma.post.findFirst({where: {id, workspaceId}, include: includeTargets});
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  async get(ctx: WorkspaceContext, id: string) {
    const post = await this.load(ctx.id, id);
    const reviews = await this.prisma.postReview.findMany({
      where: {postId: id},
      orderBy: {createdAt: 'asc'},
    });
    const actorIds = [...new Set(reviews.map(r => r.actorId))];
    const actors = await this.prisma.user.findMany({
      where: {id: {in: actorIds}},
      select: {id: true, name: true},
    });
    const names = new Map(actors.map(a => [a.id, a.name]));
    return {
      ...(await this.serialize(post)),
      reviews: reviews.map(r => ({...r, actorName: names.get(r.actorId) || 'Former member'})),
    };
  }

  async list(workspaceId: string, query: ListPostsQuery) {
    const take = Math.min(query.take || 50, 100);
    const posts = await this.prisma.post.findMany({
      where: {
        workspaceId,
        ...(query.status ? {status: query.status} : {}),
        ...(query.from || query.to
          ? {
              scheduledAt: {
                ...(query.from ? {gte: new Date(query.from)} : {}),
                ...(query.to ? {lt: new Date(query.to)} : {}),
              },
            }
          : {}),
      },
      include: includeTargets,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
      take: take + 1,
      ...(query.cursor ? {cursor: {id: query.cursor}, skip: 1} : {}),
    });
    return {
      posts: await this.serializeMany(posts.slice(0, take)),
      nextCursor: posts.length > take ? posts[take - 1].id : null,
    };
  }

  /** Calendar data (FR-08): everything with a planned or scheduled time in [from, to). */
  async calendar(ctx: WorkspaceContext, from: string, to: string) {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw new BadRequestException('from and to must be ISO dates with from < to');
    }
    if (end.getTime() - start.getTime() > 62 * 86_400_000) {
      throw new BadRequestException('The calendar range is limited to 62 days');
    }
    const posts = await this.prisma.post.findMany({
      where: {workspaceId: ctx.id, scheduledAt: {gte: start, lt: end}},
      include: includeTargets,
      orderBy: {scheduledAt: 'asc'},
    });
    return {timezone: ctx.timezone, posts: await this.serializeMany(posts)};
  }

  // ---------- writes ----------

  private async resolveTargets(
    workspaceId: string,
    input: {targets?: TargetInputDto[]; platforms?: string[]},
  ) {
    if (input.targets) {
      const ids = [...new Set(input.targets.map(t => t.socialAccountId))];
      const accounts = await this.prisma.socialAccount.findMany({
        where: {workspaceId, id: {in: ids}, status: {not: 'REVOKED'}},
      });
      if (accounts.length !== ids.length) {
        throw new BadRequestException('One or more selected accounts are not connected to this workspace');
      }
      const byId = new Map(accounts.map(a => [a.id, a]));
      return ids.map(id => ({
        account: byId.get(id)!,
        channelText: input.targets!.find(t => t.socialAccountId === id)?.channelText?.trim() || null,
      }));
    }
    if (input.platforms?.length) {
      // Legacy clients name platforms; map each to the workspace's first connected account.
      const platforms = [...new Set(input.platforms.map(p => p.toUpperCase()))].filter(
        (p): p is SocialPlatform => p in PLATFORMS,
      );
      const accounts = await this.prisma.socialAccount.findMany({
        where: {workspaceId, platform: {in: platforms}, status: {not: 'REVOKED'}},
        orderBy: {createdAt: 'asc'},
      });
      return platforms.map(platform => ({
        platform,
        account: accounts.find(a => a.platform === platform) || null,
        channelText: null,
      }));
    }
    return [];
  }

  private async assertMedia(workspaceId: string, ids: string[]) {
    if (ids.length === 0) {
      return;
    }
    const found = await this.prisma.media.count({where: {workspaceId, id: {in: ids}, deletedAt: null}});
    if (found !== new Set(ids).size) {
      throw new BadRequestException('One or more media items were not found in this workspace');
    }
  }

  private async flagsFor(workspaceId: string, texts: string[]) {
    const brand = await this.brand.get(workspaceId);
    return [...new Set(texts.flatMap(t => checkCompliance(t, brand).map(flagKey)))];
  }

  async create(ctx: WorkspaceContext, userId: string, input: CreatePostDto, extra: Partial<Prisma.PostUncheckedCreateInput> = {}) {
    const mediaIds = [...new Set(input.mediaIds || [])];
    await this.assertMedia(ctx.id, mediaIds);
    const targets = await this.resolveTargets(ctx.id, input);
    const flags = await this.flagsFor(ctx.id, [input.caption, ...targets.map(t => t.channelText || '')]);

    const post = await this.prisma.post.create({
      data: {
        workspaceId: ctx.id,
        userId,
        title: input.title?.trim() || null,
        caption: input.caption,
        mediaIds,
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        thumbnailUrl: input.thumbnailUrl,
        platforms: targets.map(t => (t.account?.platform || ('platform' in t ? t.platform : '')).toLowerCase()),
        status: 'draft',
        scheduledAt: input.plannedAt ? new Date(input.plannedAt) : null,
        complianceFlags: flags,
        targets: {
          create: targets.map(t => ({
            platform: t.account?.platform || ('platform' in t ? (t.platform as SocialPlatform) : 'FACEBOOK'),
            socialAccountId: t.account?.id || null,
            channelText: t.channelText,
            idempotencyKey: randomUUID(),
          })),
        },
        ...extra,
      },
      include: includeTargets,
    });

    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.created',
      entityType: 'post',
      entityId: post.id,
      metadata: {targets: post.targets.map(t => t.platform), flags},
    });
    return this.serialize(post);
  }

  /**
   * Edits a post. Any change to what would be published bumps contentVersion, drops a prior
   * approval and unschedules pending targets (PRD FR-14: materially edited posts return to review).
   */
  async update(ctx: WorkspaceContext, userId: string, id: string, input: UpdatePostDto) {
    const post = await this.load(ctx.id, id);
    if (!EDITABLE.has(post.status) || post.targets.some(t => t.status === 'PROCESSING')) {
      throw new ConflictException('This post is publishing or already published and can no longer be edited');
    }

    if (input.mediaIds) {
      await this.assertMedia(ctx.id, input.mediaIds);
    }
    const nextTargets = input.targets ? await this.resolveTargets(ctx.id, {targets: input.targets}) : null;
    const targetKey = (accountId: string | null | undefined, text: string | null) => `${accountId}|${text || ''}`;
    const targetsChanged =
      nextTargets !== null &&
      nextTargets.map(t => targetKey(t.account?.id, t.channelText)).sort().join() !==
        post.targets.map(t => targetKey(t.socialAccountId, t.channelText)).sort().join();
    const material =
      (input.caption !== undefined && input.caption !== post.caption) ||
      (input.mediaIds !== undefined && input.mediaIds.join() !== post.mediaIds.join()) ||
      targetsChanged;
    const caption = input.caption ?? post.caption;
    const flags = await this.flagsFor(ctx.id, [
      caption,
      ...(nextTargets ? nextTargets.map(t => t.channelText || '') : post.targets.map(t => t.channelText || '')),
    ]);

    const unscheduled: {id: string; jobToken: string | null}[] = [];
    await this.prisma.$transaction(async tx => {
      if (nextTargets && targetsChanged) {
        const keep = new Set(nextTargets.map(t => t.account!.id));
        const removable = post.targets.filter(
          t => !t.socialAccountId || !keep.has(t.socialAccountId),
        );
        if (removable.some(t => t.status === 'PUBLISHED')) {
          throw new ConflictException('A channel that already published cannot be removed');
        }
        await tx.postTarget.deleteMany({where: {id: {in: removable.map(t => t.id)}}});
        unscheduled.push(...removable.filter(t => t.status === 'SCHEDULED'));
        for (const t of nextTargets) {
          const existing = post.targets.find(x => x.socialAccountId === t.account!.id);
          if (existing) {
            await tx.postTarget.update({where: {id: existing.id}, data: {channelText: t.channelText}});
          } else {
            await tx.postTarget.create({
              data: {
                postId: post.id,
                socialAccountId: t.account!.id,
                platform: t.account!.platform,
                channelText: t.channelText,
                idempotencyKey: randomUUID(),
              },
            });
          }
        }
      }

      let status = post.status;
      if (material) {
        const scheduled = post.targets.filter(t => t.status === 'SCHEDULED');
        unscheduled.push(...scheduled);
        await tx.postTarget.updateMany({
          where: {postId: post.id, status: {in: ['SCHEDULED', 'NEEDS_ACTION', 'FAILED', 'CANCELLED']}},
          data: {status: 'PENDING', jobToken: null, scheduledAt: null, lastError: null},
        });
        const wasApproved = post.approvedVersion === post.contentVersion;
        status = ctx.approvalRequired && (wasApproved || post.status === 'in_review') ? 'in_review' : 'draft';
        if (wasApproved || scheduled.length) {
          await tx.postReview.create({
            data: {
              postId: post.id,
              actorId: userId,
              action: 'reopened',
              comment: 'Content changed after approval or scheduling.',
              version: post.contentVersion + 1,
            },
          });
        }
      }

      let scheduledAt: Date | null | undefined;
      if (input.plannedAt !== undefined) {
        scheduledAt = input.plannedAt ? new Date(input.plannedAt) : null;
      }

      await tx.post.update({
        where: {id: post.id},
        data: {
          title: input.title?.trim(),
          caption: input.caption,
          mediaIds: input.mediaIds,
          complianceFlags: flags,
          ...(material ? {contentVersion: {increment: 1}, status} : {}),
          ...(scheduledAt !== undefined ? {scheduledAt} : {}),
          ...(nextTargets ? {platforms: nextTargets.map(t => t.account!.platform.toLowerCase())} : {}),
        },
      });
    });

    for (const t of unscheduled) {
      await this.queue.remove(t.id, t.jobToken);
    }

    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: material ? 'post.edited' : 'post.updated',
      entityType: 'post',
      entityId: post.id,
      metadata: {fields: Object.keys(input), unscheduledTargets: unscheduled.length},
    });

    if (input.scheduledAt && !material) {
      return this.reschedule(ctx, userId, id, input.scheduledAt);
    }
    return this.get(ctx, id);
  }

  async remove(ctx: WorkspaceContext, userId: string, id: string) {
    const post = await this.load(ctx.id, id);
    if (post.targets.some(t => t.status === 'PROCESSING')) {
      throw new ConflictException('This post is publishing right now; try again in a minute');
    }
    for (const t of post.targets.filter(t => t.status === 'SCHEDULED')) {
      await this.queue.remove(t.id, t.jobToken);
    }
    await this.prisma.$transaction(async tx => {
      if (post.campaignItemId) await tx.campaignItem.update({where: {id: post.campaignItemId}, data: {status: 'SKIPPED', error: 'Removed by a workspace member.'}});
      await tx.post.delete({where: {id}});
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.deleted',
      entityType: 'post',
      entityId: id,
      metadata: {status: post.status, published: post.targets.filter(t => t.status === 'PUBLISHED').length},
    });
    return {ok: true};
  }

  // ---------- review (FR-14) ----------

  async submit(ctx: WorkspaceContext, userId: string, id: string, comment?: string) {
    const post = await this.load(ctx.id, id);
    if (!['draft', 'cancelled', 'failed', 'needs_action'].includes(post.status) || post.approvedVersion === post.contentVersion) {
      throw new ConflictException('Only unapproved drafts can be submitted for review');
    }
    await this.prisma.$transaction([
      this.prisma.post.update({where: {id}, data: {status: 'in_review'}}),
      this.prisma.postReview.create({
        data: {postId: id, actorId: userId, action: 'submitted', comment: comment || null, version: post.contentVersion},
      }),
    ]);
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.submitted',
      entityType: 'post',
      entityId: id,
      metadata: {version: post.contentVersion},
    });
    await this.notifications.notifyRoles(ctx.id, [...REVIEWERS], {
      type: 'approval_pending',
      title: 'A post is waiting for approval',
      body: `"${(post.title || post.caption).slice(0, 80)}" was submitted for review.`,
      meta: {postId: id},
      dedupeKey: `review:${id}:${post.contentVersion}`,
      email: true,
    });
    return this.get(ctx, id);
  }

  async approve(ctx: WorkspaceContext, userId: string, id: string, input: ApproveDto) {
    const post = await this.load(ctx.id, id);
    if (input.version !== post.contentVersion) {
      throw new ConflictException('The post changed since you opened it. Review the latest version.');
    }
    if (post.approvedVersion === post.contentVersion) {
      throw new ConflictException('This version is already approved');
    }
    if (!['draft', 'in_review'].includes(post.status)) {
      throw new ConflictException(`A ${post.status.replace('_', ' ')} post cannot be approved`);
    }
    if (post.complianceFlags.length > 0 && !input.acknowledgeFlags) {
      throw new UnprocessableEntityException({
        code: 'COMPLIANCE_FLAGS',
        message: 'Review the compliance flags and confirm the claims are accurate before approving.',
        flags: post.complianceFlags,
      });
    }
    await this.prisma.$transaction([
      this.prisma.post.update({
        where: {id},
        data: {status: 'approved', approvedVersion: post.contentVersion, approvedById: userId, approvedAt: new Date()},
      }),
      this.prisma.postReview.create({
        data: {postId: id, actorId: userId, action: 'approved', comment: input.comment || null, version: post.contentVersion},
      }),
    ]);
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.approved',
      entityType: 'post',
      entityId: id,
      metadata: {version: post.contentVersion, acknowledgedFlags: post.complianceFlags},
    });
    if (post.userId !== userId) {
      await this.notifications.notify({
        userId: post.userId,
        workspaceId: ctx.id,
        type: 'post_approved',
        title: 'Your post was approved',
        body: `"${(post.title || post.caption).slice(0, 80)}" is approved and ready to schedule.`,
        meta: {postId: id},
        dedupeKey: `approved:${id}:${post.contentVersion}`,
      });
    }
    return this.get(ctx, id);
  }

  async reject(ctx: WorkspaceContext, userId: string, id: string, comment: string) {
    const post = await this.load(ctx.id, id);
    if (post.status !== 'in_review') {
      throw new ConflictException('Only posts in review can be rejected');
    }
    await this.prisma.$transaction([
      this.prisma.post.update({where: {id}, data: {status: 'draft'}}),
      this.prisma.postReview.create({
        data: {postId: id, actorId: userId, action: 'rejected', comment, version: post.contentVersion},
      }),
    ]);
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.rejected',
      entityType: 'post',
      entityId: id,
      metadata: {version: post.contentVersion},
    });
    await this.notifications.notify({
      userId: post.userId,
      workspaceId: ctx.id,
      type: 'post_rejected',
      title: 'Changes requested on your post',
      body: comment.slice(0, 300),
      meta: {postId: id},
      dedupeKey: `rejected:${id}:${post.contentVersion}`,
      email: true,
    });
    return this.get(ctx, id);
  }

  async comment(ctx: WorkspaceContext, userId: string, id: string, comment: string) {
    const post = await this.load(ctx.id, id);
    await this.prisma.postReview.create({
      data: {postId: id, actorId: userId, action: 'comment', comment, version: post.contentVersion},
    });
    return this.get(ctx, id);
  }

  // ---------- scheduling (FR-08, section 9) ----------

  private canPublish(ctx: WorkspaceContext) {
    if (['OWNER', 'ADMIN', 'APPROVER'].includes(ctx.role)) {
      return true;
    }
    return ctx.role === 'EDITOR' && !ctx.approvalRequired;
  }

  private resolveTime(ctx: WorkspaceContext, input: Pick<ScheduleDto, 'scheduledAt' | 'local' | 'publishNow'>) {
    const now = Date.now();
    if (input.publishNow) {
      return new Date(now);
    }
    const at = input.local
      ? zonedToUtc(input.local.date, input.local.time, ctx.timezone)
      : input.scheduledAt
        ? new Date(input.scheduledAt)
        : null;
    if (!at || Number.isNaN(at.getTime())) {
      throw new BadRequestException('Choose a time, or publish now');
    }
    if (at.getTime() < now + MIN_LEAD_MS) {
      throw new BadRequestException('The time must be at least 1 minute in the future. Use "Publish now" to post immediately.');
    }
    if (at.getTime() > now + MAX_AHEAD_MS) {
      throw new BadRequestException('Posts can be scheduled up to one year ahead');
    }
    return at;
  }

  /** Every reason the target can't be queued; empty when it can (fail fast, TEST-08). */
  private targetProblems(post: FullPost, target: TargetWithAccount, media: Media[]) {
    const problems: string[] = [];
    const account = target.socialAccount;
    if (!account) {
      problems.push(`No ${PLATFORMS[target.platform].label} account is connected for this channel.`);
      return problems;
    }
    if (account.status !== 'CONNECTED') {
      problems.push(`${account.name} needs to be reconnected before it can publish.`);
    }
    if (account.expiresAt && account.expiresAt.getTime() < Date.now()) {
      problems.push(`${account.name}'s access has expired; reconnect it.`);
    }
    problems.push(
      ...validateForPlatform(
        target.platform,
        target.channelText ?? post.caption,
        media.map(m => ({mimeType: m.mimeType, size: m.size, width: m.width, height: m.height})),
      ),
    );
    if (media.some(m => m.deletedAt)) {
      problems.push('A media item on this post was deleted from the library.');
    }
    return problems.map(p => `${account.name}: ${p}`);
  }

  async schedule(ctx: WorkspaceContext, userId: string, id: string, input: ScheduleDto) {
    if (!this.canPublish(ctx)) {
      throw new ForbiddenException(
        ctx.approvalRequired
          ? 'This workspace requires approval. Submit the post for review instead.'
          : 'Your role cannot schedule posts',
      );
    }
    if (!input.confirm) {
      throw new BadRequestException('Confirm the destinations, preview and time to schedule');
    }
    const post = await this.load(ctx.id, id);
    if (ctx.approvalRequired && post.approvedVersion !== post.contentVersion) {
      throw new ForbiddenException('This post needs approval before it can be scheduled');
    }

    const candidates = post.targets.filter(
      t => ['PENDING', 'CANCELLED', 'FAILED', 'NEEDS_ACTION'].includes(t.status) &&
        (!input.targetIds || input.targetIds.includes(t.id)),
    );
    if (candidates.length === 0) {
      throw new BadRequestException('Choose at least one channel that is not already scheduled or published');
    }
    const runAt = this.resolveTime(ctx, input);
    const media = await this.media.findMany(ctx.id, post.mediaIds);
    const problems = candidates.flatMap(t => this.targetProblems(post, t, media));
    if (problems.length) {
      throw new UnprocessableEntityException({code: 'TARGET_INVALID', message: problems[0], problems});
    }
    await this.entitlements.assertCanSchedule(ctx.id, candidates.length);

    const tokens = candidates.map(t => ({id: t.id, token: randomUUID()}));
    await this.prisma.$transaction(async tx => {
      if (post.campaignItemId) {
        const campaigns = await tx.$queryRaw<{status: string}[]>`SELECT c."status" FROM "Campaign" c JOIN "CampaignItem" i ON i."campaignId" = c."id" WHERE i."id" = ${post.campaignItemId} FOR UPDATE OF c`;
        if (campaigns.some(campaign => ['CANCELLED', 'PAUSED'].includes(campaign.status))) throw new ConflictException('Resume this campaign before scheduling its posts.');
      }
      for (const {id: targetId, token} of tokens) {
        await tx.postTarget.update({
          where: {id: targetId},
          data: {status: 'SCHEDULED', scheduledAt: runAt, jobToken: token, lastError: null, nextAttemptAt: null},
        });
      }
      // Scheduling is the explicit human approval of this exact version (FR-04).
      if (post.approvedVersion !== post.contentVersion) {
        await tx.post.update({
          where: {id},
          data: {approvedVersion: post.contentVersion, approvedById: userId, approvedAt: new Date()},
        });
      }
      await recomputePostStatus(tx, id);
    });
    for (const {id: targetId, token} of tokens) {
      await this.queue.enqueue(targetId, token, runAt);
    }

    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: input.publishNow ? 'post.publish_now' : 'post.scheduled',
      entityType: 'post',
      entityId: id,
      metadata: {scheduledAt: runAt.toISOString(), targets: candidates.map(t => t.platform), version: post.contentVersion},
    });
    return this.get(ctx, id);
  }

  async scheduleTarget(ctx: WorkspaceContext, userId: string, targetId: string, input: ScheduleDto) {
    const target = await this.findTarget(ctx, targetId);
    return this.schedule(ctx, userId, target.postId, {...input, targetIds: [targetId]});
  }

  /** Moves already-scheduled targets to a new time (calendar drag). */
  async reschedule(ctx: WorkspaceContext, userId: string, id: string, scheduledAt: string) {
    if (!this.canPublish(ctx)) {
      throw new ForbiddenException('Your role cannot reschedule posts');
    }
    const post = await this.load(ctx.id, id);
    const scheduled = post.targets.filter(t => t.status === 'SCHEDULED');
    if (scheduled.length === 0) {
      await this.prisma.post.update({where: {id}, data: {scheduledAt: new Date(scheduledAt)}});
      return this.get(ctx, id);
    }
    const runAt = this.resolveTime(ctx, {scheduledAt});
    const tokens = scheduled.map(t => ({id: t.id, old: t.jobToken, token: randomUUID()}));
    await this.prisma.$transaction(async tx => {
      for (const t of tokens) {
        // Guarded on the old token so a target the worker just claimed is left alone.
        const moved = await tx.postTarget.updateMany({
          where: {id: t.id, status: 'SCHEDULED', jobToken: t.old},
          data: {scheduledAt: runAt, jobToken: t.token},
        });
        if (moved.count === 0) {
          throw new ConflictException('This post started publishing and can no longer be moved');
        }
      }
      await recomputePostStatus(tx, id);
    });
    for (const t of tokens) {
      await this.queue.remove(t.id, t.old);
      await this.queue.enqueue(t.id, t.token, runAt);
    }
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.rescheduled',
      entityType: 'post',
      entityId: id,
      metadata: {scheduledAt: runAt.toISOString()},
    });
    return this.get(ctx, id);
  }

  private async findTarget(ctx: WorkspaceContext, targetId: string) {
    const target = await this.prisma.postTarget.findFirst({
      where: {id: targetId, post: {workspaceId: ctx.id}},
      include: {attempts: {orderBy: {attempt: 'desc'}, take: 1}},
    });
    if (!target) {
      throw new NotFoundException('Channel target not found');
    }
    return target;
  }

  /**
   * Cancels a scheduled target. The conditional update and the worker's claim race on the same
   * row, so exactly one wins (PRD section 9, "cancel at scheduled time").
   */
  async cancelTarget(ctx: WorkspaceContext, userId: string, targetId: string) {
    // Editors may cancel even where they cannot schedule: stopping a post is always safe.
    if (!this.canPublish(ctx) && ctx.role !== 'EDITOR') {
      throw new ForbiddenException('Your role cannot cancel posts');
    }
    const target = await this.findTarget(ctx, targetId);
    const result = await this.prisma.$transaction(async tx => {
      const cancelled = await tx.postTarget.updateMany({
        where: {id: targetId, status: {in: ['SCHEDULED', 'PENDING', 'NEEDS_ACTION', 'FAILED']}},
        data: {status: 'CANCELLED', jobToken: null, nextAttemptAt: null},
      });
      if (cancelled.count > 0) {
        await recomputePostStatus(tx, target.postId);
      }
      return cancelled.count;
    });
    if (result === 0) {
      throw new ConflictException(
        target.status === 'PROCESSING'
          ? 'This channel is publishing right now and can no longer be cancelled'
          : `This channel is already ${target.status.toLowerCase().replace('_', ' ')}`,
      );
    }
    await this.queue.remove(targetId, target.jobToken);
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'post.cancelled',
      entityType: 'post_target',
      entityId: targetId,
      metadata: {postId: target.postId, platform: target.platform},
    });
    return this.get(ctx, target.postId);
  }

  async cancelPost(ctx: WorkspaceContext, userId: string, id: string) {
    const post = await this.load(ctx.id, id);
    const open = post.targets.filter(t => ['SCHEDULED', 'PENDING'].includes(t.status));
    if (open.length === 0) {
      throw new ConflictException('Nothing on this post can be cancelled');
    }
    for (const t of open) {
      await this.cancelTarget(ctx, userId, t.id).catch(() => undefined);
    }
    return this.get(ctx, id);
  }

  /** Re-queues a failed target. An ambiguous last attempt requires explicit confirmation (TEST-06). */
  async retryTarget(ctx: WorkspaceContext, userId: string, targetId: string, confirmNotPublished?: boolean) {
    const target = await this.findTarget(ctx, targetId);
    if (!['FAILED', 'NEEDS_ACTION'].includes(target.status)) {
      throw new ConflictException('Only failed channels can be retried');
    }
    const last = target.attempts[0];
    if (last?.outcome === 'ambiguous' && !confirmNotPublished) {
      throw new ConflictException({
        code: 'CONFIRM_NOT_PUBLISHED',
        message:
          'We could not confirm whether the last attempt reached the platform. Check the page first, then confirm it did not publish.',
      });
    }
    return this.schedule(ctx, userId, target.postId, {publishNow: true, confirm: true, targetIds: [targetId]});
  }

  async attempts(ctx: WorkspaceContext, targetId: string) {
    const target = await this.findTarget(ctx, targetId);
    const attempts = await this.prisma.publishAttempt.findMany({
      where: {targetId: target.id},
      orderBy: {attempt: 'desc'},
    });
    return {attempts};
  }

  /** Drafts generated by the content planner (FR-05); never scheduled automatically. */
  async createPlanDrafts(
    ctx: WorkspaceContext,
    userId: string,
    contentPlanId: string,
    aiGenerationId: string,
    items: {plannedAt: Date; platform: SocialPlatform; title: string; caption: string; contentPillar?: string; source?: string}[],
  ) {
    const accounts = await this.prisma.socialAccount.findMany({
      where: {workspaceId: ctx.id, status: {not: 'REVOKED'}},
      orderBy: {createdAt: 'asc'},
    });
    const brand = await this.brand.get(ctx.id);
    const ids: string[] = [];
    for (const item of items) {
      const account = accounts.find(a => a.platform === item.platform) || null;
      const post = await this.prisma.post.create({
        data: {
          workspaceId: ctx.id,
          userId,
          title: item.title,
          caption: item.caption,
          platforms: [item.platform.toLowerCase()],
          status: 'draft',
          scheduledAt: item.plannedAt,
          complianceFlags: checkCompliance(item.caption, brand).map(flagKey),
          contentPlanId,
          aiGenerationId,
          contentPillar: item.contentPillar || null,
          source: item.source || 'content_plan',
          targets: {
            create: {
              platform: item.platform,
              socialAccountId: account?.id || null,
              idempotencyKey: randomUUID(),
            },
          },
        },
      });
      ids.push(post.id);
    }
    return ids;
  }
}
