import {Injectable} from '@nestjs/common';
import {SocialAccount, SocialPlatform} from '@prisma/client';
import {graphRequest, PlatformError} from '../social/meta-graph';

export type PublishContent = {
  text: string;
  media: {url: string; mimeType: string}[];
};

export type PublishOutcome = {remotePostId: string; remoteUrl?: string | null};

export type ReconcileResult =
  | {state: 'published'; outcome: PublishOutcome}
  | {state: 'not_published'}
  | {state: 'unknown'};

export type PublishHooks = {
  /** Persist intermediate ids (e.g. an Instagram container) before the final publish call. */
  onContainer?: (containerId: string) => Promise<void>;
};

export interface PlatformAdapter {
  publish(account: SocialAccount, token: string, content: PublishContent, hooks: PublishHooks): Promise<PublishOutcome>;
  /** Called after an ambiguous attempt; must not publish anything. */
  reconcile(
    account: SocialAccount,
    token: string,
    content: PublishContent,
    since: Date,
    containerId: string | null,
  ): Promise<ReconcileResult>;
}

const sameText = (a?: string | null, b?: string | null) => (a || '').trim() === (b || '').trim();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class FacebookAdapter implements PlatformAdapter {
  async publish(account: SocialAccount, token: string, content: PublishContent): Promise<PublishOutcome> {
    const page = encodeURIComponent(account.platformAccountId);
    const media = content.media[0];
    let remotePostId: string;
    if (media?.mimeType.startsWith('image/')) {
      const res = await graphRequest<{id?: string; post_id?: string}>('POST', `/${page}/photos`, token, {
        url: media.url,
        caption: content.text,
        published: 'true',
      });
      remotePostId = String(res.post_id || res.id);
    } else if (media?.mimeType.startsWith('video/')) {
      const res = await graphRequest<{id?: string}>('POST', `/${page}/videos`, token, {
        file_url: media.url,
        description: content.text,
        published: 'true',
      });
      remotePostId = String(res.id);
    } else {
      const res = await graphRequest<{id?: string}>('POST', `/${page}/feed`, token, {message: content.text});
      remotePostId = String(res.id);
    }
    return {remotePostId, remoteUrl: `https://www.facebook.com/${remotePostId}`};
  }

  async reconcile(account: SocialAccount, token: string, content: PublishContent, since: Date): Promise<ReconcileResult> {
    const page = encodeURIComponent(account.platformAccountId);
    try {
      const res = await graphRequest<{data?: {id: string; message?: string}[]}>('GET', `/${page}/published_posts`, token, {
        fields: 'id,message,created_time',
        since: String(Math.floor(since.getTime() / 1000) - 120),
        limit: '25',
      });
      const match = (res.data || []).find(p => sameText(p.message, content.text));
      // Not finding it is not proof: Meta can take a while to list a new post.
      return match
        ? {state: 'published', outcome: {remotePostId: match.id, remoteUrl: `https://www.facebook.com/${match.id}`}}
        : {state: 'unknown'};
    } catch {
      return {state: 'unknown'};
    }
  }
}

export class InstagramAdapter implements PlatformAdapter {
  private igUser(account: SocialAccount) {
    return encodeURIComponent(account.platformAccountId);
  }

  async publish(account: SocialAccount, token: string, content: PublishContent, hooks: PublishHooks): Promise<PublishOutcome> {
    const images = content.media.filter(item => item.mimeType.startsWith('image/'));
    const video = content.media.find(item => item.mimeType.startsWith('video/'));
    if (video && images.length === 0) {
      return this.publishContainer(
        account,
        token,
        {media_type: 'REELS', video_url: video.url, caption: content.text, share_to_feed: 'true'},
        hooks,
        40,
      );
    }
    if (images.length > 1) {
      const children: string[] = [];
      for (const image of images.slice(0, 10)) {
        const child = await graphRequest<{id: string}>('POST', `/${this.igUser(account)}/media`, token, {
          image_url: image.url,
          is_carousel_item: 'true',
        });
        await hooks.onContainer?.(child.id);
        await this.waitUntilReady(child.id, token, 20);
        children.push(child.id);
      }
      return this.publishContainer(
        account,
        token,
        {media_type: 'CAROUSEL', children: children.join(','), caption: content.text},
        hooks,
        20,
      );
    }
    const image = images[0];
    if (!image) {
      throw new PlatformError('Instagram posts need an image or a video.', 'permanent', 'no_media');
    }
    return this.publishContainer(account, token, {image_url: image.url, caption: content.text}, hooks, 15);
  }

