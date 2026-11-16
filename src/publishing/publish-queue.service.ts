import {Injectable, Logger, OnModuleDestroy} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Queue} from 'bullmq';

export const PUBLISH_QUEUE = 'postpilot-publish';

export type PublishJob = {targetId: string; jobToken: string};

export function redisConnection(config: ConfigService) {
  const url = new URL(config.get<string>('REDIS_URL') || 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

/** Delayed BullMQ jobs, one per (target, schedule token). */
@Injectable()
export class PublishQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PublishQueueService.name);
  readonly queue: Queue<PublishJob>;

  constructor(config: ConfigService) {
    this.queue = new Queue<PublishJob>(PUBLISH_QUEUE, {
      connection: redisConnection(config),
      prefix: config.get<string>('QUEUE_PREFIX') || 'postpilot',
    });
    this.queue.on('error', error => this.logger.error(`Queue error: ${error.message}`));
  }

  static jobId(targetId: string, jobToken: string) {
    return `${targetId}-${jobToken}`;
  }

  /**
   * Never throws: if Redis is unavailable the recovery sweep enqueues the job later. The job id
   * is deterministic, so enqueuing the same target and token twice adds one job.
   */
  async enqueue(targetId: string, jobToken: string, runAt: Date) {
    try {
      await this.queue.add(
        'publish',
        {targetId, jobToken},
        {
          jobId: PublishQueueService.jobId(targetId, jobToken),
          delay: Math.max(0, runAt.getTime() - Date.now()),
          attempts: 1,
          removeOnComplete: {count: 1000},
          removeOnFail: {count: 5000},
        },
      );
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Enqueue failed for target ${targetId}; the recovery sweep will retry: ${message}`);
      return false;
    }
  }

  async remove(targetId: string, jobToken: string | null) {
    if (!jobToken) {
      return;
    }
    try {
      await this.queue.remove(PublishQueueService.jobId(targetId, jobToken));
    } catch {
      // A job that is already running or gone is fine: its token no longer matches.
    }
  }

  async counts() {
    return this.queue.getJobCounts('waiting', 'delayed', 'active', 'completed', 'failed');
  }

  async onModuleDestroy() {
    await this.queue.close();
  }
}
