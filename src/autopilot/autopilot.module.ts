import {Module} from '@nestjs/common';
import {AiModule} from '../ai/ai.module';
import {IntelligenceModule} from '../intelligence/intelligence.module';
import {PostsModule} from '../posts/posts.module';
import {AutopilotSchedulerService} from './autopilot-scheduler.service';
import {AutopilotController} from './autopilot.controller';
import {AutopilotService} from './autopilot.service';
import {ConversionsController} from './conversions.controller';

@Module({
  imports: [AiModule, PostsModule, IntelligenceModule],
  controllers: [AutopilotController, ConversionsController],
  providers: [AutopilotService, AutopilotSchedulerService],
})
export class AutopilotModule {}
