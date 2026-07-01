import {Injectable, NotFoundException} from '@nestjs/common';
import {NotificationsService} from '../notifications/notifications.service';
import {PrismaService} from '../prisma/prisma.service';
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
  ) {}

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
      try {
        await this.notificationsService.create(userId, {
          type: 'post_scheduled',
          title: 'Post scheduled',
          body: `Your post is scheduled for ${post.scheduledAt.toLocaleString()}.`,
          meta: {postId: post.id},
        });
      } catch {
        // notifications table may not be migrated yet
      }
    } else if (post.status === 'published') {
      try {
        await this.notificationsService.create(userId, {
          type: 'post_published',
          title: 'Post published',
          body: 'Your post was published successfully.',
          meta: {postId: post.id},
        });
      } catch {
        // notifications table may not be migrated yet
      }
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

