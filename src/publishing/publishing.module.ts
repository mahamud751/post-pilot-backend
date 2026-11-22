import {Global, Module} from '@nestjs/common';
import {PlatformAdapters} from './adapters';
import {PublishQueueService} from './publish-queue.service';
import {PublishWorkerService} from './publish-worker.service';
import {PublisherService} from './publisher.service';
import {HealthService} from './health.service';

@Global()
@Module({
  providers: [PlatformAdapters, PublishQueueService, PublisherService, PublishWorkerService, HealthService],
  exports: [PublishQueueService, PublisherService, PublishWorkerService, PlatformAdapters, HealthService],
})
export class PublishingModule {}
