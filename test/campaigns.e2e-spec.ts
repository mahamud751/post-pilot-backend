import {INestApplication} from '@nestjs/common';
import {randomUUID} from 'crypto';
import {
  CampaignService,
  campaignCreditEstimate,
} from '../src/campaigns/campaign.service';
import {CreativeService} from '../src/intelligence/creative.service';
import {PrismaService} from '../src/prisma/prisma.service';
import {Account, client, createApp, FakeAi, jpegBytes} from './helpers';

const nextDate = () =>
  new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
const goodOutput = () => ({
  items: ['FACEBOOK', 'INSTAGRAM'].map((platform) => ({
    platform,
    postIdea: 'A fresh daily idea',
    caption: 'Make a little room for something delicious.',
    contentPillar: 'brand',
    visualBrief: 'A welcoming restaurant table',
    hashtags: ['Cafe'],
    cta: 'Come say hello.',
    dayOffset: 0,
  })),
});

describe('Daily campaigns', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ai: FakeAi;
  let campaigns: CampaignService;
  let api: ReturnType<typeof client>['api'];
  let as: ReturnType<typeof client>['as'];
  let register: ReturnType<typeof client>['register'];

  beforeAll(async () => {
    ({app, prisma, ai} = await createApp());
    campaigns = app.get(CampaignService);
    ({api, as, register} = client(app));
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });
  beforeEach(() => {
    ai.next = goodOutput();
    ai.prompts = [];
  });

  async function setup(label: string, instagram = true) {
    const owner = await register(label + randomUUID().slice(0, 6));
    const platforms = instagram
      ? (['FACEBOOK', 'INSTAGRAM'] as const)
      : (['FACEBOOK'] as const);
    const accounts = await Promise.all(
      platforms.map((platform) =>
        prisma.socialAccount.create({
          data: {
            workspaceId: owner.workspaceId,
            platform,
            platformAccountId: randomUUID(),
            name: `${label} ${platform}`,
            accessTokenEnc: 'encrypted-test-token',
            status: 'CONNECTED',
            scopes: [],
          },
        }),
      ),
    );
    const upload = await api()
      .post('/v1/media/upload')
      .set(as(owner))
      .attach('file', jpegBytes(), {
        filename: 'food.jpg',
        contentType: 'image/jpeg',
      })
      .expect(201);
    return {owner, accounts, mediaId: upload.body.media.id as string};
  }
  function input(accountIds: string[], mediaId?: string, extra = {}) {
    return {
      name: 'Restaurant week',
      days: 7,
      startDate: nextDate(),
      postTime: '18:00',
      accountIds,
      mediaMode: mediaId ? 'UPLOAD' : 'TEXT',
      mediaIds: mediaId ? [mediaId] : [],
      autoSchedule: true,
      confirm: true,
      requestId: randomUUID(),
      ...extra,
    };
  }
  async function create(owner: Account, body: ReturnType<typeof input>) {
    return (
      await api().post('/v1/campaigns').set(as(owner)).send(body).expect(201)
    ).body.campaign;
  }

  it('creates exactly seven daily posts, schedules every selected account and survives competing workers', async () => {
    const {owner, accounts, mediaId} = await setup('Week');
    const body = input(
      accounts.map((account) => account.id),
      mediaId,
    );
    const campaign = await create(owner, body);
    const duplicate = await create(owner, body);
    expect(duplicate.id).toBe(campaign.id);
    expect(campaign.items).toHaveLength(7);
    expect(JSON.stringify(campaign)).not.toContain('leaseToken');
    await Promise.all([
      campaigns.process(campaign.id),
      campaigns.process(campaign.id),
    ]);
    const result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)).expect(200)
    ).body.campaign;
    expect(result.status).toBe('READY');
    expect(ai.prompts).toHaveLength(7);
    expect(
      result.items.every(
        (item: any) =>
          item.post.status === 'scheduled' &&
          item.post.targets.length === 2 &&
          item.post.media[0].id === mediaId,
      ),
    ).toBe(true);
    expect(result.items[0].post.scheduledAt).toBe(
      body.startDate + 'T12:00:00.000Z',
    );
    expect(new Set(result.items.map((item: any) => item.plannedAt)).size).toBe(
      7,
    );
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(7);
    expect(ai.prompts[1]).toContain('A fresh daily idea');
  });

  it('prepares all thirty daily slots without a single oversized AI response', async () => {
    const {owner, accounts} = await setup('Month', false);
    const campaign = await create(
      owner,
      input(
        accounts.map((account) => account.id),
        undefined,
        {days: 30, autoSchedule: false},
      ),
    );
    await campaigns.process(campaign.id);
    const result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
    ).body.campaign;
    expect(result.items).toHaveLength(30);
    expect(
      result.items.every(
        (item: any) => item.status === 'READY' && item.post.status === 'draft',
      ),
    ).toBe(true);
    expect(ai.prompts).toHaveLength(30);
  }, 60000);

  it('splits a monthly mixed-media brief across five creators and schedules their posts', async () => {
    const {owner, accounts, mediaId} = await setup('Agency', false);
    await prisma.subscription.update({where: {workspaceId: owner.workspaceId}, data: {plan: 'AGENCY'}});
    const creators = await Promise.all(Array.from({length: 5}, async () => {
      const user = await prisma.user.create({data: {name: 'Creator', email: `${randomUUID()}@e2e.test`}});
      return prisma.workspaceMember.create({data: {workspaceId: owner.workspaceId, userId: user.id, role: 'EDITOR'}});
    }));
    const ids = creators.map(person => person.id);
    const body = input(accounts.map(a => a.id), undefined, {days: 30, themes: 'Show our lentil bowls', mediaMode: 'AI_MIXED', creatorIds: ids});
    await api().post('/v1/campaigns').set(as(owner)).send({...body, creatorIds: [randomUUID()]}).expect(400);
    const video = await prisma.media.create({data: {workspaceId: owner.workspaceId, userId: owner.userId,
      originalName: 'clip.mp4', filename: 'clip.mp4', mimeType: 'video/mp4', url: '/uploads/clip.mp4',
      width: 1080, height: 1920, size: 5000, durationSec: 5}});
    const service = app.get(CreativeService);
    const capabilities = jest.spyOn(service, 'capabilities').mockResolvedValue({imageConfigured: true, ffmpeg: true});
    const render = jest.spyOn(service, 'create').mockImplementation(async (_ctx, _user, request) => ({
      image: {id: mediaId}, video: request.kind === 'video' ? video : null, note: '',
    } as any));
    try {
      const campaign = await create(owner, body);
      await campaigns.process(campaign.id);
      const result = (await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)).expect(200)).body.campaign;
      expect(result.status).toBe('READY');
      expect(result.items).toHaveLength(30);
      result.items.forEach((day: any, i: number) => {
        expect(day.creator.id).toBe(ids[i % 5]);
        expect(day.visualBrief).toBe('A welcoming restaurant table');
        expect(day.post.status).toBe('scheduled');
        expect(day.post.media[0].id).toBe([2, 5].includes(i % 7) ? video.id : mediaId);
        expect(ai.prompts[i]).toContain('Show our lentil bowls');
      });
      expect(render).toHaveBeenCalledTimes(30);
      expect(await prisma.notification.count({where: {workspaceId: owner.workspaceId, type: 'campaign_assigned'}})).toBe(5);
    } finally {
      capabilities.mockRestore();
      render.mockRestore();
    }
  }, 60000);

  it('honors workspace approval and schedules approved posts without generating them again', async () => {
    const {owner, accounts, mediaId} = await setup('Review');
    await prisma.workspace.update({
      where: {id: owner.workspaceId},
      data: {approvalRequired: true},
    });
    const campaign = await create(
      owner,
      input(
        accounts.map((account) => account.id),
        mediaId,
      ),
    );
    await campaigns.process(campaign.id);
    let result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
    ).body.campaign;
    expect(
      result.items.every((item: any) => item.post.status === 'in_review'),
    ).toBe(true);
    const post = result.items[0].post;
    await api()
      .post(`/v1/posts/${post.id}/approve`)
      .set(as(owner))
      .send({version: post.contentVersion})
      .expect(201);
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'schedule'})
      .expect(201);
    await campaigns.process(campaign.id);
    result = (await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)))
      .body.campaign;
    expect(result.items[0].post.status).toBe('scheduled');
    expect(result.items[1].post.status).toBe('in_review');
    expect(ai.prompts).toHaveLength(7);
  });

  it('keeps edits, permanently skips a deleted day and cancels future scheduled posts', async () => {
    const {owner, accounts, mediaId} = await setup('Control');
    const campaign = await create(
      owner,
      input(
        accounts.map((account) => account.id),
        mediaId,
      ),
    );
    await campaigns.process(campaign.id);
    let result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
    ).body.campaign;
    const post = result.items[0].post;
    await api()
      .patch(`/v1/posts/${post.id}`)
      .set(as(owner))
      .send({title: 'Our edited title', caption: 'Our actual menu story.'})
      .expect(200);
    await api()
      .delete(`/v1/posts/${result.items[1].post.id}`)
      .set(as(owner))
      .expect(200);
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'schedule'})
      .expect(201);
    await campaigns.process(campaign.id);
    result = (await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)))
      .body.campaign;
    expect(result.items[0].post.title).toBe('Our edited title');
    expect(result.items[1].status).toBe('SKIPPED');
    expect(result.items[1].post).toBeNull();
    expect(ai.prompts).toHaveLength(7);
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'cancel'})
      .expect(201);
    expect(
      await prisma.postTarget.count({
        where: {post: {workspaceId: owner.workspaceId}, status: 'SCHEDULED'},
      }),
    ).toBe(0);
    await api()
      .post(`/v1/posts/${post.id}/schedule`)
      .set(as(owner))
      .send({confirm: true, scheduledAt: post.scheduledAt})
      .expect(409);
  });

  it('isolates workspaces and validates dates, media, confirmation, Instagram and credit budgets', async () => {
    const {owner, accounts, mediaId} = await setup('Limits');
    const stranger = await register('Stranger' + randomUUID().slice(0, 6));
    const body = input(
      accounts.map((account) => account.id),
      mediaId,
    );
    await api()
      .post('/v1/campaigns')
      .set(as(owner))
      .send({...body, confirm: false})
      .expect(400);
    await api()
      .post('/v1/campaigns')
      .set(as(owner))
      .send({...body, startDate: '2027-02-30'})
      .expect(400);
    await api()
      .post('/v1/campaigns')
      .set(as(owner))
      .send({...body, mediaMode: 'TEXT', mediaIds: []})
      .expect(400);
    await api().post('/v1/campaigns').set(as(stranger)).send(body).expect(400);
    const capability = jest
      .spyOn(app.get(CreativeService), 'capabilities')
      .mockResolvedValue({imageConfigured: true, ffmpeg: true});
    await api()
      .post('/v1/campaigns')
      .set(as(owner))
      .send({...body, mediaMode: 'AI_IMAGE'})
      .expect(402);
    capability.mockRestore();
    expect(campaignCreditEstimate(30, 'AI_IMAGE')).toBe(150);
    expect(ai.prompts).toHaveLength(0);
    const campaign = await create(owner, body);
    await api()
      .get(`/v1/campaigns/${campaign.id}`)
      .set(as(stranger))
      .expect(404);
  });

  it('recovers an expired worker lease and retries failed days without duplicate posts', async () => {
    const {owner, accounts} = await setup('Recovery', false);
    const campaign = await create(
      owner,
      input(
        accounts.map((account) => account.id),
        undefined,
        {autoSchedule: false},
      ),
    );
    ai.next = {items: []};
    await campaigns.process(campaign.id);
    expect(
      (await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}}))
        .status,
    ).toBe('NEEDS_ATTENTION');
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(0);
    ai.next = goodOutput();
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'retry'})
      .expect(201);
    await prisma.campaign.update({
      where: {id: campaign.id},
      data: {
        status: 'GENERATING',
        leaseToken: 'crashed-process',
        leaseUntil: new Date(Date.now() - 1000),
      },
    });
    await campaigns.process(campaign.id);
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(7);
    expect(
      (await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}}))
        .status,
    ).toBe('READY');
    await campaigns.process(campaign.id);
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(7);
  });

  it('holds unsupported factual claims instead of publishing them', async () => {
    const {owner, accounts} = await setup('Facts', false);
    const campaign = await create(
      owner,
      input(accounts.map((account) => account.id)),
    );
    ai.next = {
      items: [
        {
          platform: 'FACEBOOK',
          postIdea: 'Offer',
          caption: 'Free delivery and 50% off. Only ৳999!',
          hashtags: [],
          cta: '',
          visualBrief: '',
        },
      ],
    };
    await campaigns.process(campaign.id);
    const result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
    ).body.campaign;
    expect(
      result.items.every(
        (item: any) =>
          item.post.status === 'draft' && item.error.includes('flagged'),
      ),
    ).toBe(true);
    expect(
      await prisma.postTarget.count({
        where: {post: {workspaceId: owner.workspaceId}, status: 'SCHEDULED'},
      }),
    ).toBe(0);
  });
  it('reuses captions when an AI image fails, then attaches media and schedules the recovered day', async () => {
    const {owner, accounts, mediaId} = await setup('Visuals');
    await prisma.subscription.update({
      where: {workspaceId: owner.workspaceId},
      data: {plan: 'GROWTH'},
    });
    const creative = app.get(CreativeService);
    const capabilities = jest
      .spyOn(creative, 'capabilities')
      .mockResolvedValue({imageConfigured: true, ffmpeg: true});
    const generate = jest
      .spyOn(creative, 'create')
      .mockRejectedValueOnce(
        new Error('Image provider temporarily unavailable'),
      )
      .mockResolvedValue({
        image: {id: mediaId},
        video: null,
        note: 'Generated image.',
      } as any);
    try {
      const campaign = await create(
        owner,
        input(
          accounts.map((account) => account.id),
          undefined,
          {mediaMode: 'AI_IMAGE'},
        ),
      );
      await campaigns.process(campaign.id);
      let result = (
        await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
      ).body.campaign;
      expect(result.status).toBe('NEEDS_ATTENTION');
      expect(result.items[0].status).toBe('FAILED');
      expect(result.items[0].post.status).toBe('draft');
      expect(result.items[1].post.status).toBe('scheduled');
      await api()
        .post(`/v1/campaigns/${campaign.id}/actions`)
        .set(as(owner))
        .send({action: 'retry'})
        .expect(201);
      await campaigns.process(campaign.id);
      result = (await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)))
        .body.campaign;
      expect(result.status).toBe('READY');
      expect(
        result.items.every(
          (item: any) =>
            item.post.media[0].id === mediaId &&
            item.post.status === 'scheduled',
        ),
      ).toBe(true);
      expect(ai.prompts).toHaveLength(7);
      expect(generate).toHaveBeenCalledTimes(8);
      const edited = result.items[0].post;
      await api()
        .patch(`/v1/posts/${edited.id}`)
        .set(as(owner))
        .send({mediaIds: []})
        .expect(200);
      await api()
        .post(`/v1/campaigns/${campaign.id}/actions`)
        .set(as(owner))
        .send({action: 'schedule'})
        .expect(201);
      await campaigns.process(campaign.id);
      result = (await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner)))
        .body.campaign;
      expect(result.items[0].post.media).toHaveLength(0);
      expect(result.items[0].status).toBe('FAILED');
      expect(generate).toHaveBeenCalledTimes(8);
    } finally {
      capabilities.mockRestore();
      generate.mockRestore();
    }
  });

  it('stops after a pause during generation and allows unfinished days to be moved or removed', async () => {
    const {owner, accounts} = await setup('Pause', false);
    const campaign = await create(
      owner,
      input(
        accounts.map((account) => account.id),
        undefined,
        {autoSchedule: false},
      ),
    );
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = ai.generateJson.bind(ai);
    const generation = jest
      .spyOn(ai, 'generateJson')
      .mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return original(...args);
      });
    const work = campaigns.process(campaign.id);
    await waiting;
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'pause'})
      .expect(201);
    release();
    await work;
    generation.mockRestore();
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(0);
    const moved = new Date(Date.now() + 5 * 86400_000).toISOString();
    await api()
      .patch(`/v1/campaigns/${campaign.id}/items/${campaign.items[0].id}`)
      .set(as(owner))
      .send({plannedAt: moved})
      .expect(200);
    await api()
      .patch(`/v1/campaigns/${campaign.id}/items/${campaign.items[1].id}`)
      .set(as(owner))
      .send({skip: true})
      .expect(200);
    await api()
      .post(`/v1/campaigns/${campaign.id}/actions`)
      .set(as(owner))
      .send({action: 'resume'})
      .expect(201);
    await campaigns.process(campaign.id);
    const result = (
      await api().get(`/v1/campaigns/${campaign.id}`).set(as(owner))
    ).body.campaign;
    expect(result.items[0].post.scheduledAt).toBe(moved);
    expect(result.items[1].status).toBe('SKIPPED');
    expect(
      await prisma.post.count({where: {workspaceId: owner.workspaceId}}),
    ).toBe(6);
  });
});
