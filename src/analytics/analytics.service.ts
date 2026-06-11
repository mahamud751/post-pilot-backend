import {Injectable} from '@nestjs/common';
import {MetricsService} from './metrics.service';

@Injectable()
export class AnalyticsService {
  constructor(private readonly metricsService: MetricsService) {}

  summary(userId: string) {
    return this.metricsService.computeForUser(userId);
  }
}
