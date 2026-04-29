import {BadRequestException, Injectable} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';

const FB_GRAPH_VERSION = 'v21.0';
const FB_LOGIN_SCOPES_CORE =
  'public_profile,business_management,pages_show_list,pages_read_engagement,pages_manage_posts';
const TIKTOK_OAUTH_SCOPES = 'user.info.basic,user.info.profile,video.publish';
const YOUTUBE_OAUTH_SCOPES =
  'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/youtube.upload';

@Injectable()
export class SocialAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private getAppUrl() {
    return this.config.get<string>('APP_URL') || 'https://postapi.chapaimango.online/v1';
  }

  private parseState(state: string) {
    try {
      return JSON.parse(decodeURIComponent(state || '{}')) as {userId?: string};
    } catch {
      return {};
    }
  }

  private extractHandle(url?: string | null) {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (!clean) {
      return null;
    }
    const parts = clean.split('/');
    return parts[parts.length - 1] || null;
  }

  private async fetchJson(url: string, init?: RequestInit) {
    const response = await fetch(url, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        (payload as {error?: {message?: string}})?.error?.message ||
        (payload as {message?: string})?.message ||
        `Request failed (${response.status})`;
      throw new BadRequestException(message);
    }
    return payload as Record<string, unknown>;
  }

  private getFacebookLoginScopes() {
    const full = this.config.get<string>('FACEBOOK_LOGIN_SCOPES')?.trim();
    if (full) {
      return full;
    }
    const enableInstagram =
      String(this.config.get<string>('FACEBOOK_ENABLE_INSTAGRAM_LOGIN') ?? '').toLowerCase() ===
      'true';
    if (!enableInstagram) {
      return FB_LOGIN_SCOPES_CORE;
    }
    const instagramScopes = this.config.get<string>('FACEBOOK_INSTAGRAM_LOGIN_SCOPES')?.trim();
    // Do not inject default Instagram scopes because Meta rejects legacy
    // instagram_basic/instagram_content_publish in many apps.
    if (!instagramScopes) {
      return FB_LOGIN_SCOPES_CORE;
    }
    return `${FB_LOGIN_SCOPES_CORE},${instagramScopes}`;
  }

  getVerifyConfig() {
    const appUrl = this.getAppUrl();
    return {
      appUrl,
      redirectUris: {
        facebook: `${appUrl}/social-auth/facebook/callback`,
        tiktok: `${appUrl}/social-auth/tiktok/callback`,
        youtube: `${appUrl}/social-auth/youtube/callback`,
      },
      configured: {
        facebookAppId: Boolean(this.config.get<string>('FACEBOOK_APP_ID')),
        facebookAppSecret: Boolean(this.config.get<string>('FACEBOOK_APP_SECRET')),
        tiktokClientKey: Boolean(this.config.get<string>('TIKTOK_CLIENT_KEY')),
        tiktokClientSecret: Boolean(this.config.get<string>('TIKTOK_CLIENT_SECRET')),
        googleClientId: Boolean(this.config.get<string>('GOOGLE_CLIENT_ID')),
        googleClientSecret: Boolean(this.config.get<string>('GOOGLE_CLIENT_SECRET')),
      },
    };
  }

  getFacebookConnectUrl(userId: string) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const appId = this.config.get<string>('FACEBOOK_APP_ID');
    if (!appId) {
      throw new BadRequestException('FACEBOOK_APP_ID is not configured');
    }
    const redirectUri = `${this.getAppUrl()}/social-auth/facebook/callback`;
    const state = encodeURIComponent(JSON.stringify({userId}));
    const scopes = encodeURIComponent(this.getFacebookLoginScopes());
    return {
      url:
        `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth?client_id=${encodeURIComponent(
          appId,
        )}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}` +
        `&response_type=code` +
        `&scope=${scopes}`,
      redirectUri,
    };
  }

  getTikTokConnectUrl(userId: string) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const clientKey = this.config.get<string>('TIKTOK_CLIENT_KEY');
    if (!clientKey) {
      throw new BadRequestException('TIKTOK_CLIENT_KEY is not configured');
    }
    const redirectUri = `${this.getAppUrl()}/social-auth/tiktok/callback`;
    const state = encodeURIComponent(JSON.stringify({userId}));
    const scope = encodeURIComponent(TIKTOK_OAUTH_SCOPES);
    return {
      url:
        `https://www.tiktok.com/v2/auth/authorize/?client_key=${encodeURIComponent(clientKey)}` +
        `&response_type=code&scope=${scope}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&state=${state}`,
      redirectUri,
    };
  }

  getYouTubeConnectUrl(userId: string) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId) {
      throw new BadRequestException('GOOGLE_CLIENT_ID is not configured');
    }
    const redirectUri = `${this.getAppUrl()}/social-auth/youtube/callback`;
    const state = encodeURIComponent(JSON.stringify({userId}));
    const scope = encodeURIComponent(YOUTUBE_OAUTH_SCOPES);
    return {
      url:
        `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=${scope}` +
        `&state=${state}` +
        `&access_type=offline` +
        `&prompt=consent`,
      redirectUri,
    };
  }

  async handleFacebookCallback(code: string, state: string) {
    const parsed = this.parseState(state);
    if (!code) {
      return {
        success: false,
        error: 'no_code',
        message: `Facebook did not return code. Add redirect URI: ${this.getAppUrl()}/social-auth/facebook/callback`,
      };
    }
    if (parsed.userId) {
      const user = await this.prisma.user.findUnique({where: {id: parsed.userId}});
      const appId = this.config.get<string>('FACEBOOK_APP_ID');
      const appSecret = this.config.get<string>('FACEBOOK_APP_SECRET');
      if (!appId || !appSecret) {
        throw new BadRequestException('FACEBOOK_APP_ID / FACEBOOK_APP_SECRET not configured');
      }
      const redirectUri = `${this.getAppUrl()}/social-auth/facebook/callback`;

      // 1) Exchange code -> user access token
      const tokenUrl =
        `https://graph.facebook.com/${FB_GRAPH_VERSION}/oauth/access_token?` +
        new URLSearchParams({
          client_id: appId,
          client_secret: appSecret,
          redirect_uri: redirectUri,
          code,
        }).toString();
      const tokenPayload = await this.fetchJson(tokenUrl);
      const userAccessToken = String(tokenPayload.access_token || '');
      if (!userAccessToken) {
        throw new BadRequestException('Could not retrieve Facebook access token');
      }

      // 2) Read user's pages to get real page name
      const pagesUrl =
        `https://graph.facebook.com/${FB_GRAPH_VERSION}/me/accounts?` +
        new URLSearchParams({
          access_token: userAccessToken,
        }).toString();
      const pagesPayload = await this.fetchJson(pagesUrl);
      const pages = Array.isArray(pagesPayload.data) ? pagesPayload.data : [];
      const firstPage = pages[0] as {id?: string; name?: string; access_token?: string} | undefined;
      const facebookName =
        String(firstPage?.name || '').trim() ||
        user?.facebookName ||
        this.extractHandle(user?.facebookUrl);

      // 3) Try reading linked Instagram business account username from the page
      let instagramName =
        user?.instagramName || this.extractHandle(user?.instagramUrl);
      if (firstPage?.id && firstPage?.access_token) {
        const igUrl =
          `https://graph.facebook.com/${FB_GRAPH_VERSION}/${encodeURIComponent(
            String(firstPage.id),
          )}?` +
          new URLSearchParams({
            fields: 'instagram_business_account{username}',
            access_token: String(firstPage.access_token),
          }).toString();
        try {
          const igPayload = await this.fetchJson(igUrl);
          const instagramBusinessAccount = igPayload.instagram_business_account as
            | {username?: string}
            | undefined;
          if (instagramBusinessAccount?.username) {
            instagramName = String(instagramBusinessAccount.username);
          }
        } catch {
          // keep fallback handle
        }
      }

      await this.prisma.user.update({
        where: {id: parsed.userId},
        data: {
          facebookVerified: true,
          instagramVerified: Boolean(instagramName) || user?.instagramVerified || false,
          facebookName,
          instagramName,
        },
      });
    }
    return {
      success: true,
      message: 'Facebook verification callback received.',
      code,
      stateUserId: parsed.userId || null,
    };
  }

  async handleTikTokCallback(code: string, state: string) {
    const parsed = this.parseState(state);
    if (!code) {
      return {
        success: false,
        error: 'no_code',
        message: `TikTok did not return code. Add redirect URI: ${this.getAppUrl()}/social-auth/tiktok/callback`,
      };
    }
    if (parsed.userId) {
      const user = await this.prisma.user.findUnique({where: {id: parsed.userId}});
      await this.prisma.user.update({
        where: {id: parsed.userId},
        data: {
          instagramVerified: true,
          instagramName: user?.instagramName || this.extractHandle(user?.instagramUrl),
        },
      });
    }
    return {
      success: true,
      message: 'TikTok verification callback received.',
      code,
      stateUserId: parsed.userId || null,
    };
  }

  async handleYouTubeCallback(
    code: string,
    state: string,
    error?: string,
    errorDescription?: string,
  ) {
    if (error) {
      return {
        success: false,
        error,
        message: errorDescription || 'YouTube authorization failed',
      };
    }
    const parsed = this.parseState(state);
    if (!code) {
      return {
        success: false,
        error: 'no_code',
        message: `YouTube did not return code. Add redirect URI: ${this.getAppUrl()}/social-auth/youtube/callback`,
      };
    }
    if (parsed.userId) {
      const user = await this.prisma.user.findUnique({where: {id: parsed.userId}});
      await this.prisma.user.update({
        where: {id: parsed.userId},
        data: {
          youtubeVerified: true,
          youtubeName: user?.youtubeName || this.extractHandle(user?.youtubeUrl),
        },
      });
    }
    return {
      success: true,
      message: 'YouTube verification callback received.',
      code,
      stateUserId: parsed.userId || null,
    };
  }
}

