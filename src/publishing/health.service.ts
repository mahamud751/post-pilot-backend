import {Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {PublishQueueService} from './publish-queue.service';

/** A dependency outage must not leave health requests waiting for Redis reconnection. */
export async function bounded<T>(operation: Promise<T>, timeoutMs = 2500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService, private readonly publishing: PublishQueueService) {}

  async readiness() {
    const [db, redis, workers] = await Promise.allSettled([
      bounded(this.prisma.$queryRaw`SELECT 1`),
      bounded(this.publishing.queue.client.then(client => client.ping())),
      bounded(this.publishing.queue.getWorkers()),
    ]);
    const checks = {
      database: db.status === 'fulfilled',
      redis: redis.status === 'fulfilled',
      worker: workers.status === 'fulfilled' && workers.value.length > 0,
    };
    return {ok: Object.values(checks).every(Boolean), checks, checkedAt: new Date().toISOString()};
  }

  async workspace(workspaceId: string) {
    const late = new Date(Date.now() - 5 * 60_000);
    const [readiness, overdue, stuck, failed, expiring, review, inbox] = await Promise.all([
      this.readiness(),
      this.prisma.postTarget.count({where: {post: {workspaceId}, status: 'SCHEDULED', scheduledAt: {lt: late}, OR: [{nextAttemptAt: null}, {nextAttemptAt: {lt: late}}]}}),
      this.prisma.postTarget.count({where: {post: {workspaceId}, status: 'PROCESSING', updatedAt: {lt: new Date(Date.now() - 10 * 60_000)}}}),
      this.prisma.postTarget.count({where: {post: {workspaceId}, status: {in: ['FAILED', 'NEEDS_ACTION']}}}),
      this.prisma.socialAccount.count({where: {workspaceId, status: {not: 'REVOKED'}, OR: [{status: {not: 'CONNECTED'}}, {expiresAt: {lte: new Date(Date.now() + 7 * 86_400_000)}}]}}),
      this.prisma.post.count({where: {workspaceId, status: 'in_review'}}),
      this.prisma.engagementItem.count({where: {workspaceId, status: {in: ['NEW', 'NEEDS_HUMAN', 'FAILED']}}}),
    ]);
    return {...readiness, overdue, stuck, failed, expiring, review, inbox};
  }
}
