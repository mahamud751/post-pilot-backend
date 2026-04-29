import {Injectable, Logger, OnModuleDestroy, OnModuleInit} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';

@Injectable()
export class ScheduleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduleService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.publishDueFacebookPosts().catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Initial scheduled publish check failed: ${message}`);
    });

    this.timer = setInterval(() => {
      this.publishDueFacebookPosts().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Scheduled publish loop failed: ${message}`);
      });
    }, 60_000);
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

  private async publishDueFacebookPosts() {
    const duePosts = await this.prisma.post.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: {lte: new Date()},
        platforms: {has: 'facebook'},
      },
      include: {
        user: true,
      },
      orderBy: {scheduledAt: 'asc'},
      take: 25,
    });

    for (const post of duePosts) {
      const pageId = post.user.facebookPageId;
      const pageAccessToken = post.user.facebookPageAccessToken;
      if (!pageId || !pageAccessToken) {
        await this.prisma.post.update({
          where: {id: post.id},
          data: {status: 'failed'},
        });
        this.logger.warn(
          `Skipped scheduled Facebook post ${post.id}: missing page id/token for user ${post.userId}`,
        );
        continue;
      }

      const message = [post.caption || '', post.mediaUrl || '']
        .map(value => value.trim())
        .filter(Boolean)
        .join('\n\n');

      const body = new URLSearchParams({
        access_token: pageAccessToken,
      });
      if (message) {
        body.set('message', message);
      }

      const publishResponse = await fetch(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(pageId)}/feed`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/x-www-form-urlencoded'},
          body: body.toString(),
        },
      );
      const payload = await publishResponse.json().catch(() => ({}));

      if (!publishResponse.ok) {
        const errorMessage =
          (payload as {error?: {message?: string}})?.error?.message ||
          `Facebook publish failed (${publishResponse.status})`;
        await this.prisma.post.update({
          where: {id: post.id},
          data: {status: 'failed'},
        });
        this.logger.warn(`Failed publishing post ${post.id}: ${errorMessage}`);
        continue;
      }

      await this.prisma.post.update({
        where: {id: post.id},
        data: {
          status: 'published',
          scheduledAt: null,
        },
      });
    }
  }
}

