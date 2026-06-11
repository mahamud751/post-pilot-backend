import {Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {MetricsService} from '../analytics/metrics.service';
import {NotificationsService} from '../notifications/notifications.service';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly metricsService: MetricsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getDashboard(userId: string) {
    const posts = await this.prisma.post.findMany({
      where: {userId},
      orderBy: {createdAt: 'desc'},
    });

    const metrics = await this.metricsService.computeForUser(userId);
    const unreadCount = await this.notificationsService.unreadCount(userId);
    const totalWeeklyReach = metrics.weeklyChart.reduce(
      (sum, d) => sum + d.value,
      0,
    );

    return {
      stats: {
        scheduled: metrics.summary.scheduled,
        published: metrics.summary.published,
        drafts: metrics.summary.drafts,
        failed: metrics.summary.failed,
        reach: metrics.summary.reach,
        engagementRate: metrics.summary.engagementRate,
        clicks: metrics.summary.clicks,
        followers: metrics.summary.followers,
        totalPosts: metrics.summary.totalPosts,
      },
      analyticsPreview: {
        totalReach: totalWeeklyReach,
        weeklyChart: metrics.weeklyChart,
        dayLabels: metrics.weeklyChart.map(d => d.label),
      },
      unreadNotifications: unreadCount,
      dataSource: metrics.dataSource,
      recentPosts: posts.slice(0, 5).map(p => ({
        id: p.id,
        caption: p.caption,
        status: p.status,
        platforms: p.platforms,
        scheduledAt: p.scheduledAt,
        createdAt: p.createdAt,
        reach: p.reach,
        engagements: p.engagements,
      })),
    };
  }
}
