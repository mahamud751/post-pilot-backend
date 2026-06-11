import {Module} from '@nestjs/common';
import {AnalyticsController} from './analytics.controller';
import {AnalyticsService} from './analytics.service';
import {FacebookInsightsService} from './facebook-insights.service';
import {MetricsService} from './metrics.service';

@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService, MetricsService, FacebookInsightsService],
  exports: [MetricsService],
})
export class AnalyticsModule {}

