import {Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {NotificationsService} from '../notifications/notifications.service';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationsService: NotificationsService,
  ) {}

  async getDashboard(userId: string) {
    const posts = await this.prisma.post.findMany({
      where: {userId},
      orderBy: {createdAt: 'desc'},
    });

    const scheduled = posts.filter(p => p.status === 'scheduled').length;
    const published = posts.filter(p => p.status === 'published').length;
    const drafts = posts.filter(p => p.status === 'draft').length;
    const failed = posts.filter(p => p.status === 'failed').length;

    const reach = Math.max(12000, published * 2100 + scheduled * 400);
    const engagementRate = Number(
      (3.2 + published * 0.13 + scheduled * 0.04).toFixed(1),
    );

    const weeklyChart = this.buildWeeklyChart(posts);
    const totalWeeklyReach = weeklyChart.reduce((sum, d) => sum + d.value, 0);
    const unreadCount = await this.notificationsService.unreadCount(userId);

    return {
      stats: {
        scheduled,
        published,
        drafts,
        failed,
        reach,
        engagementRate,
        totalPosts: posts.length,
      },
      analyticsPreview: {
        totalReach: totalWeeklyReach,
        weeklyChart,
        dayLabels: DAY_LABELS,
      },
      unreadNotifications: unreadCount,
      recentPosts: posts.slice(0, 5).map(p => ({
        id: p.id,
        caption: p.caption,
        status: p.status,
        platforms: p.platforms,
        scheduledAt: p.scheduledAt,
        createdAt: p.createdAt,
      })),
    };
  }

  private buildWeeklyChart(posts: {status: string; createdAt: Date; updatedAt: Date}[]) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(now.getDate() - 6);
    start.setHours(0, 0, 0, 0);

    const buckets = Array.from({length: 7}, (_, i) => {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      return {
        label: DAY_LABELS[day.getDay()],
        date: day.toISOString().slice(0, 10),
        value: 0,
      };
    });

    for (const post of posts) {
      if (post.status !== 'published') {
        continue;
      }
      const key = post.updatedAt.toISOString().slice(0, 10);
      const bucket = buckets.find(b => b.date === key);
      if (bucket) {
        bucket.value += 2100;
      }
    }

    const hasData = buckets.some(b => b.value > 0);
    if (!hasData) {
      return buckets.map((b, i) => ({
        label: b.label,
        value: 1200 + i * 350 + Math.floor(posts.length * 80),
      }));
    }

    return buckets.map(b => ({label: b.label, value: b.value}));
  }
}
