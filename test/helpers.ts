import {INestApplication} from '@nestjs/common';
import {Test} from '@nestjs/testing';
import {SocialAccount, SocialPlatform} from '@prisma/client';
import * as request from 'supertest';
import {AiProvider, AiProviderRegistry, AiResult} from '../src/ai/ai-provider';
import {AppModule} from '../src/app.module';
import {configureApp} from '../src/configure-app';
import {CryptoService} from '../src/crypto/crypto.service';
import {PrismaService} from '../src/prisma/prisma.service';
import {PlatformAdapter, PlatformAdapters, PublishContent, ReconcileResult} from '../src/publishing/adapters';
import {PublishQueueService} from '../src/publishing/publish-queue.service';

export const run = Date.now().toString(36);

/** Scriptable stand-in for the Meta adapters. Unscripted publishes succeed. */
export class FakeAdapters {
  calls: {platform: SocialPlatform; account: string; content: PublishContent}[] = [];
  private scripts: Partial<Record<SocialPlatform, (() => Promise<{remotePostId: string}>)[]>> = {};
  reconcileResult: ReconcileResult = {state: 'unknown'};
  reconcileCalls = 0;

  script(platform: SocialPlatform, ...steps: (() => Promise<{remotePostId: string}>)[]) {
    (this.scripts[platform] ||= []).push(...steps);
  }

  reset() {
    this.calls = [];
    this.scripts = {};
    this.reconcileResult = {state: 'unknown'};
    this.reconcileCalls = 0;
  }

  get(platform: SocialPlatform): PlatformAdapter {
    return {
      publish: async (account: SocialAccount, _token: string, content: PublishContent) => {
        this.calls.push({platform, account: account.id, content});
        const step = this.scripts[platform]?.shift();
        return step ? step() : {remotePostId: `${platform.toLowerCase()}_${this.calls.length}`};
      },
      reconcile: async () => {
        this.reconcileCalls++;
        return this.reconcileResult;
      },
    };
  }
}

/** Deterministic AI provider: returns whatever `next` holds, with fixed token counts. */
export class FakeAi implements AiProvider {
  readonly name = 'fake';
  readonly model = 'gpt-4o-mini';
  next: unknown = {options: []};
  prompts: string[] = [];

  async generateJson(_system: string, prompt: string): Promise<AiResult> {
    this.prompts.push(prompt);
    return {json: this.next, provider: this.name, model: this.model, inputTokens: 1200, outputTokens: 300};
  }
}

export type Account = {token: string; workspaceId: string; email: string; userId: string};

export async function createApp() {
  const adapters = new FakeAdapters();
  const ai = new FakeAi();
  const moduleRef = await Test.createTestingModule({imports: [AppModule]})
    .overrideProvider(PlatformAdapters)
    .useValue(adapters)
    .overrideProvider(AiProviderRegistry)
    .useValue({get: () => ai})
    .compile();
  const app = moduleRef.createNestApplication({rawBody: true});
  configureApp(app);
  await app.init();
  await app.get(PublishQueueService).queue.obliterate({force: true});
  return {app, adapters, ai, prisma: app.get(PrismaService), crypto: app.get(CryptoService)};
}

export function client(app: INestApplication) {
  const api = () => request(app.getHttpServer());
  const as = (account: Account, workspaceId = account.workspaceId) => ({
    Authorization: `Bearer ${account.token}`,
    'x-workspace-id': workspaceId,
  });
  async function register(name: string, extra: Record<string, unknown> = {}): Promise<Account> {
    const email = `${name.toLowerCase()}-${run}@e2e.test`;
    const res = await api()
      .post('/v1/auth/register')
      .send({name, email, password: 'secret123', workspaceName: `${name} Cafe`, acceptTerms: true, ...extra})
      .expect(201);
    return {token: res.body.token, workspaceId: res.body.workspaces[0].id, email, userId: res.body.user.id};
  }
  return {api, as, register};
}

/** A PNG header with the given dimensions: enough for type sniffing and size detection. */
export function pngBytes(width = 1080, height = 1080) {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr, Buffer.alloc(64)]);
}

/** A baseline JPEG header (SOI + JFIF APP0 + SOF0) with the given dimensions. */
export function jpegBytes(width = 1080, height = 1080) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
