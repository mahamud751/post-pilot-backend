import {Module} from '@nestjs/common';
import {SocialPublishModule} from '../social-publish/social-publish.module';
import {PostsController} from './posts.controller';
import {PostsService} from './posts.service';

@Module({
  imports: [SocialPublishModule],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}

