import {Injectable, NotFoundException} from '@nestjs/common';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import {SocialPublishService} from '../social-publish/social-publish.service';
import {CreatePostDto} from './dto/create-post.dto';
import {UpdatePostDto} from './dto/update-post.dto';

const HAS_EXPLICIT_TIMEZONE = /(Z|[+-]\d{2}:\d{2})$/;

const parseScheduledAt = (scheduledAt?: string) => {
  if (!scheduledAt) {
    return null;
  }

  // Keep explicit UTC/offset values untouched, otherwise treat as Bangladesh local time.
  const normalizedInput = HAS_EXPLICIT_TIMEZONE.test(scheduledAt)
    ? scheduledAt
    : `${scheduledAt}+06:00`;

  return new Date(normalizedInput);
};

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly socialPublish: SocialPublishService,
  ) {}

  private async notify(
    userId: string,
    input: {type: string; title: string; body: string; meta?: Record<string, unknown>},
  ) {
    try {
      await this.notificationsService.create(userId, input);
    } catch {
      // notifications table may not be migrated yet
    }
  }

  private async tryPublishImmediately(postId: string) {
    const post = await this.prisma.post.findUnique({
      where: {id: postId},
      include: {user: true},
    });
    if (!post || post.status !== 'scheduled' || !post.scheduledAt || post.scheduledAt > new Date()) {
      return;
    }

    const platforms = post.platforms || [];
    const needsSocial =
      platforms.includes('facebook') ||
      platforms.includes('instagram') ||
      platforms.includes('youtube');
    if (!needsSocial) {
      await this.prisma.post.update({
        where: {id: post.id},
        data: {status: 'published', scheduledAt: null},
      });
      return;
    }

    const results = await this.socialPublish.publishToPlatforms(
      platforms,
      {
        facebookPageId: post.user.facebookPageId,
        facebookPageAccessToken: post.user.facebookPageAccessToken,
        instagramBusinessAccountId: post.user.instagramBusinessAccountId,
      },
      {
        caption: post.caption || '',
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
      },
    );

    const successes = results.filter(r => r.externalPostId && !r.error);
    const errors = results.filter(r => r.error).map(r => `${r.platform}: ${r.error}`);
    const facebookResult = successes.find(r => r.platform === 'facebook');

    if (successes.length === 0) {
      await this.prisma.post.update({
        where: {id: post.id},
        data: {status: 'failed'},
      });
      await this.notify(post.userId, {
        type: 'post_failed',
        title: 'Publish failed',
        body: errors.join(' | ') || 'All platforms failed to publish.',
        meta: {postId: post.id},
      });
      return;
    }

    await this.prisma.post.update({
      where: {id: post.id},
      data: {
        status: 'published',
        scheduledAt: null,
        ...(facebookResult?.externalPostId
          ? {facebookPostId: facebookResult.externalPostId}
          : {}),
      },
    });

    await this.notify(post.userId, {
      type: 'post_published',
      title: 'Post published',
      body: `Published to ${successes.map(r => r.platform).join(', ')}.`,
      meta: {postId: post.id, platforms: successes},
    });
  }

  async create(userId: string, input: CreatePostDto) {
    const post = await this.prisma.post.create({
      data: {
        userId,
        caption: input.caption,
        mediaUrl: input.mediaUrl,
        thumbnailUrl: input.thumbnailUrl,
        mediaType: input.mediaType,
        platforms: input.platforms || [],
        status: input.status || 'draft',
        scheduledAt: parseScheduledAt(input.scheduledAt),
      },
    });

    if (post.status === 'scheduled' && post.scheduledAt) {
      await this.notify(userId, {
        type: 'post_scheduled',
        title: 'Post scheduled',
        body: `Your post is scheduled for ${post.scheduledAt.toLocaleString()}.`,
        meta: {postId: post.id},
      });
      this.tryPublishImmediately(post.id).catch(() => {
        // scheduler will retry
      });
    } else if (post.status === 'published') {
      await this.notify(userId, {
        type: 'post_published',
        title: 'Post published',
        body: 'Your post was published successfully.',
        meta: {postId: post.id},
      });
    }

    return post;
  }

  findAll(userId: string, status?: string) {
    return this.prisma.post.findMany({
      where: {userId, ...(status ? {status} : {})},
      orderBy: {createdAt: 'desc'},
    });
  }

  async update(userId: string, id: string, input: UpdatePostDto) {
    const exists = await this.prisma.post.findFirst({where: {id, userId}});
    if (!exists) {
      throw new NotFoundException('Post not found');
    }
    return this.prisma.post.update({
      where: {id},
      data: {
        caption: input.caption,
        mediaUrl: input.mediaUrl,
        thumbnailUrl: input.thumbnailUrl,
        mediaType: input.mediaType,
        platforms: input.platforms,
        status: input.status,
        scheduledAt:
          input.scheduledAt !== undefined
            ? parseScheduledAt(input.scheduledAt)
            : undefined,
      },
    });
  }

  async remove(userId: string, id: string) {
    const exists = await this.prisma.post.findFirst({where: {id, userId}});
    if (!exists) {
      throw new NotFoundException('Post not found');
    }
    await this.prisma.post.delete({where: {id}});
    return {ok: true};
  }
}

