import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {SocialPlatform} from '@prisma/client';
import {createHash, randomBytes, timingSafeEqual} from 'crypto';
import {BrandService} from '../brand/brand.service';
import {PrismaService} from '../prisma/prisma.service';
import {graphRequest, PlatformError} from '../social/meta-graph';
import {SocialAccountsService} from '../social/social-accounts.service';

const ID_PATTERN = /^[A-Za-z0-9._-]{2,100}$/;

export function normalizeWatchId(raw: string) {
  const trimmed = raw.trim();
  const fromUrl =
    trimmed.match(/facebook\.com\/(?:pages\/[^/]+\/)?([^/?#]+)/i)?.[1] ||
    trimmed.match(/instagram\.com\/([^/?#]+)/i)?.[1];
  const id = (fromUrl || trimmed).replace(/^@/, '').replace(/\/$/, '');
  if (!ID_PATTERN.test(id) || id === 'p' || id === 'reel' || id === 'stories') {
    throw new BadRequestException('Use a page id, a username, or the public page URL.');
  }
  return id;
}

function hashKey(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class ResearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brand: BrandService,
    private readonly accounts: SocialAccountsService,
  ) {}

  /** Public news headlines for the brand niche. Does not read other people's private Page insights. */
  async refreshTrends(workspaceId: string) {
    const [brand, workspace] = await Promise.all([
      this.brand.get(workspaceId),
      this.prisma.workspace.findUnique({where: {id: workspaceId}, select: {businessType: true}}),
    ]);
    const generic = /^(my brand|brand|business|workspace|company|test)$/i;
    const topic = [workspace?.businessType, brand.audience, brand.name]
      .flatMap(value => {
        const trimmed = value?.trim() || '';
        return trimmed && !generic.test(trimmed) ? [trimmed] : [];
      })
      .join(' ')
      .replace(/\s+/g, ' ')
      .slice(0, 120);
    if (!topic.trim()) {
      return {count: 0, topic: '', error: 'Add a business type or audience so trend search has a topic.'};
    }
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en&gl=BD&ceid=BD:en`;
    let xml = '';
    try {
      const response = await fetch(url, {
        headers: {'User-Agent': 'PostPilot/1.0'},
        signal: AbortSignal.timeout(12_000),
      });
      if (!response.ok) {
        return {count: 0, topic, error: `News search returned ${response.status}.`};
      }
      xml = await response.text();
    } catch (error) {
      return {count: 0, topic, error: error instanceof Error ? error.message : 'News search failed.'};
    }
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 8).flatMap(match => {
      const block = match[1];
      const title = decodeXml(block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
      const link = decodeXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '').trim();
      if (!title) return [];
      return [{title: title.slice(0, 300), url: link.slice(0, 500) || null}];
    });
    await this.prisma.trendSignal.deleteMany({where: {workspaceId}});
    if (items.length) {
      await this.prisma.trendSignal.createMany({
        data: items.map(item => ({workspaceId, source: 'google_news', title: item.title, url: item.url, topic})),
      });
    }
    return {count: items.length, topic, error: items.length ? undefined : 'The news search returned no headlines.'};
  }

  async addCompetitor(workspaceId: string, platform: SocialPlatform, rawId: string) {
    if (platform !== 'FACEBOOK' && platform !== 'INSTAGRAM') {
      throw new BadRequestException('Competitor watch supports Facebook Pages and Instagram professional accounts.');
    }
    const externalId = normalizeWatchId(rawId);
    const row = await this.prisma.competitorAccount.upsert({
      where: {workspaceId_platform_externalId: {workspaceId, platform, externalId}},
      create: {workspaceId, platform, externalId, name: externalId},
      update: {},
    });
    await this.refreshCompetitor(row.id, workspaceId);
    return this.listCompetitors(workspaceId);
  }

  async removeCompetitor(workspaceId: string, id: string) {
    const deleted = await this.prisma.competitorAccount.deleteMany({where: {id, workspaceId}});
    if (!deleted.count) throw new NotFoundException('Competitor not found');
    return {ok: true};
  }

  async refreshCompetitors(workspaceId: string) {
    const rows = await this.prisma.competitorAccount.findMany({where: {workspaceId}});
    for (const row of rows) {
      await this.refreshCompetitor(row.id, workspaceId);
    }
    return this.listCompetitors(workspaceId);
  }

  async listCompetitors(workspaceId: string) {
    const rows = await this.prisma.competitorAccount.findMany({
      where: {workspaceId},
      orderBy: {createdAt: 'desc'},
      include: {signals: {orderBy: {postedAt: 'desc'}, take: 3}},
    });
    return rows.map(row => ({
      id: row.id,
      platform: row.platform,
      externalId: row.externalId,
      name: row.name,
      audienceCount: row.audienceCount,
      status: row.status,
      statusReason: row.statusReason,
      lastCheckedAt: row.lastCheckedAt,
      signals: row.signals.map(signal => ({
        text: signal.text,
        permalink: signal.permalink,
        mediaType: signal.mediaType,
        postedAt: signal.postedAt,
        likes: signal.likes,
        comments: signal.comments,
        shares: signal.shares,
      })),
    }));
  }

  async listTrends(workspaceId: string) {
    return this.prisma.trendSignal.findMany({
      where: {workspaceId},
      orderBy: {fetchedAt: 'desc'},
      take: 8,
      select: {id: true, source: true, title: true, url: true, topic: true, fetchedAt: true},
    });
  }

  /** Text for the model. Counts appear only when the official API returned them. */
  async contextBlock(workspaceId: string) {
    const [trends, competitors] = await Promise.all([this.listTrends(workspaceId), this.listCompetitors(workspaceId)]);
    const lines: string[] = [];
    if (trends.length) {
      lines.push(`PUBLIC NEWS for "${trends[0].topic}" (headlines only, not social reach):`);
      for (const trend of trends.slice(0, 5)) lines.push(`- ${trend.title}`);
    }
    const readable = competitors.filter(row => row.status === 'ok' && row.signals.length);
    if (readable.length) {
      lines.push('COMPETITORS the workspace asked to watch, via the official API only:');
      for (const row of readable.slice(0, 4)) {
        const sample = row.signals[0];
        const counts = [
          sample.likes != null ? `${sample.likes} likes` : null,
          sample.comments != null ? `${sample.comments} comments` : null,
        ].filter(Boolean);
        lines.push(`- ${row.name} (${row.platform}): ${(sample.text || '').slice(0, 140)}${counts.length ? ` [${counts.join(', ')}]` : ''}`);
      }
    }
    if (!lines.length) return '';
    lines.push('Use these only as topic ideas. Do not claim you measured their reach, and do not copy their caption.');
    return lines.join('\n');
  }

  async issueConversionKey(workspaceId: string) {
    await this.ensureConfig(workspaceId);
    const raw = randomBytes(24).toString('base64url');
    await this.prisma.autopilotConfig.update({
      where: {workspaceId},
      data: {conversionKeyHash: hashKey(raw)},
    });
    return {key: raw};
  }

  async recordSale(
    workspaceId: string,
    input: {amount: number; currency?: string; quantity?: number; postId?: string; externalRef?: string; note?: string; occurredAt?: string},
    source: 'manual' | 'webhook',
  ) {
    const amount = Math.round(input.amount * 100);
    if (!Number.isFinite(amount) || amount < 0 || amount > 100_000_000_00) {
      throw new BadRequestException('Amount must be a non-negative number.');
    }
    if (input.postId) {
      const post = await this.prisma.post.findFirst({where: {id: input.postId, workspaceId}, select: {id: true}});
      if (!post) throw new BadRequestException('That post is not in this workspace.');
    }
    const externalRef = input.externalRef?.trim().slice(0, 120) || null;
    if (externalRef) {
      const existing = await this.prisma.sale.findUnique({where: {workspaceId_externalRef: {workspaceId, externalRef}}});
      if (existing) return {sale: existing, duplicate: true};
    }
    const sale = await this.prisma.sale.create({
      data: {
        workspaceId,
        postId: input.postId || null,
        amount,
        currency: (input.currency || 'BDT').slice(0, 8).toUpperCase(),
        quantity: Math.min(Math.max(Math.round(input.quantity || 1), 1), 10000),
        source,
        externalRef,
        note: input.note?.slice(0, 300) || null,
        occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      },
    });
    return {sale, duplicate: false};
  }

  async workspaceForConversionKey(raw: string) {
    if (!raw) return null;
    const hash = hashKey(raw);
    const config = await this.prisma.autopilotConfig.findUnique({where: {conversionKeyHash: hash}, select: {workspaceId: true, conversionKeyHash: true}});
    if (!config?.conversionKeyHash) return null;
    const a = Buffer.from(config.conversionKeyHash);
    const b = Buffer.from(hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return config.workspaceId;
  }

  async listSales(workspaceId: string) {
    const sales = await this.prisma.sale.findMany({
      where: {workspaceId},
      orderBy: {occurredAt: 'desc'},
      take: 30,
      select: {id: true, postId: true, amount: true, currency: true, quantity: true, source: true, note: true, occurredAt: true},
    });
    const total = sales.reduce((sum, sale) => sum + sale.amount, 0);
    return {sales, totalMinor: total};
  }

  private async ensureConfig(workspaceId: string) {
    const existing = await this.prisma.autopilotConfig.findUnique({where: {workspaceId}});
    if (existing) return existing;
    return this.prisma.autopilotConfig.create({data: {workspaceId}});
  }

  private async refreshCompetitor(id: string, workspaceId: string) {
    const row = await this.prisma.competitorAccount.findFirst({where: {id, workspaceId}});
    if (!row) return;
    const account = await this.prisma.socialAccount.findFirst({
      where: {workspaceId, status: 'CONNECTED', platform: row.platform === 'INSTAGRAM' ? 'INSTAGRAM' : 'FACEBOOK'},
      orderBy: {createdAt: 'asc'},
    });
    if (!account) {
      await this.prisma.competitorAccount.update({
        where: {id},
        data: {status: 'permission_required', statusReason: `Connect a ${row.platform === 'INSTAGRAM' ? 'Instagram professional' : 'Facebook Page'} account first.`, lastCheckedAt: new Date()},
      });
      return;
    }
    const token = this.accounts.accessToken(account);
    try {
      if (row.platform === 'FACEBOOK') {
        await this.readFacebook(row.id, row.externalId, token);
      } else {
        await this.readInstagram(row.id, account.platformAccountId, row.externalId, token);
      }
    } catch (error) {
      const message = error instanceof PlatformError ? error.message : error instanceof Error ? error.message : 'Meta refused the request';
      const permission = /permission|unsupported|does not exist|nonexisting/i.test(message);
      await this.prisma.competitorAccount.update({
        where: {id: row.id},
        data: {
          status: permission ? 'permission_required' : 'error',
          statusReason: message.replace(/access_token=[^&\s]+/gi, '').slice(0, 300),
          lastCheckedAt: new Date(),
        },
      });
    }
  }

  private async readFacebook(id: string, pageId: string, token: string) {
    const page = await graphRequest<{id?: string; name?: string; fan_count?: number}>('GET', `/${encodeURIComponent(pageId)}`, token, {
      fields: 'id,name,fan_count',
    });
    const posts = await graphRequest<{
      data?: {id: string; message?: string; created_time?: string; permalink_url?: string; shares?: {count?: number}; reactions?: {summary?: {total_count?: number}}; comments?: {summary?: {total_count?: number}}}[];
    }>('GET', `/${encodeURIComponent(page.id || pageId)}/published_posts`, token, {
      fields: 'id,message,created_time,permalink_url,shares,reactions.summary(true).limit(0),comments.summary(true).limit(0)',
      limit: '5',
    });
    await this.prisma.competitorSignal.deleteMany({where: {competitorId: id}});
    const data = posts.data || [];
    if (data.length) {
      await this.prisma.competitorSignal.createMany({
        data: data.map(post => ({
          competitorId: id,
          externalPostId: post.id,
          text: post.message?.slice(0, 500) || null,
          permalink: post.permalink_url || null,
          postedAt: post.created_time ? new Date(post.created_time) : null,
          likes: post.reactions?.summary?.total_count ?? null,
          comments: post.comments?.summary?.total_count ?? null,
          shares: post.shares?.count ?? null,
        })),
      });
    }
    await this.prisma.competitorAccount.update({
      where: {id},
      data: {name: page.name || pageId, audienceCount: page.fan_count ?? null, status: 'ok', statusReason: null, lastCheckedAt: new Date()},
    });
  }

  private async readInstagram(id: string, igUserId: string, username: string, token: string) {
    const discovery = await graphRequest<{
      business_discovery?: {
        name?: string;
        username?: string;
        followers_count?: number;
        media?: {data?: {id: string; caption?: string; like_count?: number; comments_count?: number; permalink?: string; timestamp?: string; media_type?: string}[]};
      };
    }>('GET', `/${encodeURIComponent(igUserId)}`, token, {
      fields: `business_discovery.username(${username}){name,username,followers_count,media.limit(5){id,caption,like_count,comments_count,permalink,timestamp,media_type}}`,
    });
    const found = discovery.business_discovery;
    if (!found) {
      throw new PlatformError('Instagram business discovery returned no account. It must be a professional account.', 'permanent', 'no_discovery');
    }
    await this.prisma.competitorSignal.deleteMany({where: {competitorId: id}});
    const media = found.media?.data || [];
    if (media.length) {
      await this.prisma.competitorSignal.createMany({
        data: media.map(item => ({
          competitorId: id,
          externalPostId: item.id,
          text: item.caption?.slice(0, 500) || null,
          permalink: item.permalink || null,
          mediaType: item.media_type || null,
          postedAt: item.timestamp ? new Date(item.timestamp) : null,
          likes: item.like_count ?? null,
          comments: item.comments_count ?? null,
        })),
      });
    }
    await this.prisma.competitorAccount.update({
      where: {id},
      data: {
        name: found.name || found.username || username,
        audienceCount: found.followers_count ?? null,
        status: 'ok',
        statusReason: null,
        lastCheckedAt: new Date(),
      },
    });
  }
}

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
