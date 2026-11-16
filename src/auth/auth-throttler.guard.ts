import {Injectable} from '@nestjs/common';
import {ThrottlerGuard} from '@nestjs/throttler';

/**
 * Rate-limits auth attempts per email address (PRD FR-01).
 * Keyed on email rather than IP because the web app calls the API from its own server,
 * so every browser user arrives from the same address.
 */
@Injectable()
export class AuthThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    return email || req.ip;
  }
}
