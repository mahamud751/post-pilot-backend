import {Injectable, Logger} from '@nestjs/common';

const FB_GRAPH = 'https://graph.facebook.com/v21.0';

type InsightValue = {value?: number | string; end_time?: string};

@Injectable()
export class FacebookInsightsService {
  private readonly logger = new Logger(FacebookInsightsService.name);

  private async graphGet<T>(path: string, token: string): Promise<T | null> {
    try {
      const url = `${FB_GRAPH}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
      const response = await fetch(url);
      const payload = await response.json();
      if (!response.ok) {
        const message = (payload as {error?: {message?: string}})?.error?.message;
        this.logger.warn(`Facebook API ${path}: ${message || response.status}`);
        return null;
      }
      return payload as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Facebook API error ${path}: ${message}`);
      return null;
    }
  }

  async getPageSummary(pageId: string, pageAccessToken: string) {
    const page = await this.graphGet<{
      fan_count?: number;
      followers_count?: number;
      name?: string;
    }>(`/${encodeURIComponent(pageId)}?fields=fan_count,followers_count,name`, pageAccessToken);

    const insights = await this.graphGet<{
      data?: {name: string; values: InsightValue[]}[];
    }>(
      `/${encodeURIComponent(pageId)}/insights?metric=page_impressions_unique,page_post_engagements,page_views_total&period=days_28`,
      pageAccessToken,
    );

    const metric = (name: string) => {
      const row = insights?.data?.find(item => item.name === name);
      const values = row?.values || [];
      return values.reduce((sum, v) => sum + Number(v.value || 0), 0);
    };

    const reach = metric('page_impressions_unique');
    const engagements = metric('page_post_engagements');
    const clicks = metric('page_views_total');
    const followers = page?.followers_count ?? page?.fan_count ?? 0;

    return {
      reach,
      engagements,
      clicks,
      followers,
      engagementRate:
        reach > 0 ? Number(((engagements / reach) * 100).toFixed(1)) : 0,
    };
  }

  async getDailyReachChart(pageId: string, pageAccessToken: string) {
    const insights = await this.graphGet<{
      data?: {name: string; values: InsightValue[]}[];
    }>(
      `/${encodeURIComponent(pageId)}/insights?metric=page_impressions_unique&period=day`,
      pageAccessToken,
    );

    const row = insights?.data?.find(item => item.name === 'page_impressions_unique');
    const values = (row?.values || []).slice(-7);

    const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    return values.map(v => {
      const date = v.end_time ? new Date(v.end_time) : new Date();
      return {
        label: dayLabels[date.getDay()],
        value: Number(v.value || 0),
        date: date.toISOString().slice(0, 10),
      };
    });
  }

  async getPostMetrics(facebookPostId: string, pageAccessToken: string) {
    const insights = await this.graphGet<{
      data?: {name: string; values: InsightValue[]}[];
    }>(
      `/${encodeURIComponent(facebookPostId)}/insights?metric=post_impressions_unique,post_engaged_users,post_clicks`,
      pageAccessToken,
    );

    const latest = (name: string) => {
      const row = insights?.data?.find(item => item.name === name);
      const values = row?.values || [];
      const last = values[values.length - 1];
      return Number(last?.value || 0);
    };

    return {
      reach: latest('post_impressions_unique'),
      engagements: latest('post_engaged_users'),
      clicks: latest('post_clicks'),
    };
  }
}