  private async publishContainer(
    account: SocialAccount,
    token: string,
    params: Record<string, string>,
    hooks: PublishHooks,
    attempts: number,
  ): Promise<PublishOutcome> {
    const container = await graphRequest<{id: string}>('POST', `/${this.igUser(account)}/media`, token, params);
    await hooks.onContainer?.(container.id);
    await this.waitUntilReady(container.id, token, attempts);
    const published = await graphRequest<{id: string}>('POST', `/${this.igUser(account)}/media_publish`, token, {
      creation_id: container.id,
    });
    return {remotePostId: published.id, remoteUrl: await this.permalink(published.id, token)};
  }

  private async waitUntilReady(containerId: string, token: string, attempts = 15) {
    for (let i = 0; i < attempts; i++) {
      const res = await graphRequest<{status_code?: string}>('GET', `/${encodeURIComponent(containerId)}`, token, {
        fields: 'status_code',
      });
      if (res.status_code === 'FINISHED') return;
      if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
        throw new PlatformError(`Instagram could not process the image (${res.status_code}).`, 'permanent', `container_${res.status_code}`);
      }
      await sleep(2000);
    }
    throw new PlatformError('Instagram is still processing the image.', 'transient', 'container_in_progress');
  }

  private async permalink(mediaId: string, token: string) {
    try {
      const res = await graphRequest<{permalink?: string}>('GET', `/${encodeURIComponent(mediaId)}`, token, {fields: 'permalink'});
      return res.permalink || null;
    } catch {
      return null;
    }
  }

  async reconcile(
    account: SocialAccount,
    token: string,
    content: PublishContent,
    since: Date,
    containerId: string | null,
  ): Promise<ReconcileResult> {
    try {
      if (containerId) {
        const container = await graphRequest<{status_code?: string}>('GET', `/${encodeURIComponent(containerId)}`, token, {
          fields: 'status_code',
        });
        // A container that is FINISHED but not PUBLISHED provably never went live.
        if (container.status_code === 'FINISHED' || container.status_code === 'ERROR' || container.status_code === 'EXPIRED') {
          return {state: 'not_published'};
        }
        if (container.status_code !== 'PUBLISHED') {
          return {state: 'unknown'};
        }
      }
      const res = await graphRequest<{data?: {id: string; caption?: string; timestamp?: string; permalink?: string}[]}>(
        'GET',
        `/${this.igUser(account)}/media`,
        token,
        {fields: 'id,caption,timestamp,permalink', limit: '10'},
      );
      const match = (res.data || []).find(
        m => sameText(m.caption, content.text) && (!m.timestamp || new Date(m.timestamp).getTime() >= since.getTime() - 120_000),
      );
      return match
        ? {state: 'published', outcome: {remotePostId: match.id, remoteUrl: match.permalink || null}}
        : {state: containerId ? 'unknown' : 'not_published'};
    } catch {
      return {state: 'unknown'};
    }
  }
}

/** Adapter lookup; overridden in tests with fakes. */
@Injectable()
export class PlatformAdapters {
  private readonly adapters: Partial<Record<SocialPlatform, PlatformAdapter>> = {
    FACEBOOK: new FacebookAdapter(),
    INSTAGRAM: new InstagramAdapter(),
  };

  get(platform: SocialPlatform): PlatformAdapter | null {
    return this.adapters[platform] || null;
  }
}
