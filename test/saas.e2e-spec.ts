import {INestApplication} from '@nestjs/common';
import {createHmac, randomUUID} from 'crypto';
import {CryptoService} from '../src/crypto/crypto.service';
import {PrismaService} from '../src/prisma/prisma.service';
import {PublisherService} from '../src/publishing/publisher.service';
import {PlatformError} from '../src/social/meta-graph';
import {Account, client, createApp, FakeAdapters, FakeAi, jpegBytes, pngBytes, run} from './helpers';

describe('PostPilot R1 acceptance (PRD section 18)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let crypto: CryptoService;
  let adapters: FakeAdapters;
  let ai: FakeAi;
  let publisher: PublisherService;
  let api: ReturnType<typeof client>['api'];
  let as: ReturnType<typeof client>['as'];
  let register: ReturnType<typeof client>['register'];

  beforeAll(async () => {
    ({app, prisma, crypto, adapters, ai} = await createApp());
    publisher = app.get(PublisherService);
    ({api, as, register} = client(app));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => adapters.reset());

  /** Simulates a completed Facebook Login and connects the chosen candidates through the API. */
  async function connect(owner: Account, which: ('FACEBOOK' | 'INSTAGRAM')[] = ['FACEBOOK', 'INSTAGRAM']) {
    const pageId = `page-${randomUUID().slice(0, 8)}`;
    const candidates = [
      {key: `FACEBOOK:${pageId}`, platform: 'FACEBOOK', platformAccountId: pageId, name: 'Sunny Cafe', handle: null, pictureUrl: null, accessToken: 'page-token', pageId},
      {key: `INSTAGRAM:ig-${pageId}`, platform: 'INSTAGRAM', platformAccountId: `ig-${pageId}`, name: '@sunnycafe', handle: 'sunnycafe', pictureUrl: null, accessToken: 'page-token', pageId},
    ];
    const state = await prisma.oAuthState.create({
      data: {
        workspaceId: owner.workspaceId,
        userId: owner.userId,
        platform: 'FACEBOOK',
        nonceHash: randomUUID(),
        expiresAt: new Date(Date.now() + 600_000),
        candidatesEnc: crypto.encrypt(
          JSON.stringify({fbUserId: `fb-${pageId}`, userToken: 'user-token', userTokenExpiresAt: null, scopes: ['pages_manage_posts'], candidates}),
        ),
      },
    });
    const listed = await api().get(`/v1/social/connections/${state.id}`).set(as(owner)).expect(200);
    expect(JSON.stringify(listed.body)).not.toContain('page-token');
    const res = await api()
      .post(`/v1/social/connections/${state.id}`)
      .set(as(owner))
      .send({keys: candidates.filter(c => which.includes(c.platform as 'FACEBOOK')).map(c => c.key)})
      .expect(201);
    const byPlatform = Object.fromEntries(res.body.accounts.map((a: {platform: string; id: string}) => [a.platform, a.id]));
    return {fb: byPlatform.FACEBOOK as string, ig: byPlatform.INSTAGRAM as string};
  }

  async function upload(owner: Account, bytes = jpegBytes(), type = 'image/jpeg', name = 'photo.jpg') {
    const res = await api().post('/v1/media/upload').set(as(owner)).attach('file', bytes, {filename: name, contentType: type}).expect(201);
    return res.body.media as {id: string; url: string; width: number; height: number; sha256: string};
  }

  async function createPost(owner: Account, body: Record<string, unknown>) {
    const res = await api().post('/v1/posts').set(as(owner)).send(body).expect(201);
    return res.body.post as {id: string; contentVersion: number; targets: {id: string; platform: string}[]};
  }

  function schedule(owner: Account, postId: string, extra: Record<string, unknown> = {}) {
    return api()
      .post(`/v1/posts/${postId}/schedule`)
      .set(as(owner))
      .send({confirm: true, scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), ...extra});
  }

  async function runTarget(targetId: string) {
    const t = await prisma.postTarget.findUniqueOrThrow({where: {id: targetId}});
    return publisher.process(targetId, t.jobToken!);
  }

  describe('social accounts and tokens (FR-03)', () => {
    it('stores tokens encrypted and never returns them', async () => {
      const owner = await register('Tok');
      const {fb} = await connect(owner);
      const row = await prisma.socialAccount.findUniqueOrThrow({where: {id: fb}});
      expect(row.accessTokenEnc).not.toContain('page-token');
      expect(crypto.decrypt(row.accessTokenEnc)).toBe('page-token');
      const res = await api().get('/v1/social-accounts').set(as(owner)).expect(200);
      expect(JSON.stringify(res.body)).not.toMatch(/page-token|accessTokenEnc|user-token/);
    });

    it('rejects a forged or reused OAuth state', async () => {
      const res = await api().get('/v1/social-auth/facebook/callback?code=x&state=forged.state').redirects(0);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain('connect_error=');
    });

    it('enforces the plan channel limit', async () => {
      const owner = await register('Lim');
      await connect(owner);
      // Trial allows 2 channels; a third is refused.
      await expect(connect(owner, ['FACEBOOK'])).rejects.toThrow();
    });
  });

  describe('media library (FR-07, TEST-08)', () => {
    it('validates real file contents and records hash and dimensions', async () => {
      const owner = await register('Med');
      const media = await upload(owner, pngBytes(800, 600), 'image/png', 'a.png');
      expect(media).toMatchObject({width: 800, height: 600});
      expect(media.sha256).toHaveLength(64);

      await api()
        .post('/v1/media/upload')
        .set(as(owner))
        .attach('file', Buffer.from('not really an image'), {filename: 'x.png', contentType: 'image/png'})
        .expect(400);
    });

    it('serves files only through valid signed URLs', async () => {
      const owner = await register('Sig');
      const media = await upload(owner);
      const path = new URL(media.url).pathname + new URL(media.url).search;
      await api().get(path).expect(200);
      await api().get(path.replace(/sig=[^&]+/, 'sig=tampered')).expect(404);
    });

    it('blocks an Instagram post with an unsupported image before queueing (TEST-08)', async () => {
      const owner = await register('Bad');
      const {ig} = await connect(owner);
      const png = await upload(owner, pngBytes(), 'image/png', 'a.png');
      const post = await createPost(owner, {caption: 'Hello', mediaIds: [png.id], targets: [{socialAccountId: ig}]});
      const res = await schedule(owner, post.id).expect(422);
      expect(res.body.message).toMatch(/does not accept image\/png/);

      const text = await createPost(owner, {caption: 'Text only', targets: [{socialAccountId: ig}]});
      await schedule(owner, text.id).expect(422);
      const targets = await prisma.postTarget.findMany({where: {postId: {in: [post.id, text.id]}}});
      expect(targets.every(t => t.status === 'PENDING' && !t.jobToken)).toBe(true);
    });
  });

  describe('approvals (FR-14, TEST-02)', () => {
    let owner: Account;
    let editor: Account;
    let fb: string;

    beforeAll(async () => {
      owner = await register('Appr');
      editor = await register('Edit');
      ({fb} = await connect(owner, ['FACEBOOK']));
      await api().patch(`/v1/workspaces/${owner.workspaceId}`).set(as(owner)).send({approvalRequired: true}).expect(200);
      await api().post(`/v1/workspaces/${owner.workspaceId}/members`).set(as(owner)).send({email: editor.email, role: 'EDITOR'}).expect(201);
      await api().post(`/v1/workspaces/${owner.workspaceId}/accept`).set({Authorization: `Bearer ${editor.token}`}).expect(201);
    });

    it('never lets an unapproved draft publish in an approval workspace', async () => {
      const ed = {...editor, workspaceId: owner.workspaceId};
      const post = await createPost(ed, {caption: 'Weekend special menu', targets: [{socialAccountId: fb}]});
      await schedule(ed, post.id).expect(403);
      await schedule(owner, post.id).expect(403);

      await api().post(`/v1/posts/${post.id}/submit`).set(as(ed)).send({}).expect(201);
      // Stale version is refused.
      await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 99}).expect(409);
      await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 1}).expect(201);
      await schedule(ed, post.id).expect(403);
      await schedule(owner, post.id).expect(201);
    });

    it('sends a materially edited approved post back to review and unschedules it', async () => {
      const post = await createPost(owner, {caption: 'Original', targets: [{socialAccountId: fb}]});
      await api().post(`/v1/posts/${post.id}/submit`).set(as(owner)).send({}).expect(201);
      await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 1}).expect(201);
      await schedule(owner, post.id).expect(201);
      const target = await prisma.postTarget.findFirstOrThrow({where: {postId: post.id}});
      const oldToken = target.jobToken!;

      const res = await api().patch(`/v1/posts/${post.id}`).set(as(owner)).send({caption: 'Changed'}).expect(200);
      expect(res.body.post).toMatchObject({status: 'in_review', contentVersion: 2, approved: false});
      expect(res.body.post.targets[0].status).toBe('PENDING');
      // The old queued job can no longer publish.
      expect(await publisher.process(target.id, oldToken)).toBe('stale');
      expect(adapters.calls).toHaveLength(0);
    });

    it('requires acknowledging compliance flags before approval', async () => {
      const post = await createPost(owner, {caption: 'Lattes now only ৳99!', targets: [{socialAccountId: fb}]});
      const res = await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 1}).expect(422);
      expect(res.body.code).toBe('COMPLIANCE_FLAGS');
      await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 1, acknowledgeFlags: true}).expect(201);
    });
  });

  describe('publishing engine (FR-09, section 9)', () => {
    let owner: Account;
    let fb: string;
    let ig: string;
    let image: {id: string};

    beforeAll(async () => {
      owner = await register('Pub');
      ({fb, ig} = await connect(owner));
      image = await upload(owner);
    });

    async function scheduled(caption: string, targets = [fb]) {
      const post = await createPost(owner, {caption, mediaIds: [image.id], targets: targets.map(id => ({socialAccountId: id}))});
      await schedule(owner, post.id).expect(201);
      return prisma.post.findUniqueOrThrow({where: {id: post.id}, include: {targets: true}});
    }

    it('publishes once even if the job is delivered twice (TEST-03)', async () => {
      const post = await scheduled('Once only');
      const t = post.targets[0];
      expect(await publisher.process(t.id, t.jobToken!)).toBe('published');
      expect(await publisher.process(t.id, t.jobToken!)).toBe('stale');
      expect(adapters.calls).toHaveLength(1);
      expect(adapters.calls[0].content.media[0].url).toContain('/media/files/');
      const done = await prisma.postTarget.findUniqueOrThrow({where: {id: t.id}});
      expect(done.status).toBe('PUBLISHED');
      expect(done.remotePostId).toBeTruthy();
    });

    it('recovers a target abandoned mid-publish without posting twice (TEST-03, TEST-06)', async () => {
      const post = await scheduled('Crash mid flight');
      const t = post.targets[0];
      // Simulate a worker that claimed the job and called Meta, then died.
      await prisma.postTarget.update({where: {id: t.id}, data: {status: 'PROCESSING', attemptCount: 1}});
      await prisma.publishAttempt.create({data: {targetId: t.id, attempt: 1}});
      adapters.reconcileResult = {state: 'published', outcome: {remotePostId: 'found-on-page'}};
      await publisher.recoverStuck(t.id);
      const done = await prisma.postTarget.findUniqueOrThrow({where: {id: t.id}});
      expect(done).toMatchObject({status: 'PUBLISHED', remotePostId: 'found-on-page'});
      expect(adapters.calls).toHaveLength(0);
    });

    it('marks a revoked token NEEDS_ACTION and asks to reconnect (TEST-04)', async () => {
      const other = await register('Rev');
      const accounts = await connect(other, ['FACEBOOK']);
      const media = await upload(other);
      const post = await createPost(other, {caption: 'Token revoked', mediaIds: [media.id], targets: [{socialAccountId: accounts.fb}]});
      await schedule(other, post.id).expect(201);
      adapters.script('FACEBOOK', async () => {
        throw new PlatformError('Error validating access token', 'auth', '190');
      });
      const target = await prisma.postTarget.findFirstOrThrow({where: {postId: post.id}});
      expect(await runTarget(target.id)).toBe('needs_action');
      expect((await prisma.socialAccount.findUniqueOrThrow({where: {id: accounts.fb}})).status).toBe('EXPIRED');
      const notes = await prisma.notification.findMany({where: {userId: other.userId, type: 'connection_expired'}});
      expect(notes).toHaveLength(1);
      // Nothing else can be scheduled to the expired account.
      const next = await createPost(other, {caption: 'Again', targets: [{socialAccountId: accounts.fb}]});
      await schedule(other, next.id).expect(422);
    });

    it('backs off on rate limits, honouring Retry-After, then gives up (TEST-05)', async () => {
      const post = await scheduled('Rate limited');
      const t = post.targets[0];
      adapters.script('FACEBOOK', async () => {
        throw new PlatformError('Too many calls', 'rate_limited', '4', 20 * 60_000);
      });
      const before = Date.now();
      expect(await runTarget(t.id)).toBe('retry_scheduled');
      const retry = await prisma.postTarget.findUniqueOrThrow({where: {id: t.id}});
      expect(retry.status).toBe('SCHEDULED');
      expect(retry.nextAttemptAt!.getTime() - before).toBeGreaterThanOrEqual(20 * 60_000 - 1000);

      for (let i = 0; i < 4; i++) {
        adapters.script('FACEBOOK', async () => {
          throw new PlatformError('Service unavailable', 'transient', 'http_503');
        });
        await runTarget(t.id);
      }
      const final = await prisma.postTarget.findUniqueOrThrow({where: {id: t.id}, include: {attempts: true}});
      expect(final.status).toBe('FAILED');
      expect(final.attempts).toHaveLength(5);
      expect(final.attempts.every(a => a.outcome === 'transient_error')).toBe(true);
    });

    it('never blindly retries an ambiguous timeout (TEST-06)', async () => {
      const post = await scheduled('Timed out');
      const t = post.targets[0];
      adapters.script('FACEBOOK', async () => {
        throw new PlatformError('No response from Meta (timeout)', 'ambiguous', 'network');
      });
      adapters.reconcileResult = {state: 'unknown'};
      expect(await runTarget(t.id)).toBe('needs_action');
      expect(adapters.reconcileCalls).toBe(1);
      expect(adapters.calls).toHaveLength(1);

      const res = await api().post(`/v1/post-targets/${t.id}/retry`).set(as(owner)).send({}).expect(409);
      expect(res.body.code).toBe('CONFIRM_NOT_PUBLISHED');
      await api().post(`/v1/post-targets/${t.id}/retry`).set(as(owner)).send({confirmNotPublished: true}).expect(201);
    });

    it('reconciles an ambiguous timeout that did publish', async () => {
      const post = await scheduled('Timed out but live');
      const t = post.targets[0];
      adapters.script('FACEBOOK', async () => {
        throw new PlatformError('No response from Meta (timeout)', 'ambiguous', 'network');
      });
      adapters.reconcileResult = {state: 'published', outcome: {remotePostId: 'live-123'}};
      expect(await runTarget(t.id)).toBe('reconciled');
      expect(adapters.calls).toHaveLength(1);
      const attempt = await prisma.publishAttempt.findFirstOrThrow({where: {targetId: t.id}});
      expect(attempt.outcome).toBe('reconciled');
    });

    it('reports partial success per channel and only retries the failed one (TEST-07)', async () => {
      const post = await scheduled('Both channels', [fb, ig]);
      const fbTarget = post.targets.find(t => t.platform === 'FACEBOOK')!;
      const igTarget = post.targets.find(t => t.platform === 'INSTAGRAM')!;
      adapters.script('INSTAGRAM', async () => {
        throw new PlatformError('Invalid image aspect ratio', 'permanent', '36003');
      });
      expect(await runTarget(fbTarget.id)).toBe('published');
      expect(await runTarget(igTarget.id)).toBe('needs_action');

      const res = await api().get(`/v1/posts/${post.id}`).set(as(owner)).expect(200);
      expect(res.body.post.status).toBe('needs_action');
      const statuses = Object.fromEntries(res.body.post.targets.map((t: {platform: string; status: string}) => [t.platform, t.status]));
      expect(statuses).toEqual({FACEBOOK: 'PUBLISHED', INSTAGRAM: 'NEEDS_ACTION'});

      await api().post(`/v1/post-targets/${igTarget.id}/retry`).set(as(owner)).send({}).expect(201);
      adapters.reset();
      expect(await runTarget(igTarget.id)).toBe('published');
      expect(adapters.calls.map(c => c.platform)).toEqual(['INSTAGRAM']);
    });

    it('lets exactly one of cancel and publish win at the scheduled time', async () => {
      const post = await scheduled('Race');
      const t = post.targets[0];
      await prisma.postTarget.update({where: {id: t.id}, data: {status: 'PROCESSING'}});
      await api().post(`/v1/post-targets/${t.id}/cancel`).set(as(owner)).send({}).expect(409);

      const other = await scheduled('Cancelled first');
      const ot = other.targets[0];
      await api().post(`/v1/post-targets/${ot.id}/cancel`).set(as(owner)).send({}).expect(201);
      expect(await publisher.process(ot.id, ot.jobToken!)).toBe('stale');
      expect(adapters.calls).toHaveLength(0);
    });

    it('schedules in the workspace timezone and rejects past times (FR-08, TEST-09)', async () => {
      const post = await createPost(owner, {caption: 'Local time', mediaIds: [image.id], targets: [{socialAccountId: fb}]});
      const year = new Date().getUTCFullYear() + 1;
      const res = await schedule(owner, post.id, {scheduledAt: undefined, local: {date: `${year}-01-15`, time: '18:30'}}).expect(201);
      // Asia/Dhaka is UTC+6 all year.
      expect(res.body.post.targets[0].scheduledAt).toBe(`${year}-01-15T12:30:00.000Z`);

      const past = await createPost(owner, {caption: 'Past', targets: [{socialAccountId: fb}]});
      await schedule(owner, past.id, {scheduledAt: new Date(Date.now() - 3_600_000).toISOString()}).expect(400);
    });

    it('stops pending jobs when an account is disconnected (TEST-12)', async () => {
      const other = await register('Disc');
      const accounts = await connect(other, ['FACEBOOK']);
      const post = await createPost(other, {caption: 'Will be stopped', targets: [{socialAccountId: accounts.fb}]});
      await schedule(other, post.id).expect(201);
      const t = await prisma.postTarget.findFirstOrThrow({where: {postId: post.id}});

      await api().delete(`/v1/social-accounts/${accounts.fb}`).set(as(other)).expect(200);
      expect(await publisher.process(t.id, t.jobToken!)).toBe('stale');
      expect(adapters.calls).toHaveLength(0);
      const account = await prisma.socialAccount.findUniqueOrThrow({where: {id: accounts.fb}});
      expect(account).toMatchObject({status: 'REVOKED', accessTokenEnc: ''});
      expect((await prisma.postTarget.findUniqueOrThrow({where: {id: t.id}})).status).toBe('NEEDS_ACTION');
    });
  });

  describe('plans and billing (FR-12)', () => {
    it('blocks over-quota scheduling without touching drafts (TEST-10)', async () => {
      const owner = await register('Quota');
      const {fb} = await connect(owner, ['FACEBOOK']);
      const post = await createPost(owner, {caption: 'Keep me', targets: [{socialAccountId: fb}]});
      await prisma.subscription.update({
        where: {workspaceId: owner.workspaceId},
        data: {currentPeriodEnd: new Date(Date.now() - 1000), trialEndsAt: new Date(Date.now() - 1000)},
      });
      const res = await schedule(owner, post.id).expect(402);
      expect(res.body.code).toBe('SUBSCRIPTION_INACTIVE');
      await api().patch(`/v1/posts/${post.id}`).set(as(owner)).send({caption: 'Still editable'}).expect(200);
      const draft = await prisma.post.findUniqueOrThrow({where: {id: post.id}});
      expect(draft).toMatchObject({caption: 'Still editable', status: 'draft'});
    });

    it('verifies webhook signatures and ignores replays (TEST-11)', async () => {
      const owner = await register('Pay');
      const event = {
        id: `evt_${run}`,
        type: 'payment.succeeded',
        data: {workspaceId: owner.workspaceId, plan: 'GROWTH', cycle: 'monthly', amount: 149900, reference: `ref_${run}`},
      };
      const body = JSON.stringify(event);
      const sign = (b: string) => `sha256=${createHmac('sha256', 'e2e-webhook-secret').update(b).digest('hex')}`;
      const send = (signature: string) =>
        api().post('/v1/billing/webhook').set('Content-Type', 'application/json').set('x-postpilot-signature', signature).send(body);

      await send('sha256=deadbeef').expect(401);
      expect((await send(sign(body)).expect(200)).body).toEqual({received: true, duplicate: false});
      expect((await send(sign(body)).expect(200)).body).toEqual({received: true, duplicate: true});

      const sub = await prisma.subscription.findUniqueOrThrow({where: {workspaceId: owner.workspaceId}});
      expect(sub).toMatchObject({plan: 'GROWTH', status: 'ACTIVE'});
      expect(await prisma.invoice.count({where: {workspaceId: owner.workspaceId}})).toBe(1);
      expect(await prisma.billingEvent.count({where: {eventId: event.id}})).toBe(1);
    });
  });

  describe('AI studio (FR-04, FR-05, section 12)', () => {
    let owner: Account;

    beforeAll(async () => {
      owner = await register('Ai');
      await api()
        .patch('/v1/brand')
        .set(as(owner))
        .send({products: [{name: 'Iced latte', price: '৳350'}], approvedOffers: [], doNotSay: ['cheapest']})
        .expect(200);
    });

    it('flags an invented price and records metered usage (TEST-13, TEST-14)', async () => {
      ai.next = {
        options: [
          {headline: 'Summer', caption: 'Iced latte for ৳350', hashtags: ['#cafe'], cta: 'Visit', contentPillar: 'product', visualIdea: 'glass', complianceFlags: []},
          {headline: 'Deal', caption: 'Iced latte now only ৳199!', hashtags: [], cta: 'Hurry', contentPillar: 'promo', visualIdea: 'sign', complianceFlags: []},
        ],
      };
      const res = await api()
        .post('/v1/ai/captions')
        .set(as(owner))
        .send({topic: 'summer drinks', platform: 'FACEBOOK', count: 2})
        .expect(201);
      expect(res.body.options[0].complianceFlags).toEqual([]);
      expect(res.body.options[0].hashtags).toEqual(['cafe']);
      expect(res.body.options[1].complianceFlags.map((f: {code: string}) => f.code)).toContain('unverified_price');
      expect(ai.prompts.at(-1)).toContain('৳350');

      const gen = await prisma.aiGeneration.findUniqueOrThrow({where: {id: res.body.generationId}});
      expect(gen).toMatchObject({inputTokens: 1200, outputTokens: 300, credits: 1, model: 'gpt-4o-mini'});
      expect(Number(gen.estimatedCost)).toBeCloseTo((1200 * 0.15 + 300 * 0.6) / 1_000_000, 8);
      expect(res.body.credits.used).toBe(1);
    });

    it('stops at the plan AI credit limit', async () => {
      await prisma.aiGeneration.create({
        data: {workspaceId: owner.workspaceId, userId: owner.userId, feature: 'captions', provider: 'fake', model: 'x', credits: 29, request: {}},
      });
      const res = await api().post('/v1/ai/captions').set(as(owner)).send({topic: 'x', platform: 'FACEBOOK'}).expect(402);
      expect(res.body.code).toBe('AI_CREDIT_LIMIT');
    });

    it('saves a content plan as unscheduled drafts and resolves repeated slots (FR-05)', async () => {
      const planner = await register('Plan');
      ai.next = {
        items: [
          {dayOffset: 0, platform: 'FACEBOOK', contentPillar: 'product', postIdea: 'Meet the latte', caption: 'Say hi to our latte', hashtags: ['latte'], cta: 'Visit us', visualBrief: 'Latte on table'},
          {dayOffset: 0, platform: 'FACEBOOK', contentPillar: 'team', postIdea: 'Barista', caption: 'Meet our barista', hashtags: [], cta: '', visualBrief: 'Portrait'},
          {dayOffset: 3, platform: 'TIKTOK', contentPillar: 'x', postIdea: 'not allowed', caption: 'skip', hashtags: [], cta: '', visualBrief: ''},
        ],
      };
      const res = await api()
        .post('/v1/ai/content-plans')
        .set(as(planner))
        .send({days: 7, platforms: ['FACEBOOK'], startDate: '2030-01-01'})
        .expect(201);
      const dates = res.body.plan.items.map((i: {date: string}) => i.date);
      expect(dates).toEqual(['2030-01-01', '2030-01-02']);
      const posts = await prisma.post.findMany({where: {contentPlanId: res.body.plan.id}, include: {targets: true}});
      expect(posts).toHaveLength(2);
      expect(posts.every(p => p.status === 'draft' && p.targets.every(t => t.status === 'PENDING'))).toBe(true);
    });
  });

  describe('audit trail and admin (TEST-15, FR-15)', () => {
    it('records approve, schedule, cancel, publish and connect', async () => {
      const owner = await register('Aud');
      const {fb} = await connect(owner, ['FACEBOOK']);
      const media = await upload(owner);
      const post = await createPost(owner, {caption: 'Audit me', mediaIds: [media.id], targets: [{socialAccountId: fb}]});
      await api().post(`/v1/posts/${post.id}/submit`).set(as(owner)).send({}).expect(201);
      await api().post(`/v1/posts/${post.id}/approve`).set(as(owner)).send({version: 1}).expect(201);
      await schedule(owner, post.id).expect(201);
      const t = await prisma.postTarget.findFirstOrThrow({where: {postId: post.id}});
      await api().post(`/v1/post-targets/${t.id}/cancel`).set(as(owner)).send({}).expect(201);
      await schedule(owner, post.id).expect(201);
      await runTarget(t.id);

      const logs = await api().get(`/v1/workspaces/${owner.workspaceId}/audit-logs`).set(as(owner)).expect(200);
      const actions = logs.body.logs.map((l: {action: string}) => l.action);
      expect(actions).toEqual(
        expect.arrayContaining(['social_account.connected', 'post.approved', 'post.scheduled', 'post.cancelled', 'post.published']),
      );
      expect(JSON.stringify(logs.body)).not.toContain('page-token');
    });

    it('restricts the admin API to platform administrators', async () => {
      const user = await register('Nope');
      await api().get('/v1/admin/overview').set(as(user)).expect(403);
      const root = await api()
        .post('/v1/auth/register')
        .send({name: 'Root', email: 'root@e2e.test', password: 'secret123', acceptTerms: true})
        .then(r => (r.status === 201 ? r : api().post('/v1/auth/login').send({email: 'root@e2e.test', password: 'secret123'})));
      const res = await api().get('/v1/admin/overview').set({Authorization: `Bearer ${root.body.token}`}).expect(200);
      expect(res.body.workspaces).toBeGreaterThan(0);
    });
  });

  describe('identity (FR-01)', () => {
    it('requires accepting the terms', async () => {
      await api()
        .post('/v1/auth/register')
        .send({name: 'NoTos', email: `notos-${run}@e2e.test`, password: 'secret123'})
        .expect(400);
    });

    it('verifies email and resets passwords with single-use links', async () => {
      const user = await register('Verify');
      const me = await api().get('/v1/auth/me').set(as(user)).expect(200);
      expect(me.body.user.emailVerified).toBe(false);

      // The mail service logs instead of sending in tests, so issue a token the way it does.
      const token = crypto.randomToken();
      await prisma.emailToken.create({
        data: {userId: user.userId, purpose: 'verify_email', tokenHash: crypto.hash(token), expiresAt: new Date(Date.now() + 60_000)},
      });
      await api().post('/v1/auth/verify-email').send({token}).expect(200);
      await api().post('/v1/auth/verify-email').send({token}).expect(400);

      await api().post('/v1/auth/forgot-password').send({email: 'nobody@e2e.test'}).expect(200);
      const reset = crypto.randomToken();
      await prisma.emailToken.create({
        data: {userId: user.userId, purpose: 'reset_password', tokenHash: crypto.hash(reset), expiresAt: new Date(Date.now() + 60_000)},
      });
      await api().post('/v1/auth/reset-password').send({token: reset, password: 'new-password-1'}).expect(200);
      await api().post('/v1/auth/login').send({email: user.email, password: 'new-password-1'}).expect(201);
    });
  });
});
