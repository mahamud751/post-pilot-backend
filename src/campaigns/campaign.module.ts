import {Module} from '@nestjs/common';
import {AiModule} from '../ai/ai.module';
import {AiProviderRegistry} from '../ai/ai-provider';
import {IntelligenceModule} from '../intelligence/intelligence.module';
import {PostsModule} from '../posts/posts.module';
import {CampaignController} from './campaign.controller';
import {CampaignService} from './campaign.service';
import {CampaignWorkerService} from './campaign-worker.service';

@Module({
  imports: [AiModule, IntelligenceModule, PostsModule],
  controllers: [CampaignController],
  providers: [CampaignService, CampaignWorkerService, AiProviderRegistry],
  exports: [CampaignService],
})
export class CampaignModule {}
