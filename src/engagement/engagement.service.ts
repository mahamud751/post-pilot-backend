import {BadRequestException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {AutopilotConfig, EngagementItem, EngagementStatus, Prisma, SocialAccount, Workspace} from '@prisma/client';
import {InboxQuery, UpdateLeadDto} from './inbox.dto';
import {checkCompliance} from '../ai/compliance';
import {AiService} from '../ai/ai.service';
import {AuditService} from '../audit/audit.service';
import {BLOCKING_COMPLIANCE} from '../autopilot/disposition';
import {BrandService} from '../brand/brand.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import {PlatformError} from '../social/meta-graph';
import {SocialAccountsService} from '../social/social-accounts.service';
import {CONTENT_WRITERS, WorkspaceContext} from '../workspaces/workspace.guard';
import {decideReply, HOURLY_LIMIT_REASON} from './reply-policy';
import {
  DM_SAFE_WINDOW_MS,
  fetchComments,
  fetchDms,
  InboxMessage,
  missingScopes,
  sendCommentReply,
  sendDm,
} from './meta-inbox';

/** Messages drafted per AI call (1 credit). */
const BATCH = 10;
/** Comments older than this are never answered automatically, even when first seen. */
const MAX_COMMENT_AGE_MS = 3 * 24 * 60 * 60_000;
const SENDABLE: EngagementStatus[] = ['NEW', 'DRAFTED', 'NEEDS_HUMAN', 'FAILED'];

type PollResult = {fetched: number; drafted: number; sent: number; needsHuman: number; warnings: string[]};

@Injectable()
export class EngagementService {
  private readonly logger = new Logger(EngagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
    private readonly ai: AiService,
    private readonly brand: BrandService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ---------- Inbox API ----------

  async list(ctx: WorkspaceContext, query: InboxQuery) {
    const {status, stage, platform, search, assignee, page, take} = query;
    const where: Prisma.EngagementItemWhereInput = {
      workspaceId: ctx.id,
      ...(status === 'ATTENTION' ? {status: {in: SENDABLE}} : status && status !== 'ALL' ? {status: status as EngagementStatus} : {}),
      ...(stage ? {leadStage: stage} : {}),
      ...(platform ? {platform} : {}),
      ...(assignee ? {assignedMemberId: assignee === 'unassigned' ? null : assignee} : {}),
      ...(search ? {OR: [{text: {contains: search, mode: 'insensitive'}}, {authorName: {contains: search, mode: 'insensitive'}}]} : {}),
    };
    const [items, counts, total, stages, members] = await Promise.all([
      this.prisma.engagementItem.findMany({
        where,
        orderBy: [{receivedAt: 'desc'}, {id: 'desc'}],
        take,
        skip: (page - 1) * take,
        include: {socialAccount: {select: {name: true, handle: true}}},
      }),
      this.prisma.engagementItem.groupBy({by: ['status'], where: {workspaceId: ctx.id}, _count: true}),
      this.prisma.engagementItem.count({where}),
      this.prisma.engagementItem.groupBy({by: ['leadStage'], where: {workspaceId: ctx.id}, _count: true}),
      this.prisma.workspaceMember.findMany({where: {workspaceId: ctx.id, inviteStatus: 'ACTIVE', role: {in: CONTENT_WRITERS}}, select: {id: true, user: {select: {name: true}}}}),
    ]);
    return {
      items,
      counts: Object.fromEntries(counts.map(row => [row.status, row._count])),
      stages: Object.fromEntries(stages.map(row => [row.leadStage, row._count])),
      members: members.map(member => ({id: member.id, name: member.user.name})),
      total, page, take,
    };
  }

  async updateLead(ctx: WorkspaceContext, userId: string, id: string, input: UpdateLeadDto) {
    return this.prisma.$transaction(async tx => {
      if (input.assignedMemberId) {
        const member = await tx.workspaceMember.findFirst({where: {id: input.assignedMemberId, workspaceId: ctx.id, inviteStatus: 'ACTIVE', role: {in: CONTENT_WRITERS}}});
        if (!member) throw new BadRequestException('Assign an active writer in this workspace.');
      }
      const result = await tx.engagementItem.updateMany({where: {id, workspaceId: ctx.id}, data: input});
      if (!result.count) throw new NotFoundException('Message not found');
      await this.audit.record({workspaceId: ctx.id, actorId: userId, action: 'engagement.lead_updated', entityType: 'engagement', entityId: id,
        metadata: {leadStage: input.leadStage, assignedMemberId: input.assignedMemberId}}, tx);
      return {ok: true};
    });
  }

  async thread(ctx: WorkspaceContext, id: string) {
    const item = await this.prisma.engagementItem.findFirst({where: {id, workspaceId: ctx.id}});
    if (!item) throw new NotFoundException('Message not found');
    const items = await this.prisma.engagementItem.findMany({
      where: {workspaceId: ctx.id, socialAccountId: item.socialAccountId,
        ...(item.kind === 'DM' && item.authorId ? {kind: 'DM', authorId: item.authorId} : {threadId: item.threadId})},
      orderBy: [{receivedAt: 'desc'}, {id: 'desc'}], take: 50,
      select: {id: true, text: true, authorName: true, replyText: true, receivedAt: true, repliedAt: true, status: true},
    });
    return {items: items.reverse()};
  }

  /** A person sends (or edits and sends) a reply from the inbox. */
  async sendManual(ctx: WorkspaceContext, userId: string, id: string, text?: string) {
    const item = await this.prisma.engagementItem.findFirst({
      where: {id, workspaceId: ctx.id},
      include: {socialAccount: true},
    });
    if (!item) throw new NotFoundException('Message not found');
    const reply = (text ?? item.replyText ?? '').trim();
    if (!reply) throw new BadRequestException('Write a reply first.');
    if (!SENDABLE.includes(item.status)) {
      throw new BadRequestException(`This message is already ${item.status.toLowerCase().replace('_', ' ')}.`);
    }
    if (item.kind === 'DM' && Date.now() - item.receivedAt.getTime() > 24 * 60 * 60_000) {
      throw new BadRequestException('Meta only allows a reply within 24 hours of the last message. Answer this one in the Meta Business Suite inbox.');
    }
    const sent = await this.deliver(item, item.socialAccount, reply, userId);
    await this.audit.record({
      workspaceId: ctx.id,
      actorId: userId,
      action: 'engagement.replied',
      entityType: 'engagement',
      entityId: item.id,
      metadata: {kind: item.kind, platform: item.platform, ok: sent.status === 'REPLIED'},
    });
    if (sent.status !== 'REPLIED') throw new BadRequestException(sent.reason || 'Meta did not accept the reply.');
    return {item: sent};
  }

  async skip(ctx: WorkspaceContext, id: string) {
    const res = await this.prisma.engagementItem.updateMany({
      where: {id, workspaceId: ctx.id, status: {in: SENDABLE}},
      data: {status: 'SKIPPED', reason: 'Skipped by a person'},
    });
    if (res.count === 0) throw new NotFoundException('Message not found or already handled');
    return {ok: true};
  }

  // ---------- Background poll ----------

  /** Reads new comments/DMs, drafts replies and, in AUTO mode, sends the safe ones. */
  async poll(config: AutopilotConfig & {workspace: Workspace}): Promise<PollResult> {
    const ws = config.workspace;
    const result: PollResult = {fetched: 0, drafted: 0, sent: 0, needsHuman: 0, warnings: []};
    if (config.replyMode === 'OFF') return result;
    const since = new Date(
      Math.max(config.repliesSince?.getTime() ?? Date.now(), Date.now() - MAX_COMMENT_AGE_MS),
    );

    const accounts = await this.prisma.socialAccount.findMany({
      where: {workspaceId: ws.id, status: 'CONNECTED', platform: {in: ['FACEBOOK', 'INSTAGRAM']}},
    });
    for (const account of accounts) {
      const found: InboxMessage[] = [];
      const kinds = [config.replyComments && 'COMMENT', config.replyDms && 'DM'].filter(Boolean) as ('COMMENT' | 'DM')[];
      for (const kind of kinds) {
        const missing = missingScopes(account, kind);
        if (missing.length) {
          result.warnings.push(
            `${account.name}: ${kind === 'DM' ? 'messages' : 'comments'} need the Meta permission ${missing.join(', ')}. Reconnect the account after it is approved for your app.`,
          );
          continue;
        }
        try {
          const token = this.accounts.accessToken(account);
          found.push(...(kind === 'COMMENT' ? await fetchComments(account, token, since) : await fetchDms(account, token, since)));
        } catch (error) {
          await this.handleAccountError(account, error, result);
        }
      }
      if (found.length) {
        const created = await this.prisma.engagementItem.createMany({
          data: found.map(message => ({
            workspaceId: ws.id,
            socialAccountId: account.id,
            platform: account.platform,
            ...message,
            text: message.text.slice(0, 4000),
          })),
          skipDuplicates: true,
        });
        result.fetched += created.count;
      }
    }

    await this.triage(config, result);
    return result;
  }

  private async triage(config: AutopilotConfig & {workspace: Workspace}, result: PollResult) {
    const ws = config.workspace;
    const ctx: WorkspaceContext = {
      id: ws.id,
      role: 'OWNER',
      timezone: ws.timezone,
      approvalRequired: ws.approvalRequired,
      ownerId: ws.ownerId,
    };
    const brand = await this.brand.get(ws.id);

    for (let round = 0; round < 3; round++) {
      const pending = await this.prisma.engagementItem.findMany({
        where: {workspaceId: ws.id, status: 'NEW'},
        orderBy: {receivedAt: 'asc'},
        take: BATCH,
        include: {socialAccount: true},
      });
      if (pending.length === 0) break;

      const {replies} = await this.ai.generateReplies(ctx, ws.ownerId, {
        instructions: config.replyInstructions,
        items: pending.map(item => ({
          id: item.id,
          kind: item.kind,
          platform: item.platform,
          authorName: item.authorName,
          text: item.text,
        })),
      });

      for (const item of pending) {
        const draft = replies.get(item.id);
        const flags = draft?.reply ? checkCompliance(draft.reply, brand) : [];
        const sentLastHour = await this.prisma.engagementItem.count({
          where: {workspaceId: ws.id, status: 'REPLIED', sentById: null, repliedAt: {gte: new Date(Date.now() - 60 * 60_000)}},
        });
        const decision = decideReply({
          mode: config.replyMode,
          draft,
          blocking: flags.filter(flag => BLOCKING_COMPLIANCE.has(flag.code)).map(flag => flag.message),
          overHourlyLimit: sentLastHour >= config.replyHourlyLimit,
          dmWindowClosed: item.kind === 'DM' && Date.now() - item.receivedAt.getTime() > DM_SAFE_WINDOW_MS,
        });

        await this.prisma.engagementItem.update({
          where: {id: item.id},
          data: {status: decision.status === 'SEND' ? 'DRAFTED' : decision.status, intent: draft?.intent, replyText: draft?.reply || null, reason: decision.reason ?? null},
        });
        if (decision.status === 'NEEDS_HUMAN') result.needsHuman++;
        if (decision.status === 'DRAFTED') result.drafted++;
        if (decision.status === 'SEND' && draft) {
          const sent = await this.deliver({...item, status: 'DRAFTED'}, item.socialAccount, draft.reply, null);
          if (sent.status === 'REPLIED') result.sent++;
        }
      }
    }

    if (config.replyMode === 'AUTO') await this.sendHeldBack(ws.id, config.replyHourlyLimit, result);

    if (result.needsHuman > 0 || (config.replyMode === 'DRAFT' && result.drafted > 0)) {
      await this.notifications.notifyRoles(ws.id, CONTENT_WRITERS, {
        type: 'inbox_attention',
        title: result.needsHuman > 0 ? 'Messages need a person' : 'Replies are ready to approve',
        body:
          result.needsHuman > 0
            ? `${result.needsHuman} comment${result.needsHuman === 1 ? '' : 's'} or message${result.needsHuman === 1 ? '' : 's'} should be answered by your team.`
            : `${result.drafted} drafted repl${result.drafted === 1 ? 'y is' : 'ies are'} waiting in the Autopilot inbox.`,
        dedupeKey: `inbox:${ws.id}:${new Date().toISOString().slice(0, 13)}`,
      });
    }
  }

  /** Sends drafts that were only held back by the hourly cap, oldest first, while room remains. */
  private async sendHeldBack(workspaceId: string, hourlyLimit: number, result: PollResult) {
    const sentLastHour = await this.prisma.engagementItem.count({
      where: {workspaceId, status: 'REPLIED', sentById: null, repliedAt: {gte: new Date(Date.now() - 60 * 60_000)}},
    });
    const room = hourlyLimit - sentLastHour;
    if (room <= 0) return;
    const held = await this.prisma.engagementItem.findMany({
      where: {workspaceId, status: 'DRAFTED', reason: HOURLY_LIMIT_REASON, replyText: {not: null}},
      orderBy: {receivedAt: 'asc'},
      take: room,
      include: {socialAccount: true},
    });
    for (const item of held) {
      if (item.kind === 'DM' && Date.now() - item.receivedAt.getTime() > DM_SAFE_WINDOW_MS) {
        await this.prisma.engagementItem.update({
          where: {id: item.id},
          data: {status: 'NEEDS_HUMAN', reason: "Meta's 24-hour reply window has closed."},
        });
        result.needsHuman++;
        continue;
      }
      const sent = await this.deliver(item, item.socialAccount, item.replyText!, null);
      if (sent.status === 'REPLIED') result.sent++;
    }
  }

  /** Claims the item, sends through Meta and records the outcome. Never sends the same item twice. */
  private async deliver(item: EngagementItem, account: SocialAccount, text: string, userId: string | null) {
    const claimed = await this.prisma.engagementItem.updateMany({
      where: {id: item.id, status: {in: SENDABLE}},
      data: {status: 'SENDING', replyText: text},
    });
    if (claimed.count === 0) {
      return this.prisma.engagementItem.findUniqueOrThrow({where: {id: item.id}});
    }
    try {
      const token = this.accounts.accessToken(account);
      const remoteId =
        item.kind === 'COMMENT'
          ? await sendCommentReply(account, token, item.externalId, text)
          : await sendDm(account, token, item.authorId || '', text);
      return this.prisma.engagementItem.update({
        where: {id: item.id},
        data: {status: 'REPLIED', replyExternalId: remoteId, repliedAt: new Date(), sentById: userId, reason: null},
      });
    } catch (error) {
      const ambiguous = error instanceof PlatformError && error.kind === 'ambiguous';
      if (error instanceof PlatformError && error.kind === 'auth') {
        await this.accounts.markNeedsReconnect(account, 'Meta rejected the access token.');
      }
      const message = error instanceof Error ? error.message.slice(0, 300) : 'Send failed';
      return this.prisma.engagementItem.update({
        where: {id: item.id},
        data: {
          // A timed-out send may have gone through; never retry it automatically.
          status: ambiguous ? 'NEEDS_HUMAN' : 'FAILED',
          reason: ambiguous ? `Meta did not confirm the reply; check before resending. (${message})` : message,
        },
      });
    }
  }

  private async handleAccountError(account: SocialAccount, error: unknown, result: PollResult) {
    if (error instanceof PlatformError && error.kind === 'auth') {
      await this.accounts.markNeedsReconnect(account, 'Meta rejected the access token.');
      result.warnings.push(`${account.name} needs reconnecting.`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.warn(`Inbox read failed for account ${account.id}: ${message}`);
    result.warnings.push(`${account.name}: ${message.slice(0, 200)}`);
  }
}
