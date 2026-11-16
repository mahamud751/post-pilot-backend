import {BadRequestException, ForbiddenException, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {SocialAccount, SocialPlatform} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {CryptoService} from '../crypto/crypto.service';
import {PrismaService} from '../prisma/prisma.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';
import {GRAPH_BASE, GRAPH_VERSION, graphRequest, PlatformError} from './meta-graph';
import {PLATFORMS} from './platforms';
import {SocialAccountsService} from './social-accounts.service';

const STATE_TTL_MS = 10 * 60_000;
const SELECTION_TTL_MS = 30 * 60_000;
const FB_SCOPES_CORE = 'pages_show_list,pages_read_engagement,pages_manage_posts,business_management';

type Candidate = {
  key: string;
  platform: SocialPlatform;
  platformAccountId: string;
  name: string;
  handle: string | null;
  pictureUrl: string | null;
  accessToken: string;
  pageId: string;
};

type CandidateBundle = {
  fbUserId: string;
  userToken: string;
  userTokenExpiresAt: string | null;
  scopes: string[];
  candidates: Candidate[];
};

/** Facebook Login for Pages and linked Instagram Professional accounts (PRD FR-03, section 8). */
@Injectable()
export class MetaOAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly accounts: SocialAccountsService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
  ) {}

  private apiUrl() {
    return (this.config.get<string>('APP_URL') || 'http://localhost:9001/v1').replace(/\/+$/, '');
  }

  webUrl() {
    return (this.config.get<string>('WEB_APP_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  }

  /** Kept at the pre-existing path so the redirect URI registered with Meta still matches. */
  redirectUri() {
    return `${this.apiUrl()}/social-auth/facebook/callback`;
  }

  private scopes() {
    const override = this.config.get<string>('FACEBOOK_LOGIN_SCOPES')?.trim();
    if (override) {
      return override;
    }
    const instagram = this.config.get<string>('FACEBOOK_INSTAGRAM_LOGIN_SCOPES')?.trim();
    const instagramEnabled =
      String(this.config.get<string>('FACEBOOK_ENABLE_INSTAGRAM_LOGIN') ?? '').toLowerCase() === 'true';
    return instagramEnabled && instagram ? `${FB_SCOPES_CORE},${instagram}` : FB_SCOPES_CORE;
  }

  configured() {
    return Boolean(this.config.get<string>('FACEBOOK_APP_ID') && this.config.get<string>('FACEBOOK_APP_SECRET'));
  }

  async startConnect(ctx: WorkspaceContext, userId: string, platform: SocialPlatform) {
    const caps = PLATFORMS[platform];
    if (!caps.available) {
      throw new BadRequestException(`${caps.label}: ${caps.unavailableReason}`);
    }
    if (!this.configured()) {
      throw new BadRequestException('FACEBOOK_APP_ID and FACEBOOK_APP_SECRET are not configured on the server.');
    }
    await this.entitlements.assertActive(ctx.id);

    const nonce = this.crypto.randomToken();
    const state = await this.prisma.oAuthState.create({
      data: {
        workspaceId: ctx.id,
        userId,
        platform: caps.connectVia || platform,
        nonceHash: this.crypto.hash(nonce),
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      },
    });
    const params = new URLSearchParams({
      client_id: String(this.config.get<string>('FACEBOOK_APP_ID')),
      redirect_uri: this.redirectUri(),
      state: `${state.id}.${nonce}`,
      response_type: 'code',
      scope: this.scopes(),
    });
    return {url: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params}`};
  }

  /** Validates single-use state, exchanges the code and stores the page list for selection. */
  async handleCallback(code: string | undefined, rawState: string | undefined, error?: string) {
    const [stateId, nonce] = String(rawState || '').split('.');
    const state = stateId
      ? await this.prisma.oAuthState.findUnique({where: {id: stateId}}).catch(() => null)
      : null;
    if (
      !state ||
      !nonce ||
      state.nonceHash !== this.crypto.hash(nonce) ||
      state.usedAt ||
      state.expiresAt.getTime() < Date.now()
    ) {
      return this.redirectWithError('This connection link is invalid or has expired. Please try again.');
    }
    await this.prisma.oAuthState.update({where: {id: state.id}, data: {usedAt: new Date()}});

    if (error || !code) {
      return this.redirectWithError(error === 'access_denied' ? 'Facebook access was not granted.' : 'Facebook did not complete the login.');
    }

    try {
      const bundle = await this.exchange(code);
      await this.prisma.oAuthState.update({
        where: {id: state.id},
        data: {
          candidatesEnc: this.crypto.encrypt(JSON.stringify(bundle)),
          expiresAt: new Date(Date.now() + SELECTION_TTL_MS),
        },
      });
      return `${this.webUrl()}/accounts?connect=${encodeURIComponent(state.id)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.redirectWithError(`Facebook connection failed: ${message}`);
    }
  }

  private redirectWithError(message: string) {
    return `${this.webUrl()}/accounts?connect_error=${encodeURIComponent(message)}`;
  }

  private async exchange(code: string): Promise<CandidateBundle> {
    const appId = String(this.config.get<string>('FACEBOOK_APP_ID'));
    const appSecret = String(this.config.get<string>('FACEBOOK_APP_SECRET'));

    const shortLived = await this.getJson(
      `${GRAPH_BASE}/oauth/access_token?${new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: this.redirectUri(),
        code,
      })}`,
    );
    // Long-lived user tokens yield Page tokens that do not expire.
    const longLived = await this.getJson(
      `${GRAPH_BASE}/oauth/access_token?${new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: String(shortLived.access_token),
      })}`,
    );
    const userToken = String(longLived.access_token || shortLived.access_token);
    const expiresIn = Number(longLived.expires_in || 0);

    const me = await graphRequest<{id: string}>('GET', '/me', userToken, {fields: 'id'});
    const permissions = await graphRequest<{data: {permission: string; status: string}[]}>(
      'GET',
      '/me/permissions',
      userToken,
    );
    const pages = await graphRequest<{
      data: {
        id: string;
        name: string;
        access_token?: string;
        picture?: {data?: {url?: string}};
        instagram_business_account?: {id: string; username?: string; profile_picture_url?: string};
      }[];
    }>('GET', '/me/accounts', userToken, {
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,profile_picture_url}',
      limit: '100',
    });

    const candidates: Candidate[] = [];
    for (const page of pages.data || []) {
      if (!page.access_token) {
        continue;
      }
      candidates.push({
        key: `FACEBOOK:${page.id}`,
        platform: 'FACEBOOK',
        platformAccountId: page.id,
        name: page.name,
        handle: null,
        pictureUrl: page.picture?.data?.url || null,
        accessToken: page.access_token,
        pageId: page.id,
      });
      const ig = page.instagram_business_account;
      if (ig?.id) {
        candidates.push({
          key: `INSTAGRAM:${ig.id}`,
          platform: 'INSTAGRAM',
          platformAccountId: ig.id,
          name: ig.username ? `@${ig.username}` : `${page.name} (Instagram)`,
          handle: ig.username || null,
          pictureUrl: ig.profile_picture_url || null,
          accessToken: page.access_token,
          pageId: page.id,
        });
      }
    }

    return {
      fbUserId: me.id,
      userToken,
      userTokenExpiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
      scopes: (permissions.data || []).filter(p => p.status === 'granted').map(p => p.permission),
      candidates,
    };
  }

  private async getJson(url: string) {
    const response = await fetch(url, {signal: AbortSignal.timeout(30_000)});
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      error?: {message?: string};
    };
    if (!response.ok || body.error) {
      throw new PlatformError(body.error?.message || `Meta returned ${response.status}`, 'permanent');
    }
    return body;
  }

  private async loadSelection(ctx: WorkspaceContext, userId: string, stateId: string) {
    const state = await this.prisma.oAuthState.findUnique({where: {id: stateId}});
    if (!state || state.workspaceId !== ctx.id || state.userId !== userId) {
      throw new NotFoundException('Connection not found');
    }
    if (state.completedAt || !state.candidatesEnc || state.expiresAt.getTime() < Date.now()) {
      throw new ForbiddenException('This connection has expired. Start again from Social Accounts.');
    }
    const bundle = JSON.parse(this.crypto.decrypt(state.candidatesEnc)) as CandidateBundle;
    return {state, bundle};
  }

  async listCandidates(ctx: WorkspaceContext, userId: string, stateId: string) {
    const {bundle} = await this.loadSelection(ctx, userId, stateId);
    const existing = await this.prisma.socialAccount.findMany({
      where: {workspaceId: ctx.id, status: {not: 'REVOKED'}},
      select: {platform: true, platformAccountId: true},
    });
    const connected = new Set(existing.map(a => `${a.platform}:${a.platformAccountId}`));
    return {
      scopes: bundle.scopes,
      candidates: bundle.candidates.map(c => ({
        key: c.key,
        platform: c.platform,
        platformLabel: PLATFORMS[c.platform].label,
        name: c.name,
        handle: c.handle,
        pictureUrl: c.pictureUrl,
        alreadyConnected: connected.has(c.key),
      })),
    };
  }

  async selectCandidates(ctx: WorkspaceContext, userId: string, stateId: string, keys: string[]) {
    const {state, bundle} = await this.loadSelection(ctx, userId, stateId);
    const chosen = bundle.candidates.filter(c => keys.includes(c.key));
    if (chosen.length === 0) {
      throw new BadRequestException('Choose at least one Page or Instagram account');
    }

    const existing = await this.prisma.socialAccount.findMany({
      where: {workspaceId: ctx.id, status: {not: 'REVOKED'}},
      select: {platform: true, platformAccountId: true},
    });
    const connected = new Set(existing.map(a => `${a.platform}:${a.platformAccountId}`));
    await this.entitlements.assertCanConnectChannels(
      ctx.id,
      chosen.filter(c => !connected.has(c.key)).length,
    );

    const accounts = await this.prisma.$transaction(async tx => {
      const created: SocialAccount[] = [];
      for (const c of chosen) {
        created.push(
          await this.accounts.upsertConnected(tx, {
            workspaceId: ctx.id,
            platform: c.platform,
            platformAccountId: c.platformAccountId,
            name: c.name,
            handle: c.handle,
            pictureUrl: c.pictureUrl,
            accessToken: c.accessToken,
            userToken: bundle.userToken,
            scopes: bundle.scopes,
            meta: {pageId: c.pageId, fbUserId: bundle.fbUserId},
            connectedById: userId,
          }),
        );
      }
      await tx.oAuthState.update({
        where: {id: state.id},
        data: {completedAt: new Date(), candidatesEnc: null},
      });
      await tx.workspace.updateMany({
        where: {id: ctx.id, onboardingStep: {in: ['brand', 'channels']}},
        data: {onboardingStep: 'done'},
      });
      return created;
    });

    for (const account of accounts) {
      await this.audit.record({
        workspaceId: ctx.id,
        actorId: userId,
        action: 'social_account.connected',
        entityType: 'social_account',
        entityId: account.id,
        metadata: {platform: account.platform, name: account.name, scopes: account.scopes},
      });
    }
    return accounts.map(a => this.accounts.serialize(a));
  }
}
