import {Module} from '@nestjs/common';
import {PostsModule} from '../posts/posts.module';
import {DashboardController} from './dashboard.controller';
import {DashboardService} from './dashboard.service';

@Module({
  imports: [PostsModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
