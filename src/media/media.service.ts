import {BadRequestException, Injectable, NotFoundException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Media, Prisma} from '@prisma/client';
import {randomUUID} from 'crypto';
import {existsSync} from 'fs';
import {mkdir, rename, unlink, writeFile} from 'fs/promises';
import {imageSize} from 'image-size';
import {join} from 'path';
import {AuditService} from '../audit/audit.service';
import {CryptoService} from '../crypto/crypto.service';
import {PrismaService} from '../prisma/prisma.service';
import {sha256File, sniffFile, storagePath, TMP_DIR, UPLOAD_ROOT} from './media-storage';

const SIGNED_URL_TTL_SEC = 7 * 86_400;

export type MediaQuery = {folder?: string; tag?: string; type?: 'image' | 'video'; cursor?: string; take?: number};

@Injectable()
export class MediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Public base for media links; MEDIA_PUBLIC_URL lets local dev serve files while APP_URL stays on the OAuth host. */
  private apiBase() {
    return (
      this.config.get<string>('MEDIA_PUBLIC_URL') ||
      this.config.get<string>('APP_URL') ||
      'http://localhost:9001/v1'
    ).replace(/\/+$/, '');
  }

  /**
   * Absolute URL for a stored file. Workspace uploads get an expiring signature; legacy uploads
   * (stored at the root before workspaces existed) keep their public /uploads path.
   */
  urlFor(media: Pick<Media, 'storageKey' | 'filename' | 'url'>, ttlSec = SIGNED_URL_TTL_SEC) {
    const key = media.storageKey || media.filename;
    if (!key.includes('/')) {
      return `${this.apiBase().replace(/\/v1$/, '')}/uploads/${encodeURIComponent(key)}`;
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = this.crypto.sign(`${key}:${exp}`);
    return `${this.apiBase()}/media/files/${key.split('/').map(encodeURIComponent).join('/')}?exp=${exp}&sig=${sig}`;
  }

  /** Validates a signed file request and returns the path to stream, or null. */
  resolveSignedFile(key: string, exp: string, sig: string) {
    const expiry = Number(exp);
    if (!Number.isFinite(expiry) || expiry < Date.now() / 1000 || !this.crypto.verify(`${key}:${expiry}`, sig)) {
      return null;
    }
    const path = storagePath(key);
    return existsSync(path) ? path : null;
  }

  serialize(media: Media) {
    return {
      id: media.id,
      originalName: media.originalName,
      mimeType: media.mimeType,
      kind: media.mimeType.startsWith('video/') ? 'video' : 'image',
      size: media.size,
      width: media.width,
      height: media.height,
      sha256: media.sha256,
      folder: media.folder,
      tags: media.tags,
      url: this.urlFor(media),
      deleted: Boolean(media.deletedAt),
      createdAt: media.createdAt,
    };
  }

  async save(workspaceId: string, userId: string, file: Express.Multer.File) {
    const sniffed = await sniffFile(file.path);
    if (!sniffed) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('Unsupported file. Upload a JPEG, PNG, GIF, WebP, MP4, MOV or WebM file.');
    }
    // A file named .jpg that is really something else is rejected rather than relabelled.
    const declared = String(file.mimetype || '').split('/')[0];
    if (declared && declared !== sniffed.mime.split('/')[0]) {
      await unlink(file.path).catch(() => undefined);
      throw new BadRequestException('The file contents do not match its type.');
    }

    let width: number | null = null;
    let height: number | null = null;
    if (sniffed.mime.startsWith('image/')) {
      try {
        const dims = imageSize(file.path);
        width = dims.width ?? null;
        height = dims.height ?? null;
      } catch {
        await unlink(file.path).catch(() => undefined);
        throw new BadRequestException('The image could not be read. It may be corrupted.');
      }
    }

    const sha256 = await sha256File(file.path);
    const key = `${workspaceId}/${randomUUID()}.${sniffed.ext}`;
    await mkdir(join(UPLOAD_ROOT, workspaceId), {recursive: true});
    await rename(file.path, storagePath(key));

    const media = await this.prisma.media.create({
      data: {
        workspaceId,
        userId,
        filename: key.split('/')[1],
        storageKey: key,
        originalName: file.originalname.slice(0, 255),
        mimeType: sniffed.mime,
        size: file.size,
        sha256,
        width,
        height,
        url: '',
      },
    });
    await this.audit.record({
      workspaceId,
      actorId: userId,
      action: 'media.uploaded',
      entityType: 'media',
      entityId: media.id,
      metadata: {mimeType: media.mimeType, size: media.size, sha256},
    });
    return {media: this.serialize(media)};
  }

  /** Stores bytes produced by the image model or FFmpeg. The file type is taken from its contents. */
  async saveGenerated(
    workspaceId: string,
    userId: string,
    input: {bytes: Buffer; originalName: string; folder?: string; tags?: string[]},
  ) {
    await mkdir(TMP_DIR, {recursive: true});
    const temp = join(TMP_DIR, randomUUID());
    await writeFile(temp, input.bytes);
    const saved = await this.save(workspaceId, userId, {
      path: temp,
      mimetype: '',
      originalname: input.originalName,
      size: input.bytes.length,
    } as Express.Multer.File);
    if (input.folder || input.tags?.length) {
      const updated = await this.update(workspaceId, userId, saved.media.id, {folder: input.folder, tags: input.tags});
      return updated.media;
    }
    return saved.media;
  }

  async list(workspaceId: string, query: MediaQuery) {
    const take = Math.min(Math.max(Number(query.take) || 40, 1), 100);
    const where: Prisma.MediaWhereInput = {
      workspaceId,
      deletedAt: null,
      ...(query.folder ? {folder: query.folder} : {}),
      ...(query.tag ? {tags: {has: query.tag}} : {}),
      ...(query.type ? {mimeType: {startsWith: `${query.type}/`}} : {}),
    };
    const items = await this.prisma.media.findMany({
      where,
      orderBy: [{createdAt: 'desc'}, {id: 'desc'}],
      take: take + 1,
      ...(query.cursor ? {cursor: {id: query.cursor}, skip: 1} : {}),
    });
    const folders = await this.prisma.media.findMany({
      where: {workspaceId, deletedAt: null, folder: {not: null}},
      distinct: ['folder'],
      select: {folder: true},
    });
    return {
      media: items.slice(0, take).map(m => this.serialize(m)),
      nextCursor: items.length > take ? items[take - 1].id : null,
      folders: folders.map(f => f.folder).filter(Boolean),
    };
  }

  async findMany(workspaceId: string, ids: string[]) {
    if (ids.length === 0) {
      return [];
    }
    const media = await this.prisma.media.findMany({where: {workspaceId, id: {in: ids}}});
    const byId = new Map(media.map(m => [m.id, m]));
    return ids.map(id => byId.get(id)).filter((m): m is Media => Boolean(m));
  }

  async update(workspaceId: string, actorId: string, id: string, input: {folder?: string | null; tags?: string[]}) {
    const media = await this.prisma.media.findFirst({where: {id, workspaceId, deletedAt: null}});
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    const updated = await this.prisma.media.update({
      where: {id},
      data: {
        folder: input.folder === undefined ? undefined : input.folder?.trim() || null,
        tags: input.tags?.map(t => t.trim().toLowerCase()).filter(Boolean),
      },
    });
    await this.audit.record({
      workspaceId,
      actorId,
      action: 'media.updated',
      entityType: 'media',
      entityId: id,
      metadata: {folder: updated.folder, tags: updated.tags},
    });
    return {media: this.serialize(updated)};
  }

  /** Soft delete: hidden from the library, but kept so published posts' history stays intact. */
  async remove(workspaceId: string, actorId: string, id: string) {
    const media = await this.prisma.media.findFirst({where: {id, workspaceId, deletedAt: null}});
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    await this.prisma.media.update({where: {id}, data: {deletedAt: new Date()}});
    await this.audit.record({
      workspaceId,
      actorId,
      action: 'media.deleted',
      entityType: 'media',
      entityId: id,
    });
    return {ok: true};
  }
}
