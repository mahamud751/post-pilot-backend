import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {NotificationsService} from '../notifications/notifications.service';
import {formatScheduledAtBd} from '../posts/schedule-time';
import {PrismaService} from '../prisma/prisma.service';
import {SocialPublishService} from '../social-publish/social-publish.service';

const PUBLISH_INTERVAL_MS = 15_000;

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
    private readonly socialPublish: SocialPublishService,
  ) {}

  onModuleInit() {
    this.publishDuePosts().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Initial scheduled publish check failed: ${message}`);
    });

    this.timer = setInterval(() => {
      this.publishDuePosts().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Scheduled publish loop failed: ${message}`);
      });
    }, PUBLISH_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  findUpcoming(userId: string) {
    return this.prisma.post.findMany({
      where: {
        userId,
        status: 'scheduled',
        scheduledAt: {gte: new Date()},
      },
      orderBy: {scheduledAt: 'asc'},
    });
  }

  private async notify(
    userId: string,
    input: {type: string; title: string; body: string; meta?: Record<string, unknown>},
  ) {
    try {
      await this.notificationsService.create(userId, input);
    } catch {
      // notifications table may not exist yet
    }
  }

  private async publishDuePosts() {
    const duePosts = await this.prisma.post.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: {lte: new Date()},
      },
      include: {user: true},
      orderBy: {scheduledAt: 'asc'},
      take: 25,
    });

    for (const post of duePosts) {
      this.logger.log(
        `Publishing scheduled post ${post.id} (due ${formatScheduledAtBd(post.scheduledAt!)}, now ${formatScheduledAtBd(new Date())})`,
      );

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
        continue;
      }

      const pageId = post.user.facebookPageId;
      const pageAccessToken = post.user.facebookPageAccessToken;
      if (!pageId || !pageAccessToken) {
        await this.prisma.post.update({
          where: {id: post.id},
          data: {status: 'failed'},
        });
        await this.notify(post.userId, {
          type: 'post_failed',
          title: 'Publish failed',
          body: 'Facebook page is not connected. Re-verify your account.',
          meta: {postId: post.id},
        });
        continue;
      }

      const publishInput = {
        caption: post.caption || '',
        mediaUrl: post.mediaUrl,
        mediaType: post.mediaType,
      };

      const results = await this.socialPublish.publishToPlatforms(
        platforms,
        {
          facebookPageId: post.user.facebookPageId,
          facebookPageAccessToken: post.user.facebookPageAccessToken,
          instagramBusinessAccountId: post.user.instagramBusinessAccountId,
        },
        publishInput,
      );

      const successes = results.filter(r => r.externalPostId && !r.error);
      const errors = results.filter(r => r.error).map(r => `${r.platform}: ${r.error}`);

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
        this.logger.warn(`Failed publishing post ${post.id}: ${errors.join(' | ')}`);
        continue;
      }

      const facebookResult = successes.find(r => r.platform === 'facebook');

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

      const publishedNames = successes.map(r => r.platform).join(', ');
      await this.notify(post.userId, {
        type: 'post_published',
        title: 'Post published',
        body: `Published to ${publishedNames}.`,
        meta: {postId: post.id, platforms: successes},
      });

      if (errors.length > 0) {
        this.logger.warn(
          `Post ${post.id} partially published. Errors: ${errors.join(' | ')}`,
        );
      }
    }
  }
}
