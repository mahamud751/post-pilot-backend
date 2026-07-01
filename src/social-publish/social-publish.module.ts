import {Module} from '@nestjs/common';
import {SocialPublishService} from './social-publish.service';

@Module({
  providers: [SocialPublishService],
  exports: [SocialPublishService],
})
export class SocialPublishModule {}
