import {Injectable, Logger} from '@nestjs/common';
import {Prisma, PublishAttempt} from '@prisma/client';
import {randomUUID} from 'crypto';
import {existsSync} from 'fs';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {MediaService} from '../media/media.service';
import {storagePath} from '../media/media-storage';
import {NotificationsService} from '../notifications/notifications.service';
import {recomputePostStatus} from '../posts/post-status';
import {PrismaService} from '../prisma/prisma.service';
import {PlatformError} from '../social/meta-graph';
import {PLATFORMS, validateForPlatform} from '../social/platforms';
import {SocialAccountsService} from '../social/social-accounts.service';
import {PlatformAdapters, PublishContent, PublishOutcome} from './adapters';
import {PublishQueueService} from './publish-queue.service';

export const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
/** Notify when a retry pushes publication this far past the scheduled time. */
const SCHEDULE_SLA_MS = 60 * 60_000;

const loadTarget = (targetId: string) =>
  ({
    where: {id: targetId},
    include: {post: {include: {workspace: true}}, socialAccount: true},
  }) satisfies Prisma.PostTargetFindUniqueArgs;

type LoadedTarget = Prisma.PostTargetGetPayload<ReturnType<typeof loadTarget>>;

export type ProcessResult =
  | 'stale'
  | 'published'
  | 'reconciled'
  | 'retry_scheduled'
  | 'needs_action'
  | 'failed';

@Injectable()
export class PublisherService {
  private readonly logger = new Logger(PublisherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: PlatformAdapters,
    private readonly accounts: SocialAccountsService,
    private readonly media: MediaService,
    private readonly entitlements: EntitlementsService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly queue: PublishQueueService,
  ) {}

  /**
   * Runs one queued job. The conditional claim on (status, jobToken) is the lock: a cancelled,
   * rescheduled, already-claimed or redelivered job matches nothing and does nothing (TEST-03).
   */
  async process(targetId: string, jobToken: string): Promise<ProcessResult> {
    const claimed = await this.prisma.postTarget.updateMany({
      where: {id: targetId, status: 'SCHEDULED', jobToken},
      data: {status: 'PROCESSING', attemptCount: {increment: 1}, nextAttemptAt: null},
    });
    if (claimed.count === 0) {
      return 'stale';
    }
    const target = await this.prisma.postTarget.findUniqueOrThrow(loadTarget(targetId));
    await this.prisma.$transaction(tx => recomputePostStatus(tx, target.postId));

    const precheck = await this.precheck(target);
    if (precheck) {
      const attempt = await this.startAttempt(target);
      await this.finishAttempt(attempt, 'precheck_failed', null, precheck);
      return this.needsAction(target, precheck);
    }

    const content = await this.content(target);
    const adapter = this.adapters.get(target.platform)!;
    const account = target.socialAccount!;
    const token = this.accounts.accessToken(account);
    const attempt = await this.startAttempt(target);

    try {
      const outcome = await adapter.publish(account, token, content, {
        onContainer: async containerId => {
          await this.prisma.publishAttempt.update({where: {id: attempt.id}, data: {containerId}});
          attempt.containerId = containerId;
        },
      });
      await this.finishAttempt(attempt, 'success', null, null, outcome.remotePostId);
      return this.published(target, outcome, false);
    } catch (error) {
      const err =
        error instanceof PlatformError
          ? error
          : new PlatformError(error instanceof Error ? error.message : String(error), 'ambiguous', 'internal');
      return this.handleFailure(target, attempt, err, content);
    }
  }

  /** Returns a reason the target must not publish, or null. Re-checked at execution (section 9, step 4). */
  private async precheck(target: LoadedTarget): Promise<string | null> {
    const {post} = target;
    if (post.approvedVersion !== post.contentVersion) {
      return 'The post changed after it was scheduled and needs to be approved again.';
    }
    const sub = await this.entitlements.subscription(post.workspaceId);
    if (this.entitlements.effectiveState(sub) === 'expired') {
      return 'The workspace subscription is not active.';
    }
    const account = target.socialAccount;
    if (!account || account.status !== 'CONNECTED') {
      return 'The social account is disconnected or needs to be reconnected.';
    }
    if (!this.adapters.get(target.platform) || !PLATFORMS[target.platform].available) {
      return `${PLATFORMS[target.platform].label} publishing is not available.`;
    }
    const media = await this.media.findMany(post.workspaceId, post.mediaIds);
    if (media.length !== post.mediaIds.length || media.some(m => m.deletedAt)) {
      return 'A media item on this post is no longer available.';
    }
    if (media.some(m => (m.storageKey?.includes('/') ? !existsSync(storagePath(m.storageKey)) : false))) {
      return 'A media file is missing from storage.';
    }
    const problems = validateForPlatform(
      target.platform,
      target.channelText ?? post.caption,
      media.map(m => ({mimeType: m.mimeType, size: m.size, width: m.width, height: m.height})),
    );
    return problems[0] || null;
  }

