import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

const FB_GRAPH = 'https://graph.facebook.com/v21.0';

type PublishInput = {
  caption: string;
  mediaUrl?: string | null;
  mediaType?: string | null;
};

type PublishResult = {
  platform: string;
  externalPostId?: string;
  error?: string;
};

@Injectable()
export class SocialPublishService {
  private readonly logger = new Logger(SocialPublishService.name);

  constructor(private readonly config: ConfigService) {}

  private appBaseUrl() {
    const appUrl = this.config.get<string>('APP_URL') || 'https://postapi.chapaimango.online/v1';
    return appUrl.replace(/\/v1\/?$/, '');
  }

  toAbsoluteMediaUrl(mediaUrl?: string | null) {
    if (!mediaUrl) {
      return null;
    }
    const trimmed = mediaUrl.trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    const base = this.appBaseUrl();
    return `${base}${trimmed.startsWith('/') ? '' : '/'}${trimmed}`;
  }

  private isVideo(mediaUrl: string | null, mediaType?: string | null) {
    if (mediaType?.startsWith('video')) {
      return true;
    }
    return Boolean(mediaUrl && /\.(mp4|mov|webm|avi|mkv)(\?|$)/i.test(mediaUrl));
  }

  private isImage(mediaUrl: string | null, mediaType?: string | null) {
    if (mediaType?.startsWith('image')) {
      return true;
    }
    return Boolean(mediaUrl && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(mediaUrl));
  }

  private async graphPost(path: string, token: string, params: Record<string, string>) {
    const body = new URLSearchParams({access_token: token, ...params});
    const response = await fetch(`${FB_GRAPH}${path}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: body.toString(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        (payload as {error?: {message?: string}})?.error?.message ||
        `Facebook API error (${response.status})`;
      throw new Error(message);
    }
    return payload as {id?: string; post_id?: string};
  }

  private async graphGet(path: string, token: string, query: Record<string, string>) {
    const params = new URLSearchParams({access_token: token, ...query});
    const response = await fetch(`${FB_GRAPH}${path}?${params.toString()}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        (payload as {error?: {message?: string}})?.error?.message ||
        `Facebook API error (${response.status})`;
      throw new Error(message);
    }
    return payload as Record<string, unknown>;
  }

  async publishToFacebook(
    pageId: string,
    pageAccessToken: string,
    input: PublishInput,
  ): Promise<PublishResult> {
    const caption = (input.caption || '').trim();
    const mediaUrl = this.toAbsoluteMediaUrl(input.mediaUrl);

    try {
      if (mediaUrl && this.isImage(mediaUrl, input.mediaType)) {
        const payload = await this.graphPost(
          `/${encodeURIComponent(pageId)}/photos`,
          pageAccessToken,
          {
            url: mediaUrl,
            caption,
            published: 'true',
          },
        );
        return {
          platform: 'facebook',
          externalPostId: String(payload.post_id || payload.id || ''),
        };
      }

      if (mediaUrl && this.isVideo(mediaUrl, input.mediaType)) {
        const payload = await this.graphPost(
          `/${encodeURIComponent(pageId)}/videos`,
          pageAccessToken,
          {
            file_url: mediaUrl,
            description: caption,
            published: 'true',
          },
        );
        return {
          platform: 'facebook',
          externalPostId: String(payload.id || ''),
        };
      }

      const payload = await this.graphPost(
        `/${encodeURIComponent(pageId)}/feed`,
        pageAccessToken,
        {message: caption},
      );
      return {
        platform: 'facebook',
        externalPostId: String(payload.id || ''),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Facebook publish failed: ${message}`);
      return {platform: 'facebook', error: message};
    }
  }

  async resolveInstagramAccountId(pageId: string, pageAccessToken: string) {
    const payload = await this.graphGet(`/${encodeURIComponent(pageId)}`, pageAccessToken, {
      fields: 'instagram_business_account',
    });
    const igAccount = payload.instagram_business_account as {id?: string} | undefined;
    return igAccount?.id ? String(igAccount.id) : null;
  }

  async publishToInstagram(
    pageId: string,
    pageAccessToken: string,
    instagramAccountId: string | null | undefined,
    input: PublishInput,
  ): Promise<PublishResult> {
    const caption = (input.caption || '').trim();
    const mediaUrl = this.toAbsoluteMediaUrl(input.mediaUrl);

    if (!mediaUrl || !this.isImage(mediaUrl, input.mediaType)) {
      return {
        platform: 'instagram',
        error: 'Instagram requires a public image URL (photo posts only).',
      };
    }

    try {
      let igUserId = instagramAccountId || null;
      if (!igUserId) {
        igUserId = await this.resolveInstagramAccountId(pageId, pageAccessToken);
      }
      if (!igUserId) {
        return {
          platform: 'instagram',
          error: 'No Instagram Business account linked to your Facebook page.',
        };
      }

      const container = await this.graphPost(
        `/${encodeURIComponent(igUserId)}/media`,
        pageAccessToken,
        {
          image_url: mediaUrl,
          caption,
        },
      );

      const creationId = String(container.id || '');
      if (!creationId) {
        throw new Error('Instagram media container was not created');
      }

      const published = await this.graphPost(
        `/${encodeURIComponent(igUserId)}/media_publish`,
        pageAccessToken,
        {creation_id: creationId},
      );

      return {
        platform: 'instagram',
        externalPostId: String(published.id || creationId),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Instagram publish failed: ${message}`);
      return {platform: 'instagram', error: message};
    }
  }

  publishToYouTube(): PublishResult {
    return {
      platform: 'youtube',
      error: 'YouTube auto-publish is not enabled yet. Connect YouTube and upload manually.',
    };
  }

  async publishToPlatforms(
    platforms: string[],
    user: {
      facebookPageId: string | null;
      facebookPageAccessToken: string | null;
      instagramBusinessAccountId: string | null;
    },
    input: PublishInput,
  ): Promise<PublishResult[]> {
    const pageId = user.facebookPageId;
    const pageAccessToken = user.facebookPageAccessToken;
    const results: PublishResult[] = [];

    if (!pageId || !pageAccessToken) {
      return platforms.map(platform => ({
        platform,
        error: 'Facebook page is not connected. Re-verify your account.',
      }));
    }

    if (platforms.includes('facebook')) {
      results.push(await this.publishToFacebook(pageId, pageAccessToken, input));
    }
    if (platforms.includes('instagram')) {
      results.push(
        await this.publishToInstagram(
          pageId,
          pageAccessToken,
          user.instagramBusinessAccountId,
          input,
        ),
      );
    }
    if (platforms.includes('youtube')) {
      results.push(this.publishToYouTube());
    }

    return results;
  }
}
