import {Injectable, NotFoundException} from '@nestjs/common';
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
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, input: CreatePostDto) {
    return this.prisma.post.create({
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

