import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual} from 'crypto';

const VERSION = 'v1';

/**
 * AES-256-GCM encryption for provider tokens at rest (PRD FR-03) and HMAC signing for
 * short-lived URLs and OAuth state.
 */
@Injectable()
export class CryptoService {
  private readonly logger = new Logger(CryptoService.name);
  private readonly key: Buffer;
  private readonly signingKey: Buffer;

  constructor(config: ConfigService) {
    const raw = config.get<string>('TOKEN_ENCRYPTION_KEY');
    const production = config.get<string>('NODE_ENV') === 'production';
    if (raw) {
      this.key = Buffer.from(raw, 'base64');
      if (this.key.length !== 32) {
        throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
      }
    } else if (production) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be configured in production.');
    } else {
      this.logger.warn('TOKEN_ENCRYPTION_KEY not set; deriving a development key from JWT_SECRET.');
      const seed = config.get<string>('JWT_SECRET', 'postpilot-dev-secret');
      this.key = createHash('sha256').update(`token-key:${seed}`).digest();
    }
    this.signingKey = createHash('sha256').update(Buffer.concat([Buffer.from('sign:'), this.key])).digest();
  }

  encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(payload: string) {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== VERSION || !iv || !tag || !data) {
      throw new Error('Unsupported ciphertext format');
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }

  sign(value: string) {
    return createHmac('sha256', this.signingKey).update(value).digest('base64url');
  }

  verify(value: string, signature: string) {
    const expected = Buffer.from(this.sign(value));
    const given = Buffer.from(String(signature || ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  randomToken(bytes = 32) {
    return randomBytes(bytes).toString('base64url');
  }

  hash(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}
