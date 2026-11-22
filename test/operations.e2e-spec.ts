import {INestApplication} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHmac, randomUUID} from 'crypto';
import {PrismaService} from '../src/prisma/prisma.service';
import {SslcommerzGateway} from '../src/billing/sslcommerz.gateway';
import {Account, client, createApp, jpegBytes} from './helpers';

describe('Business operations and tenant isolation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let api: ReturnType<typeof client>['api'];
  let as: ReturnType<typeof client>['as'];
  let owner: Account;
  let outsider: Account;
  let viewer: Account;
  let accountId: string;
  let messageId: string;
  beforeAll(async () => {
    ({app, prisma} = await createApp());
    const clients = client(app); ({api, as} = clients);
    owner = await clients.register(`Ops${randomUUID().slice(0, 6)}`);
    outsider = await clients.register(`Outside${randomUUID().slice(0, 6)}`);
    viewer = await clients.register(`View${randomUUID().slice(0, 6)}`);
    const account = await prisma.socialAccount.create({data: {workspaceId: owner.workspaceId, platform: 'FACEBOOK', platformAccountId: randomUUID(), name: 'Operations Page', status: 'CONNECTED', scopes: ['pages_messaging', 'pages_manage_engagement', 'pages_read_user_content'], accessTokenEnc: 'unused'}});
    accountId = account.id;
    const item = await prisma.engagementItem.create({data: {workspaceId: owner.workspaceId, socialAccountId: accountId, platform: 'FACEBOOK', kind: 'DM', externalId: randomUUID(), threadId: 'conversation', authorId: 'customer', authorName: 'Amina', text: 'Can I order coffee?', receivedAt: new Date()}});
    messageId = item.id;
    await prisma.workspaceMember.create({data: {workspaceId: owner.workspaceId, userId: viewer.userId, role: 'VIEWER', inviteStatus: 'ACTIVE'}});
  });
  afterAll(async () => { await app?.close(); });

  it('filters leads, assigns active writers and preserves private notes', async () => {
    const member = await prisma.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: owner.workspaceId, userId: owner.userId}}});
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(owner)).send({leadStage: 'INTERESTED', assignedMemberId: member.id, internalNote: 'Call tomorrow'}).expect(200);
    const response = await api().get('/v1/autopilot/inbox?status=ALL&stage=INTERESTED&search=amina&take=1').set(as(owner)).expect(200);
    expect(response.body.total).toBe(1);
    expect(response.body.items[0]).toMatchObject({id: messageId, leadStage: 'INTERESTED', internalNote: 'Call tomorrow', assignedMemberId: member.id});
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(owner)).send({assignedMemberId: null, internalNote: null}).expect(200);
    const item = await prisma.engagementItem.findUniqueOrThrow({where: {id: messageId}});
    expect(item.assignedMemberId).toBeNull(); expect(item.internalNote).toBeNull();
  });

  it('rejects foreign assignments, cross-tenant reads, viewer writes, and invalid filters', async () => {
    const member = await prisma.workspaceMember.findUniqueOrThrow({where: {workspaceId_userId: {workspaceId: outsider.workspaceId, userId: outsider.userId}}});
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(owner)).send({assignedMemberId: member.id}).expect(400);
    await api().get(`/v1/autopilot/inbox/${messageId}/thread`).set(as(outsider)).expect(404);
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(outsider)).send({leadStage: 'ORDERED'}).expect(404);
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(viewer, owner.workspaceId)).send({leadStage: 'ORDERED'}).expect(403);
    await api().get('/v1/autopilot/inbox?status=INVALID').set(as(owner)).expect(400);
    await api().get('/v1/autopilot/inbox?page=-1').set(as(owner)).expect(400);
    await api().patch(`/v1/autopilot/inbox/${messageId}/lead`).set(as(owner)).send({leadStage: null}).expect(400);
  });

  it('keeps message history within the account and workspace', async () => {
    await prisma.engagementItem.create({data: {workspaceId: owner.workspaceId, socialAccountId: accountId, platform: 'FACEBOOK', kind: 'DM', externalId: randomUUID(), threadId: 'webhook-thread', authorId: 'customer', text: 'Following up', receivedAt: new Date()}});
    const response = await api().get(`/v1/autopilot/inbox/${messageId}/thread`).set(as(owner)).expect(200);
    expect(response.body.items).toHaveLength(2);
  });

  it('reports separate currencies, real attribution and unavailable metrics without leaking tenants', async () => {
    const publishedAt = new Date();
    const post = await prisma.post.create({data: {workspaceId: owner.workspaceId, userId: owner.userId, title: 'Coffee launch', caption: 'Coffee', platforms: ['facebook'], status: 'published'}});
    await prisma.postTarget.create({data: {postId: post.id, platform: 'FACEBOOK', socialAccountId: accountId, idempotencyKey: randomUUID(), status: 'PUBLISHED', publishedAt, engagements: 0}});
    await prisma.sale.createMany({data: [{workspaceId: owner.workspaceId, postId: post.id, amount: 45000, currency: 'BDT', source: 'manual'}, {workspaceId: owner.workspaceId, amount: 500, currency: 'USD', source: 'manual'}, {workspaceId: outsider.workspaceId, amount: 990000, currency: 'BDT', source: 'manual'}]});
    const report = await api().get('/v1/analytics/report').set(as(owner)).expect(200);
    expect(report.body.current.metrics.engagements.value).toBe(0);
    expect(report.body.current.metrics.reach.value).toBeNull();
    expect(report.body.revenue).toEqual(expect.arrayContaining([expect.objectContaining({currency: 'BDT', amount: 45000}), expect.objectContaining({currency: 'USD', amount: 500})]));
    expect(report.body.attributedRevenue).toEqual([expect.objectContaining({currency: 'BDT', amount: 45000})]);
    await api().get('/v1/analytics/report?from=invalid').set(as(owner)).expect(400);
    await api().get('/v1/analytics/overview?from=2026-11-18&to=2026-11-01').set(as(owner)).expect(400);
    const exported = await api().get('/v1/analytics/report.md').set(as(owner)).expect(200);
    expect(exported.headers['content-disposition']).toContain('attachment');
    expect(exported.text).toContain('450.00');
    expect(exported.text).not.toContain('9900.00');
  });

  it('authenticates original media access and returns actionable health counts', async () => {
    const upload = await api().post('/v1/media/upload').set(as(owner)).attach('file', jpegBytes(), {filename: 'photo.jpg', contentType: 'image/jpeg'}).expect(201);
    await api().get(`/v1/media/${upload.body.media.id}/download`).expect(401);
    await api().get(`/v1/media/${upload.body.media.id}/download`).set(as(outsider)).expect(404);
    const file = await api().get(`/v1/media/${upload.body.media.id}/download`).set(as(owner)).expect(200);
    expect(file.headers['content-type']).toContain('image/jpeg');
    expect(file.headers['cache-control']).toContain('no-store');
    const health = await api().get('/v1/dashboard/health').set(as(owner)).expect(200);
    expect(health.body.inbox).toBe(2); expect(health.body.checks.database).toBe(true);
  });

  it('accepts signed inbox events once and rejects forged payloads', async () => {
    const config = app.get(ConfigService);
    jest.spyOn(config, 'get').mockImplementation((key: string) => key === 'FACEBOOK_APP_SECRET' ? 'test-meta-secret' : process.env[key]);
    await prisma.autopilotConfig.upsert({where: {workspaceId: owner.workspaceId}, create: {workspaceId: owner.workspaceId, enabled: true, replyMode: 'DRAFT', replyDms: true}, update: {enabled: true, replyMode: 'DRAFT', replyDms: true}});
    const account = await prisma.socialAccount.findUniqueOrThrow({where: {id: accountId}});
    const payload = {object: 'page', entry: [{id: account.platformAccountId, messaging: [{sender: {id: 'new-customer'}, timestamp: Date.now(), message: {mid: 'webhook-id', text: 'Order please'}}]}]};
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac('sha256', 'test-meta-secret').update(body).digest('hex')}`;
    try {
      await api().post('/v1/webhooks/meta').send(payload).expect(401);
      const first = await api().post('/v1/webhooks/meta').set('x-hub-signature-256', signature).set('Content-Type', 'application/json').send(body).expect(200);
      const second = await api().post('/v1/webhooks/meta').set('x-hub-signature-256', signature).set('Content-Type', 'application/json').send(body).expect(200);
      expect(first.body.received).toBe(1); expect(second.body.received).toBe(0);
    } finally { jest.restoreAllMocks(); }
  });

  it('settles one online invoice only once across duplicate callbacks', async () => {
    const config = app.get(ConfigService);
    const get = config.get.bind(config);
    jest.spyOn(config, 'get').mockImplementation((key: string) => key === 'BILLING_PROVIDER' ? 'sslcommerz' : get(key));
    const gateway = app.get(SslcommerzGateway);
    const invoice = await prisma.invoice.create({data: {workspaceId: owner.workspaceId, plan: 'STARTER', amount: 49900, status: 'pending', periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400_000), provider: 'sslcommerz', providerRef: randomUUID(), billingCycle: 'monthly'}});
    jest.spyOn(gateway, 'validate').mockResolvedValue({status: 'VALIDATED', tran_id: invoice.providerRef!, val_id: 'validated', amount: '499.00', currency: 'BDT', risk_level: '0'});
    try {
      const results = await Promise.all([api().post('/v1/billing/sslcommerz/ipn').send({val_id: 'validated'}), api().post('/v1/billing/sslcommerz/ipn').send({val_id: 'validated'})]);
      expect(results.map(result => result.status)).toEqual([200, 200]);
      expect(results.map(result => result.body.duplicate).sort()).toEqual([false, true]);
      expect(await prisma.billingEvent.count({where: {provider: 'sslcommerz', eventId: `invoice:${invoice.id}`}})).toBe(1);
      expect((await prisma.invoice.findUniqueOrThrow({where: {id: invoice.id}})).status).toBe('paid');
      expect((await prisma.subscription.findUniqueOrThrow({where: {workspaceId: owner.workspaceId}})).plan).toBe('STARTER');
    } finally { jest.restoreAllMocks(); }
  });
});
