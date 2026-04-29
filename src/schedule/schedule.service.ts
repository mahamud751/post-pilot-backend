import {Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';

@Injectable()
export class ScheduleService {
  constructor(private readonly prisma: PrismaService) {}

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
}

