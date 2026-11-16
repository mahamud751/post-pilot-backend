import {Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {randomUUID} from 'crypto';
import {Worker} from 'bullmq';
import {PrismaService} from '../prisma/prisma.service';
import {PUBLISH_QUEUE, PublishJob, PublishQueueService, redisConnection} from './publish-queue.service';
import {PublisherService} from './publisher.service';

const SWEEP_INTERVAL_MS = 60_000;
/** A target PROCESSING this long was abandoned by a crashed worker. */
const STUCK_AFTER_MS = 10 * 60_000;

/**
 * Runs the BullMQ worker and the recovery sweep. Set PUBLISH_WORKER=off to run the API without
 * publishing, e.g. when a separate `npm run start:worker` process handles it.
 */
@Injectable()
export class PublishWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PublishWorkerService.name);
  private worker: Worker<PublishJob> | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly queue: PublishQueueService,
    private readonly publisher: PublisherService,
  ) {}

  enabled() {
    return this.config.get<string>('PUBLISH_WORKER') !== 'off';
  }

  onApplicationBootstrap() {
    if (!this.enabled()) {
      this.logger.log('Publish worker disabled (PUBLISH_WORKER=off)');
      return;
    }
    this.worker = new Worker<PublishJob>(
      PUBLISH_QUEUE,
      async job => this.publisher.process(job.data.targetId, job.data.jobToken),
      {
        connection: redisConnection(this.config),
        prefix: this.config.get<string>('QUEUE_PREFIX') || 'postpilot',
        concurrency: Number(this.config.get<string>('PUBLISH_CONCURRENCY') || 5),
      },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(`Publish job ${job?.id} crashed: ${error.message}`),
    );
    this.worker.on('error', error => this.logger.error(`Worker error: ${error.message}`));

    void this.sweep();
    this.sweepTimer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Re-enqueues due work the queue lost and recovers abandoned targets (TEST-03). */
  async sweep() {
    try {
      const soon = new Date(Date.now() + 2 * 60_000);
      const due = await this.prisma.postTarget.findMany({
        where: {
          status: 'SCHEDULED',
          OR: [{nextAttemptAt: {lte: soon}}, {nextAttemptAt: null, scheduledAt: {lte: soon}}],
        },
        select: {id: true, jobToken: true, scheduledAt: true, nextAttemptAt: true},
        take: 500,
      });
      for (const target of due) {
        let token = target.jobToken;
        if (!token) {
          // Targets scheduled before the queue existed have no token yet.
          token = randomUUID();
          const set = await this.prisma.postTarget.updateMany({
            where: {id: target.id, status: 'SCHEDULED', jobToken: null},
            data: {jobToken: token},
          });
          if (set.count === 0) continue;
        }
        await this.queue.enqueue(target.id, token, target.nextAttemptAt || target.scheduledAt || new Date());
      }

      const stuck = await this.prisma.postTarget.findMany({
        where: {status: 'PROCESSING', updatedAt: {lt: new Date(Date.now() - STUCK_AFTER_MS)}},
        select: {id: true},
        take: 100,
      });
      for (const target of stuck) {
        this.logger.warn(`Recovering target ${target.id} left processing by a stopped worker`);
        await this.publisher.recoverStuck(target.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Recovery sweep failed: ${message}`);
    }
  }

  async onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.worker?.close();
  }
}
