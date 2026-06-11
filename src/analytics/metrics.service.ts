import {Injectable} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {FacebookInsightsService} from './facebook-insights.service';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly facebookInsights: FacebookInsightsService,
  ) {}

  async computeForUser(userId: string) {
    const user = await this.prisma.user.findUnique({where: {id: userId}});
    const posts = await this.prisma.post.findMany({
      where: {userId},
      orderBy: {updatedAt: 'desc'},
    });

    const scheduled = posts.filter(p => p.status === 'scheduled').length;
    const drafts = posts.filter(p => p.status === 'draft').length;
    const published = posts.filter(p => p.status === 'published').length;
    const failed = posts.filter(p => p.status === 'failed').length;

    await this.syncFacebookPostMetrics(
      posts,
      user?.facebookPageAccessToken || null,
    );

    const refreshedPosts = await this.prisma.post.findMany({where: {userId}});

    const postReach = refreshedPosts.reduce((s, p) => s + (p.reach || 0), 0);
    const postEngagements = refreshedPosts.reduce(
      (s, p) => s + (p.engagements || 0),
      0,
    );
    const postClicks = refreshedPosts.reduce((s, p) => s + (p.clicks || 0), 0);

    let reach = postReach;
    let engagements = postEngagements;
    let clicks = postClicks;
    let followers = 0;
    let engagementRate = 0;
    let weeklyChart = this.buildPostsWeeklyChart(refreshedPosts);
    let dataSource: 'facebook' | 'posts' = 'posts';

    if (user?.facebookPageId && user?.facebookPageAccessToken) {
      const fb = await this.facebookInsights.getPageSummary(
        user.facebookPageId,
        user.facebookPageAccessToken,
      );
      const fbChart = await this.facebookInsights.getDailyReachChart(
        user.facebookPageId,
        user.facebookPageAccessToken,
      );

      if (fb.reach > 0 || fb.followers > 0) {
        dataSource = 'facebook';
        reach = Math.max(fb.reach, postReach);
        engagements = Math.max(fb.engagements, postEngagements);
        clicks = Math.max(fb.clicks, postClicks);
        followers = fb.followers;
        engagementRate = fb.engagementRate;
      }

      if (fbChart.length > 0) {
        weeklyChart = fbChart.map(d => ({label: d.label, value: d.value}));
      }
    }

    if (engagementRate === 0 && reach > 0) {
      engagementRate = Number(((engagements / reach) * 100).toFixed(1));
    }

    const platformBreakdown = this.platformBreakdown(refreshedPosts);

    return {
      summary: {
        totalPosts: posts.length,
        scheduled,
        drafts,
        published,
        failed,
        reach,
        engagementRate,
        clicks,
        followers,
        engagements,
      },
      weeklyChart,
      platformBreakdown,
      dataSource,
    };
  }

  private async syncFacebookPostMetrics(
    posts: {
      id: string;
      facebookPostId: string | null;
      status: string;
    }[],
    pageAccessToken: string | null,
  ) {
    if (!pageAccessToken) {
      return;
    }

    const publishedWithFb = posts.filter(
      p => p.status === 'published' && p.facebookPostId,
    );

    for (const post of publishedWithFb.slice(0, 20)) {
      const metrics = await this.facebookInsights.getPostMetrics(
        post.facebookPostId!,
        pageAccessToken,
      );
      if (metrics.reach > 0 || metrics.engagements > 0 || metrics.clicks > 0) {
        await this.prisma.post.update({
          where: {id: post.id},
          data: {
            reach: metrics.reach,
            engagements: metrics.engagements,
            clicks: metrics.clicks,
          },
        });
      }
    }
  }

  private buildPostsWeeklyChart(
    posts: {status: string; updatedAt: Date; reach: number}[],
  ) {
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
        bucket.value += post.reach > 0 ? post.reach : 1;
      }
    }

    return buckets.map(b => ({label: b.label, value: b.value}));
  }

  private platformBreakdown(
    posts: {platforms: string[]; reach: number; engagements: number}[],
  ) {
    const counts: Record<string, {posts: number; reach: number; engagements: number}> =
      {
        facebook: {posts: 0, reach: 0, engagements: 0},
        instagram: {posts: 0, reach: 0, engagements: 0},
        youtube: {posts: 0, reach: 0, engagements: 0},
      };

    for (const post of posts) {
      for (const platform of post.platforms || []) {
        const key = platform.toLowerCase();
        if (!counts[key]) {
          counts[key] = {posts: 0, reach: 0, engagements: 0};
        }
        counts[key].posts += 1;
        counts[key].reach += post.reach || 0;
        counts[key].engagements += post.engagements || 0;
      }
    }

    return Object.entries(counts).map(([platform, data]) => ({
      platform,
      ...data,
    }));
  }
}
