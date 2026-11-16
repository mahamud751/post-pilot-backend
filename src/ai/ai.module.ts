import {Module} from '@nestjs/common';
import {PostsModule} from '../posts/posts.module';
import {IntelligenceModule} from '../intelligence/intelligence.module';
import {AiProviderRegistry} from './ai-provider';
import {AiController} from './ai.controller';
import {AiService} from './ai.service';

@Module({
  imports: [PostsModule, IntelligenceModule],
  controllers: [AiController],
  providers: [AiService, AiProviderRegistry],
  exports: [AiService],
})
export class AiModule {}
