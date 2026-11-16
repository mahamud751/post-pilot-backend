import {createHash} from 'crypto';
import {createReadStream} from 'fs';
import {open} from 'fs/promises';
import {join, resolve} from 'path';

export const UPLOAD_ROOT = resolve(process.cwd(), 'uploads');
export const TMP_DIR = join(UPLOAD_ROOT, 'tmp');

const SIGNATURES: {mime: string; ext: string; test: (b: Buffer) => boolean}[] = [
  {mime: 'image/jpeg', ext: 'jpg', test: b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff},
  {mime: 'image/png', ext: 'png', test: b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))},
  {mime: 'image/gif', ext: 'gif', test: b => b.subarray(0, 4).toString('latin1') === 'GIF8'},
  {mime: 'image/webp', ext: 'webp', test: b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'},
  {mime: 'video/quicktime', ext: 'mov', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp' && b.subarray(8, 12).toString('latin1') === 'qt  '},
  {mime: 'video/mp4', ext: 'mp4', test: b => b.subarray(4, 8).toString('latin1') === 'ftyp'},
  {mime: 'video/webm', ext: 'webm', test: b => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))},
];

/** Identifies the file from its leading bytes; the client-supplied MIME type is not trusted. */
export async function sniffFile(path: string) {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(16);
    await handle.read(buffer, 0, 16, 0);
    return SIGNATURES.find(s => s.test(buffer)) || null;
  } finally {
    await handle.close();
  }
}

export function sha256File(path: string) {
  return new Promise<string>((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Resolves a storage key to a path inside the upload root, rejecting traversal. */
export function storagePath(key: string) {
  const full = resolve(UPLOAD_ROOT, key);
  if (!full.startsWith(`${UPLOAD_ROOT}/`)) {
    throw new Error('Invalid storage key');
  }
  return full;
}
