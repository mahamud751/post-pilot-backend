import {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import * as request from 'supertest';
import {AppModule} from '../src/app.module';
import {configureApp} from '../src/configure-app';
import {PrismaService} from '../src/prisma/prisma.service';
import {pngBytes} from './helpers';

const run = Date.now().toString(36);

type Account = {token: string; workspaceId: string; email: string};

describe('Workspaces and tenant isolation (PRD TEST-01)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let alice: Account;
  let bob: Account;

  const api = () => request(app.getHttpServer());
  const as = (account: Account, workspaceId = account.workspaceId) => ({
    Authorization: `Bearer ${account.token}`,
    'x-workspace-id': workspaceId,
  });

  async function register(name: string): Promise<Account> {
    const email = `${name.toLowerCase()}-${run}@e2e.test`;
    const res = await api()
      .post('/v1/auth/register')
      .send({name, email, password: 'secret123', workspaceName: `${name} Cafe`, acceptTerms: true})
      .expect(201);
    return {token: res.body.token, workspaceId: res.body.workspaces[0].id, email};
  }

  async function memberId(owner: Account, email: string) {
    const res = await api()
      .get(`/v1/workspaces/${owner.workspaceId}/members`)
      .set(as(owner))
      .expect(200);
    return res.body.members.find((m: {user: {email: string}}) => m.user.email === email).id;
  }

  /** Invites `member` into `owner`'s workspace with `role` and accepts it. */
  async function join(owner: Account, member: Account, role: string) {
    await api()
      .post(`/v1/workspaces/${owner.workspaceId}/members`)
      .set(as(owner))
      .send({email: member.email, role})
      .expect(201);
    await api()
      .post(`/v1/workspaces/${owner.workspaceId}/accept`)
      .set({Authorization: `Bearer ${member.token}`})
      .expect(201);
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({imports: [AppModule]}).compile();
    app = moduleRef.createNestApplication({rawBody: true});
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    alice = await register('Alice');
    bob = await register('Bob');
  });

  afterAll(async () => {
    await app.close();
  });

  it('gives each new account its own workspace as OWNER with the default timezone', async () => {
    const res = await api().get('/v1/workspaces').set(as(alice)).expect(200);
    expect(res.body.workspaces).toEqual([
      expect.objectContaining({
        id: alice.workspaceId,
        name: 'Alice Cafe',
        role: 'OWNER',
        timezone: 'Asia/Dhaka',
      }),
    ]);
    expect(alice.workspaceId).not.toEqual(bob.workspaceId);
  });

  describe('cross-workspace access', () => {
    let alicePostId: string;

    beforeAll(async () => {
      const res = await api()
        .post('/v1/posts')
        .set(as(alice))
        .send({caption: 'Alice secret draft', platforms: ['facebook']})
        .expect(201);
      alicePostId = res.body.post.id;
    });

    it('does not list another workspace’s posts', async () => {
      const res = await api().get('/v1/posts').set(as(bob)).expect(200);
      expect(res.body.posts.map((p: {id: string}) => p.id)).not.toContain(alicePostId);
    });

    it('rejects selecting a workspace the user is not a member of', async () => {
      await api().get('/v1/posts').set(as(bob, alice.workspaceId)).expect(403);
      await api().get(`/v1/workspaces/${alice.workspaceId}`).set(as(bob)).expect(403);
      await api().get(`/v1/workspaces/${alice.workspaceId}/members`).set(as(bob)).expect(403);
    });

    it('returns the same 403 for a workspace that does not exist', async () => {
      await api().get('/v1/posts').set(as(bob, 'no-such-workspace')).expect(403);
    });

    it('cannot edit or delete another workspace’s post by ID', async () => {
      await api()
        .patch(`/v1/posts/${alicePostId}`)
        .set(as(bob))
        .send({caption: 'hijacked'})
        .expect(404);
      await api().delete(`/v1/posts/${alicePostId}`).set(as(bob)).expect(404);

      const post = await prisma.post.findUniqueOrThrow({where: {id: alicePostId}});
      expect(post.caption).toBe('Alice secret draft');
    });

    it('does not expose dashboard data across workspaces', async () => {
      const res = await api().get('/v1/dashboard').set(as(bob)).expect(200);
      expect(res.body.statusCounts.draft || 0).toBe(0);
      expect(JSON.stringify(res.body)).not.toContain(alicePostId);
    });

    it('stores media under the uploader’s current workspace', async () => {
      const res = await api()
        .post('/v1/media/upload')
        .set(as(alice))
        .attach('file', pngBytes(), {filename: 'a.png', contentType: 'image/png'})
        .expect(201);
      const media = await prisma.media.findUniqueOrThrow({where: {id: res.body.media.id}});
      expect(media.workspaceId).toBe(alice.workspaceId);
    });
  });

  describe('roles', () => {
    let carol: Account;
    let dave: Account;

    beforeAll(async () => {
      carol = await register('Carol');
      dave = await register('Dave');
    });

    it('does not grant access while an invite is pending', async () => {
      await api()
        .post(`/v1/workspaces/${carol.workspaceId}/members`)
        .set(as(carol))
        .send({email: dave.email, role: 'VIEWER'})
        .expect(201);
      await api().get('/v1/posts').set(as(dave, carol.workspaceId)).expect(403);

      await api()
        .post(`/v1/workspaces/${carol.workspaceId}/accept`)
        .set({Authorization: `Bearer ${dave.token}`})
        .expect(201);
      await api().get('/v1/posts').set(as(dave, carol.workspaceId)).expect(200);
    });

    it('lets a viewer read but not write', async () => {
      await api()
        .post('/v1/posts')
        .set(as(dave, carol.workspaceId))
        .send({caption: 'nope'})
        .expect(403);
      await api()
        .patch(`/v1/workspaces/${carol.workspaceId}`)
        .set(as(dave, carol.workspaceId))
        .send({name: 'renamed'})
        .expect(403);
    });

    it('blocks editors from scheduling when approval is required (PRD TEST-02)', async () => {
      const id = await memberId(carol, dave.email);
      await api()
        .patch(`/v1/workspaces/${carol.workspaceId}/members/${id}`)
        .set(as(carol))
        .send({role: 'EDITOR'})
        .expect(200);
      await api()
        .patch(`/v1/workspaces/${carol.workspaceId}`)
        .set(as(carol))
        .send({approvalRequired: true})
        .expect(200);

      const draft = await api()
        .post('/v1/posts')
        .set(as(dave, carol.workspaceId))
        .send({caption: 'draft is fine'})
        .expect(201);
      const res = await api()
        .post(`/v1/posts/${draft.body.post.id}/schedule`)
        .set(as(dave, carol.workspaceId))
        .send({confirm: true, scheduledAt: new Date(Date.now() + 86_400_000).toISOString()})
        .expect(403);
      expect(res.body.message).toMatch(/requires approval/);
    });

    it('protects the owner and the admin role', async () => {
      const eve = await register('Eve');
      await join(carol, eve, 'ADMIN');

      await api()
        .delete(`/v1/workspaces/${carol.workspaceId}/members/${await memberId(carol, carol.email)}`)
        .set(as(eve, carol.workspaceId))
        .expect(403);
      await api()
        .patch(`/v1/workspaces/${carol.workspaceId}/members/${await memberId(carol, dave.email)}`)
        .set(as(eve, carol.workspaceId))
        .send({role: 'ADMIN'})
        .expect(403);
    });

    it('rejects an invalid timezone', async () => {
      await api()
        .patch(`/v1/workspaces/${carol.workspaceId}`)
        .set(as(carol))
        .send({timezone: 'Mars/Olympus'})
        .expect(400);
    });
  });

  describe('auth', () => {
    it('returns 401, not 500, for a wrong password', async () => {
      await api()
        .post('/v1/auth/login')
        .send({email: alice.email, password: 'wrong-password'})
        .expect(401);
    });

    it('rate-limits repeated login attempts for one email', async () => {
      const email = `throttle-${run}@e2e.test`;
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await api().post('/v1/auth/login').send({email, password: 'whatever'});
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every(s => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });

  it('records actions in the workspace audit log (PRD TEST-15)', async () => {
    const res = await api()
      .get(`/v1/workspaces/${alice.workspaceId}/audit-logs`)
      .set(as(alice))
      .expect(200);
    const actions = res.body.logs.map((l: {action: string}) => l.action);
    expect(actions).toEqual(expect.arrayContaining(['workspace.created', 'post.created']));
  });
});
