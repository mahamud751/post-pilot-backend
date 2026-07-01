import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
import {CreatePostDto} from './dto/create-post.dto';
import {UpdatePostDto} from './dto/update-post.dto';
import {assertSchedulableTime, parseScheduledAt} from './schedule-time';

@Injectable()
export class PostsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
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

  async create(userId: string, input: CreatePostDto) {
    const scheduledAt = parseScheduledAt(input.scheduledAt);
    if (input.status === 'scheduled') {
      if (!scheduledAt) {
        throw new BadRequestException('Scheduled posts require a valid scheduledAt time.');
      }
      try {
        assertSchedulableTime(scheduledAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid schedule time.';
        throw new BadRequestException(message);
      }
    }

    const post = await this.prisma.post.create({
      data: {
        userId,
        caption: input.caption,
        mediaUrl: input.mediaUrl,
        thumbnailUrl: input.thumbnailUrl,
        mediaType: input.mediaType,
        platforms: input.platforms || [],
        status: input.status || 'draft',
        scheduledAt,
      },
    });

    if (post.status === 'scheduled' && post.scheduledAt) {
      await this.notify(userId, {
        type: 'post_scheduled',
        title: 'Post scheduled',
        body: `Your post is scheduled for ${post.scheduledAt.toLocaleString('en-BD', {timeZone: 'Asia/Dhaka'})}.`,
        meta: {postId: post.id},
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

    const scheduledAt =
      input.scheduledAt !== undefined ? parseScheduledAt(input.scheduledAt) : undefined;
    const nextStatus = input.status ?? exists.status;

    if (nextStatus === 'scheduled' && scheduledAt) {
      try {
        assertSchedulableTime(scheduledAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid schedule time.';
        throw new BadRequestException(message);
      }
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
        scheduledAt,
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

