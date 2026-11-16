import {Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {execFile, spawn} from 'child_process';
import {promisify} from 'util';
import {randomUUID} from 'crypto';
import {writeFile, mkdtemp, rm} from 'fs/promises';
import {tmpdir} from 'os';
import {join} from 'path';
import {EntitlementsService} from '../billing/entitlements.service';
import {AI_CREDIT_COST} from '../billing/plans';
import {MediaService} from '../media/media.service';
import {PostsService} from '../posts/posts.service';
import {PrismaService} from '../prisma/prisma.service';
import type {WorkspaceContext} from '../workspaces/workspace.guard';

export type CreativeKind = 'image' | 'thumbnail' | 'video';

@Injectable()
export class CreativeService {
  constructor(
    private readonly config: ConfigService,
    private readonly media: MediaService,
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly posts: PostsService,
  ) {}

  async capabilities() {
    const imageConfigured = Boolean(this.config.get<string>('OPENAI_API_KEY') || this.config.get<string>('GEMINI_API_KEY'));
    const ffmpeg = await promisify(execFile)('ffmpeg', ['-version'], {timeout: 3000}).then(() => true, () => false);
    return {imageConfigured, ffmpeg};
  }

  /**
   * Image and thumbnail come from the configured image model.
   * Video is a short clip made from that still when FFmpeg is installed. It is not a filmed Reel.
   */
  async create(ctx: WorkspaceContext, userId: string, input: {prompt: string; kind: CreativeKind; postId?: string}) {
    const feature = input.kind === 'video' ? 'video' : 'image';
    await this.entitlements.assertAiCredits(ctx.id, AI_CREDIT_COST[feature]);
    const prompt = input.prompt.trim().slice(0, 1000);
    if (!prompt) throw new ServiceUnavailableException('Describe the image to create.');
    const portrait = input.kind !== 'thumbnail';
    const still = await this.generateStill(prompt, portrait ? '1024x1536' : '1536x1024');
    const jpeg = await this.toJpeg(still, portrait);
    const image = await this.media.saveGenerated(ctx.id, userId, {
      bytes: jpeg || still,
      originalName: jpeg ? 'creative.jpg' : input.kind === 'thumbnail' ? 'thumbnail.png' : 'creative.png',
      folder: 'ai',
      tags: ['ai', input.kind === 'video' ? 'still' : input.kind],
    });
    let video = null as null | {id: string; url: string; mimeType: string};
    let note = input.kind === 'video' ? '' : 'Generated image.';
    if (input.kind === 'video') {
      const clip = await this.stillToClip(still);
      if (!clip) {
        note = 'The image was saved. A video clip needs FFmpeg on the server, which is not available.';
      } else {
        video = await this.media.saveGenerated(ctx.id, userId, {
          bytes: clip,
          originalName: 'creative.mp4',
          folder: 'ai',
          tags: ['ai', 'video'],
        });
        note = 'Short clip built from the generated image. It is a still with motion, not a filmed video.';
      }
    }
    const attached = video || image;
    if (input.postId) {
      const post = await this.prisma.post.findFirstOrThrow({where: {id: input.postId, workspaceId: ctx.id}, select: {id: true, mediaIds: true}});
      await this.posts.update(ctx, userId, post.id, {mediaIds: video ? [video.id] : [...post.mediaIds, image.id].slice(0, 10)});
    }
    await this.prisma.aiGeneration.create({
      data: {
        workspaceId: ctx.id,
        userId,
        feature,
        provider: this.config.get<string>('OPENAI_API_KEY') ? 'openai' : 'gemini',
        model: this.config.get<string>('OPENAI_IMAGE_MODEL') || this.config.get<string>('GEMINI_IMAGE_MODEL') || 'image',
        credits: AI_CREDIT_COST[feature],
        request: {kind: input.kind, prompt},
        output: {mediaId: attached.id, note},
      },
    });
    return {image, video, note};
  }

  private async generateStill(prompt: string, size: string) {
    const openai = this.config.get<string>('OPENAI_API_KEY');
    if (openai) return this.openAiImage(openai, prompt, size);
    const gemini = this.config.get<string>('GEMINI_API_KEY');
    if (gemini) return this.geminiImage(gemini, prompt);
    throw new ServiceUnavailableException('Image generation needs OPENAI_API_KEY or GEMINI_API_KEY on the server.');
  }

  private async openAiImage(apiKey: string, prompt: string, size: string) {
    const model = this.config.get<string>('OPENAI_IMAGE_MODEL') || 'gpt-image-1';
    const dallE = model.startsWith('dall-e');
    const response = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({
        model,
        prompt: `Social image for a brand. No celebrity likeness. No invented prices. ${prompt}`,
        size: dallE ? (size.startsWith('1536') ? '1792x1024' : '1024x1792') : size,
        ...(dallE ? {response_format: 'b64_json'} : {}),
        n: 1,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {data?: {b64_json?: string}[]; error?: {message?: string}};
    if (!response.ok || !payload.data?.[0]?.b64_json) {
      throw new ServiceUnavailableException(payload.error?.message || 'The image model returned no image.');
    }
    return Buffer.from(payload.data[0].b64_json, 'base64');
  }

  private async geminiImage(apiKey: string, prompt: string) {
    const model = this.config.get<string>('GEMINI_IMAGE_MODEL') || 'gemini-2.5-flash-image';
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          contents: [{role: 'user', parts: [{text: `Social image for a brand. No celebrity likeness. No invented prices. ${prompt}`}]}],
          generationConfig: {responseModalities: ['IMAGE']},
        }),
        signal: AbortSignal.timeout(90_000),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: {message?: string};
      candidates?: {content?: {parts?: {inlineData?: {data?: string}}[]}}[];
    };
    const b64 = payload.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data)?.inlineData?.data;
    if (!response.ok || !b64) {
      throw new ServiceUnavailableException(payload.error?.message || 'The image model returned no image.');
    }
    return Buffer.from(b64, 'base64');
  }

  private async toJpeg(still: Buffer, portrait: boolean) {
    const dir = await mkdtemp(join(tmpdir(), 'postpilot-jpg-'));
    try {
      const png = join(dir, 'still.png');
      const jpg = join(dir, 'still.jpg');
      await writeFile(png, still);
      await new Promise<void>((resolve, reject) => {
        const child = spawn('ffmpeg', ['-y', '-i', png, '-vf', portrait ? 'scale=1080:1350:force_original_aspect_ratio=increase,crop=1080:1350' : 'scale=1536:1024:force_original_aspect_ratio=increase,crop=1536:1024', '-q:v', '3', jpg], {stdio: 'ignore'});
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      });
      const {readFile} = await import('fs/promises');
      return await readFile(jpg);
    } catch {
      return null;
    } finally {
      await rm(dir, {recursive: true, force: true}).catch(() => undefined);
    }
  }

  private async stillToClip(still: Buffer) {
    const dir = await mkdtemp(join(tmpdir(), 'postpilot-'));
    const imagePath = join(dir, 'still.png');
    const outPath = join(dir, `${randomUUID()}.mp4`);
    try {
      await writeFile(imagePath, still);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'ffmpeg',
          ['-y', '-loop', '1', '-i', imagePath, '-c:v', 'libx264', '-t', '5', '-pix_fmt', 'yuv420p', '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2', outPath],
          {stdio: 'ignore'},
        );
        child.on('error', reject);
        child.on('close', code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
      });
      const {readFile} = await import('fs/promises');
      return await readFile(outPath);
    } catch {
      return null;
    } finally {
      await rm(dir, {recursive: true, force: true}).catch(() => undefined);
    }
  }
}