  private async content(target: LoadedTarget): Promise<PublishContent> {
    const media = await this.media.findMany(target.post.workspaceId, target.post.mediaIds);
    return {
      text: target.channelText ?? target.post.caption,
      // Long enough for Meta to fetch the file, short enough not to linger.
      media: media.map(m => ({url: this.media.urlFor(m, 6 * 3600), mimeType: m.mimeType})),
    };
  }

  private startAttempt(target: LoadedTarget) {
    return this.prisma.publishAttempt.create({
      data: {targetId: target.id, attempt: target.attemptCount},
    });
  }

  private finishAttempt(
    attempt: PublishAttempt,
    outcome: string,
    providerCode: string | null,
    error: string | null,
    remotePostId?: string,
  ) {
    return this.prisma.publishAttempt.update({
      where: {id: attempt.id},
      data: {
        outcome,
        providerCode,
        // Provider messages can echo request parameters; strip anything token-like.
        sanitizedError: error ? error.replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]').slice(0, 1000) : null,
        remotePostId: remotePostId ?? null,
        completedAt: new Date(),
      },
    });
  }

  private async handleFailure(
    target: LoadedTarget,
    attempt: PublishAttempt,
    error: PlatformError,
    content: PublishContent,
  ): Promise<ProcessResult> {
    if (error.kind === 'ambiguous') {
      // Never blindly retry: first ask the platform whether the post went out (TEST-06).
      const token = this.accounts.accessToken(target.socialAccount!);
      const result = await this.adapters
        .get(target.platform)!
        .reconcile(target.socialAccount!, token, content, attempt.startedAt, attempt.containerId);
      if (result.state === 'published') {
        await this.finishAttempt(attempt, 'reconciled', error.providerCode ?? null, error.message, result.outcome.remotePostId);
        return this.published(target, result.outcome, true);
      }
      if (result.state === 'unknown') {
        await this.finishAttempt(attempt, 'ambiguous', error.providerCode ?? null, error.message);
        return this.needsAction(
          target,
          'We could not confirm whether this post was published. Check the page, then retry if it is not there.',
        );
      }
      // Provably not published: safe to treat like a transient failure.
      error = new PlatformError(error.message, 'transient', error.providerCode);
    }

    if (error.kind === 'auth') {
      await this.finishAttempt(attempt, 'auth_error', error.providerCode ?? null, error.message);
      await this.accounts.markNeedsReconnect(target.socialAccount!, 'Meta rejected the access token.');
      return this.needsAction(target, 'The account needs to be reconnected before this post can publish.');
    }

    if (error.kind === 'permanent') {
      await this.finishAttempt(attempt, 'permanent_error', error.providerCode ?? null, error.message);
      return this.needsAction(target, error.message);
    }

    await this.finishAttempt(attempt, 'transient_error', error.providerCode ?? null, error.message);
    if (target.attemptCount >= MAX_ATTEMPTS) {
      return this.failed(target, `Gave up after ${MAX_ATTEMPTS} attempts: ${error.message}`);
    }
    return this.scheduleRetry(target, error);
  }

  /** Exponential backoff with jitter, honouring Retry-After (TEST-05). */
  backoffMs(attempt: number, retryAfterMs?: number) {
    const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const jittered = exponential * (0.8 + Math.random() * 0.4);
    return Math.max(jittered, retryAfterMs ?? 0);
  }

  private async scheduleRetry(target: LoadedTarget, error: PlatformError): Promise<ProcessResult> {
    const runAt = new Date(Date.now() + this.backoffMs(target.attemptCount, error.retryAfterMs));
    const jobToken = randomUUID();
    await this.prisma.$transaction(async tx => {
      await tx.postTarget.update({
        where: {id: target.id},
        data: {status: 'SCHEDULED', jobToken, nextAttemptAt: runAt, lastError: error.message},
      });
      await recomputePostStatus(tx, target.postId);
    });
    await this.queue.enqueue(target.id, jobToken, runAt);

    const late = target.scheduledAt && runAt.getTime() - target.scheduledAt.getTime() > SCHEDULE_SLA_MS;
    if (late) {
      await this.notifyFailure(target, 'publish_delayed', 'Publishing is delayed', `${this.label(target)} is retrying: ${error.message}`, 'delayed');
    }
    return 'retry_scheduled';
  }

  private label(target: LoadedTarget) {
    return `${target.socialAccount?.name || PLATFORMS[target.platform].label}`;
  }

  private async published(target: LoadedTarget, outcome: PublishOutcome, reconciled: boolean): Promise<ProcessResult> {
    await this.prisma.$transaction(async tx => {
      await tx.postTarget.update({
        where: {id: target.id},
        data: {
          status: 'PUBLISHED',
          remotePostId: outcome.remotePostId,
          remoteUrl: outcome.remoteUrl ?? null,
          publishedAt: new Date(),
          lastError: null,
          jobToken: null,
        },
      });
      await recomputePostStatus(tx, target.postId);
    });
    await this.audit.record({
      workspaceId: target.post.workspaceId,
      actorId: null,
      action: 'post.published',
      entityType: 'post_target',
      entityId: target.id,
      metadata: {postId: target.postId, platform: target.platform, remotePostId: outcome.remotePostId, reconciled},
    });
    await this.notifications.notify({
      userId: target.post.userId,
      workspaceId: target.post.workspaceId,
      type: 'post_published',
      title: 'Post published',
      body: `Published to ${this.label(target)}.`,
      meta: {postId: target.postId, targetId: target.id, remoteUrl: outcome.remoteUrl},
      dedupeKey: `published:${target.id}`,
    });
    return reconciled ? 'reconciled' : 'published';
  }

  private async needsAction(target: LoadedTarget, reason: string): Promise<ProcessResult> {
    await this.settle(target, 'NEEDS_ACTION', reason);
    await this.notifyFailure(target, 'publish_failed', 'A post needs your attention', `${this.label(target)}: ${reason}`, 'needs-action');
    return 'needs_action';
  }

  private async failed(target: LoadedTarget, reason: string): Promise<ProcessResult> {
    await this.settle(target, 'FAILED', reason);
    await this.notifyFailure(target, 'publish_failed', 'Publishing failed', `${this.label(target)}: ${reason}`, 'failed');
    return 'failed';
  }

  private async settle(target: LoadedTarget, status: 'NEEDS_ACTION' | 'FAILED', reason: string) {
    await this.prisma.$transaction(async tx => {
      await tx.postTarget.update({
        where: {id: target.id},
        data: {status, lastError: reason, jobToken: null, nextAttemptAt: null},
      });
      await recomputePostStatus(tx, target.postId);
    });
    await this.audit.record({
      workspaceId: target.post.workspaceId,
      actorId: null,
      action: status === 'FAILED' ? 'post.publish_failed' : 'post.needs_action',
      entityType: 'post_target',
      entityId: target.id,
      metadata: {postId: target.postId, platform: target.platform, reason},
    });
  }

  private notifyFailure(target: LoadedTarget, type: string, title: string, body: string, kind: string) {
    return this.notifications.notifyRoles(
      target.post.workspaceId,
      ['OWNER', 'ADMIN'],
      {
        type,
        title,
        body,
        meta: {postId: target.postId, targetId: target.id},
        dedupeKey: `${kind}:${target.id}:${target.attemptCount}`,
        email: kind !== 'delayed',
      },
      [target.post.userId],
    );
  }

  /**
   * Resolves a target left PROCESSING by a crashed worker: reconcile, then publish nothing new
   * unless the platform proves the post never went out (TEST-03, TEST-06).
   */
  async recoverStuck(targetId: string) {
    const target = await this.prisma.postTarget.findUnique(loadTarget(targetId));
    if (!target || target.status !== 'PROCESSING') {
      return;
    }
    const attempt = await this.prisma.publishAttempt.findFirst({
      where: {targetId},
      orderBy: {attempt: 'desc'},
    });
    if (!attempt || attempt.completedAt) {
      // The worker died between claiming and calling the platform, or after recording a result
      // but before settling the target. Neither published anything new.
      if (attempt?.outcome === 'success' && attempt.remotePostId) {
        await this.published(target, {remotePostId: attempt.remotePostId}, true);
        return;
      }
      await this.scheduleRetry(target, new PlatformError('The publishing worker restarted.', 'transient', 'worker_restart'));
      return;
    }
    await this.handleFailure(
      target,
      attempt,
      new PlatformError('The publishing worker stopped mid-request.', 'ambiguous', 'worker_restart'),
      await this.content(target),
    );
  }
}
