import {Module} from '@nestjs/common';
import {SocialPublishModule} from '../social-publish/social-publish.module';
import {ScheduleController} from './schedule.controller';
import {ScheduleService} from './schedule.service';

@Module({
  imports: [SocialPublishModule],
  controllers: [ScheduleController],
  providers: [ScheduleService],
})
export class ScheduleModule {}

