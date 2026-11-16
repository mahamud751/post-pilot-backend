import {Injectable, Logger, NotFoundException} from '@nestjs/common';
import {Prisma, SocialAccount} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {CryptoService} from '../crypto/crypto.service';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {graphRequest, PlatformError} from './meta-graph';
import {PLATFORMS} from './platforms';

const EXPIRING_SOON_MS = 7 * 86_400_000;

export type AccountMeta = {pageId?: string; fbUserId?: string};

@Injectable()
export class SocialAccountsService {
  private readonly logger = new Logger(SocialAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Public shape: never includes tokens. */
  serialize(account: SocialAccount) {
    const now = Date.now();
    const expiresAt = account.expiresAt?.getTime();
    const tokenHealth =
      account.status !== 'CONNECTED'
        ? 'action_required'
        : expiresAt && expiresAt <= now
          ? 'expired'
          : expiresAt && expiresAt - now < EXPIRING_SOON_MS
            ? 'expiring'
            : 'ok';
    return {
      id: account.id,
      platform: account.platform,
      platformLabel: PLATFORMS[account.platform].label,
      platformAccountId: account.platformAccountId,
      name: account.name,
      handle: account.handle,
      pictureUrl: account.pictureUrl,
      scopes: account.scopes,
      expiresAt: account.expiresAt,
      status: account.status,
      statusReason: account.statusReason,
      tokenHealth,
      lastCheckedAt: account.lastCheckedAt,
      createdAt: account.createdAt,
    };
  }

  async list(workspaceId: string) {
    const accounts = await this.prisma.socialAccount.findMany({
      where: {workspaceId, status: {not: 'REVOKED'}},
      orderBy: [{platform: 'asc'}, {createdAt: 'asc'}],
    });
    return accounts.map(a => this.serialize(a));
  }

  async findInWorkspace(workspaceId: string, id: string) {
    const account = await this.prisma.socialAccount.findFirst({where: {id, workspaceId}});
    if (!account) {
      throw new NotFoundException('Social account not found');
    }
    return account;
  }

  /** Decrypted access token for publishing. Internal use only. */
  accessToken(account: SocialAccount) {
    return this.crypto.decrypt(account.accessTokenEnc);
  }

  meta(account: SocialAccount): AccountMeta {
    return (account.meta as AccountMeta | null) || {};
  }

  /** Marks the account as needing reconnection and tells the workspace managers (FR-11). */
  async markNeedsReconnect(account: SocialAccount, reason: string) {
    if (account.status === 'EXPIRED' || account.status === 'REVOKED') {
      return;
    }
    await this.prisma.socialAccount.update({
      where: {id: account.id},
      data: {status: 'EXPIRED', statusReason: reason, lastCheckedAt: new Date()},
    });
    await this.audit.record({
      workspaceId: account.workspaceId,
      actorId: null,
      action: 'social_account.expired',
      entityType: 'social_account',
      entityId: account.id,
      metadata: {reason},
    });
    await this.notifications.notifyRoles(account.workspaceId, ['OWNER', 'ADMIN'], {
      type: 'connection_expired',
      title: `${PLATFORMS[account.platform].label} needs reconnecting`,
      body: `${account.name} can no longer publish: ${reason} Reconnect it from Social Accounts.`,
      meta: {socialAccountId: account.id},
      dedupeKey: `connection-expired:${account.id}:${new Date().toISOString().slice(0, 10)}`,
      email: true,
    });
  }

  /** Verifies the stored token still works (Connect Accounts "token health"). */
  async checkHealth(ctx: WorkspaceContext, id: string) {
    const account = await this.findInWorkspace(ctx.id, id);
    if (account.status === 'REVOKED') {
      return this.serialize(account);
    }
    try {
      await graphRequest('GET', `/${encodeURIComponent(account.platformAccountId)}`, this.accessToken(account), {
        fields: 'id',
      });
      const updated = await this.prisma.socialAccount.update({
        where: {id},
        data: {status: 'CONNECTED', statusReason: null, lastCheckedAt: new Date()},
      });
      return this.serialize(updated);
    } catch (error) {
      if (error instanceof PlatformError && error.kind === 'auth') {
        await this.markNeedsReconnect(account, 'Meta rejected the saved access token.');
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.prisma.socialAccount.update({
          where: {id},
          data: {lastCheckedAt: new Date(), statusReason: `Health check failed: ${message}`},
        });
      }
      return this.serialize(await this.findInWorkspace(ctx.id, id));
    }
  }

  /**
   * Disconnects the account (PRD TEST-12): revokes the app's Meta grant when no other
   * connected account relies on it, wipes the tokens, and stops pending publications.
   */
  async disconnect(ctx: WorkspaceContext, actorId: string, id: string) {
    const account = await this.findInWorkspace(ctx.id, id);
    const meta = this.meta(account);

    let revokedAtProvider = false;
    if (account.refreshTokenEnc && meta.fbUserId) {
      const othersUsingGrant = await this.prisma.socialAccount.count({
        where: {
          id: {not: account.id},
          status: {not: 'REVOKED'},
          meta: {path: ['fbUserId'], equals: meta.fbUserId},
        },
      });
      if (othersUsingGrant === 0) {
        try {
          await graphRequest('DELETE', '/me/permissions', this.crypto.decrypt(account.refreshTokenEnc));
          revokedAtProvider = true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(`Meta revoke for account ${account.id} failed: ${message}`);
        }
      }
    }

    const stopped = await this.prisma.$transaction(async tx => {
      await tx.socialAccount.update({
        where: {id: account.id},
        data: {
          status: 'REVOKED',
          statusReason: 'Disconnected by a workspace member.',
          accessTokenEnc: '',
          refreshTokenEnc: null,
        },
      });
      return tx.postTarget.updateMany({
        where: {socialAccountId: account.id, status: {in: ['PENDING', 'SCHEDULED']}},
        data: {status: 'NEEDS_ACTION', jobToken: null, lastError: 'The social account was disconnected.'},
      });
    });

    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: 'social_account.disconnected',
      entityType: 'social_account',
      entityId: account.id,
      metadata: {platform: account.platform, revokedAtProvider, stoppedTargets: stopped.count},
    });
    return {ok: true, revokedAtProvider, stoppedTargets: stopped.count};
  }

  /** Creates or refreshes an account from an OAuth grant; the caller enforces plan limits. */
  async upsertConnected(
    tx: Prisma.TransactionClient,
    input: {
      workspaceId: string;
      platform: SocialAccount['platform'];
      platformAccountId: string;
      name: string;
      handle?: string | null;
      pictureUrl?: string | null;
      accessToken: string;
      userToken?: string | null;
      scopes: string[];
      expiresAt?: Date | null;
      meta: AccountMeta;
      connectedById: string | null;
    },
  ) {
    const data = {
      name: input.name,
      handle: input.handle ?? null,
      pictureUrl: input.pictureUrl ?? null,
      accessTokenEnc: this.crypto.encrypt(input.accessToken),
      refreshTokenEnc: input.userToken ? this.crypto.encrypt(input.userToken) : null,
      scopes: input.scopes,
      expiresAt: input.expiresAt ?? null,
      status: 'CONNECTED' as const,
      statusReason: null,
      meta: input.meta as Prisma.InputJsonValue,
      connectedById: input.connectedById,
      lastCheckedAt: new Date(),
    };
    const account = await tx.socialAccount.upsert({
      where: {
        platform_platformAccountId_workspaceId: {
          platform: input.platform,
          platformAccountId: input.platformAccountId,
          workspaceId: input.workspaceId,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        platform: input.platform,
        platformAccountId: input.platformAccountId,
        ...data,
      },
      update: data,
    });

    // Attach targets created before any account of this platform was connected.
    await tx.postTarget.updateMany({
      where: {
        socialAccountId: null,
        platform: input.platform,
        post: {workspaceId: input.workspaceId},
      },
      data: {socialAccountId: account.id},
    });
    return account;
  }
}
