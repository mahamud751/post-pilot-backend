import {Module} from '@nestjs/common';
import {AiModule} from '../ai/ai.module';
import {EngagementController} from '../engagement/engagement.controller';
import {EngagementService} from '../engagement/engagement.service';
import {MetaWebhookController} from '../engagement/meta-webhook.controller';
import {IntelligenceModule} from '../intelligence/intelligence.module';
import {PostsModule} from '../posts/posts.module';
import {AutopilotSchedulerService} from './autopilot-scheduler.service';
import {AutopilotController} from './autopilot.controller';
import {AutopilotService} from './autopilot.service';
import {ConversionsController} from './conversions.controller';

@Module({
  imports: [AiModule, PostsModule, IntelligenceModule],
  controllers: [AutopilotController, ConversionsController, EngagementController, MetaWebhookController],
  providers: [AutopilotService, AutopilotSchedulerService, EngagementService],
})
export class AutopilotModule {}
