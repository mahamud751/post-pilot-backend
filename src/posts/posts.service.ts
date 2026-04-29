import {Injectable, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {CreatePostDto} from './dto/create-post.dto';
import {UpdatePostDto} from './dto/update-post.dto';

@Injectable()
export class PostsService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, input: CreatePostDto) {
    return this.prisma.post.create({
      data: {
        userId,
        caption: input.caption,
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        platforms: input.platforms || [],
        status: input.status || 'draft',
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : null,
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
        mediaType: input.mediaType,
        platforms: input.platforms,
        status: input.status,
        scheduledAt: input.scheduledAt ? new Date(input.scheduledAt) : undefined,
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

