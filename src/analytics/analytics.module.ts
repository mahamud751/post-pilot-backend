import {Module} from '@nestjs/common';
import {IntelligenceModule} from '../intelligence/intelligence.module';
import {AnalyticsController} from './analytics.controller';
import {AnalyticsService} from './analytics.service';

@Module({
  imports: [IntelligenceModule],
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
