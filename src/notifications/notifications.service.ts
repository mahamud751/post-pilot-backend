import {Injectable, NotFoundException} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  create(
    userId: string,
    input: {type: string; title: string; body: string; meta?: Record<string, unknown>},
  ) {
    return this.prisma.notification.create({
      data: {
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        meta: input.meta ?? undefined,
      },
    });
  }

  findAll(userId: string, limit = 30) {
    return this.prisma.notification.findMany({
      where: {userId},
      orderBy: {createdAt: 'desc'},
      take: limit,
    });
  }

  unreadCount(userId: string) {
    return this.prisma.notification.count({
      where: {userId, read: false},
    });
  }

  async markRead(userId: string, id: string) {
    const exists = await this.prisma.notification.findFirst({
      where: {id, userId},
    });
    if (!exists) {
      throw new NotFoundException('Notification not found');
    }
    return this.prisma.notification.update({
      where: {id},
      data: {read: true},
    });
  }

  markAllRead(userId: string) {
    return this.prisma.notification.updateMany({
      where: {userId, read: false},
      data: {read: true},
    });
  }
}
