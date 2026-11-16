import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {JwtService} from '@nestjs/jwt';
import {Prisma, User} from '@prisma/client';
import {compare, hash} from 'bcrypt';
import {CryptoService} from '../crypto/crypto.service';
import {MailService} from '../mail/mail.service';
import {PrismaService} from '../prisma/prisma.service';
import {WorkspacesService} from '../workspaces/workspaces.service';
import {ChangePasswordDto, GoogleLoginDto, ResetPasswordDto} from './dto/account.dto';
import {LoginDto} from './dto/login.dto';
import {RegisterDto} from './dto/register.dto';
import {UpdateProfileDto} from './dto/update-profile.dto';

const VERIFY_TTL_MS = 48 * 3600_000;
const RESET_TTL_MS = 3600_000;
const RESEND_COOLDOWN_MS = 60_000;
const GOOGLE_STATE_TTL_MS = 10 * 60_000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly workspacesService: WorkspacesService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private webUrl() {
    return (this.config.get<string>('WEB_APP_URL') || 'http://localhost:3000').replace(/\/+$/, '');
  }

  private normalizePrismaError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      if (error.code === 'P2021') {
        throw new ServiceUnavailableException('Database not ready. Please run Prisma migrations.');
      }
    }
    if (error instanceof Prisma.PrismaClientInitializationError) {
      throw new ServiceUnavailableException('Database connection failed. Please check DATABASE_URL.');
    }
    throw new InternalServerErrorException('Auth service failed. Please try again.');
  }

  private isSuperAdmin(user: User) {
    const configured = String(this.config.get<string>('SUPER_ADMIN_EMAILS') || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    return user.isSuperAdmin || configured.includes(user.email.toLowerCase());
  }

  serializeUser(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      emailVerified: Boolean(user.emailVerifiedAt),
      hasPassword: Boolean(user.passwordHash),
      googleLinked: Boolean(user.googleId),
      emailNotifications: user.emailNotifications,
      isSuperAdmin: this.isSuperAdmin(user),
      createdAt: user.createdAt,
      // Read by the mobile app until it moves to workspace social accounts.
      facebookName: user.facebookName,
      instagramName: user.instagramName,
      facebookPageId: user.facebookPageId,
      facebookPageName: user.facebookPageName,
      facebookVerified: user.facebookVerified,
      instagramVerified: user.instagramVerified,
    };
  }

  private async session(user: User) {
    return {
      token: this.jwtService.sign({userId: user.id}),
      user: this.serializeUser(user),
      workspaces: await this.workspacesService.listForUser(user.id),
    };
  }

  async register(input: RegisterDto) {
    try {
      const email = input.email.toLowerCase();
      if (await this.prisma.user.findUnique({where: {email}})) {
        throw new ConflictException('Email already registered');
      }
      const passwordHash = await hash(input.password, 10);
      const user = await this.prisma.$transaction(async tx => {
        const created = await tx.user.create({
          data: {name: input.name.trim(), email, passwordHash, tosAcceptedAt: new Date()},
        });
        await this.workspacesService.create(
          created.id,
          {
            name: input.workspaceName?.trim() || `${input.name.trim()}'s workspace`,
            timezone: input.timezone,
            businessType: input.businessType,
          },
          tx,
        );
        return created;
      });
      await this.sendVerification(user);
      return this.session(user);
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }

  async login(input: LoginDto) {
    try {
      const user = await this.prisma.user.findUnique({where: {email: input.email.toLowerCase()}});
      // Same message for unknown email and wrong password so accounts can't be enumerated.
      if (!user || !user.passwordHash || !(await compare(input.password, user.passwordHash))) {
        throw new UnauthorizedException('Invalid credentials');
      }
      return this.session(user);
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({where: {id: userId}});
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {user: this.serializeUser(user), workspaces: await this.workspacesService.listForUser(userId)};
  }

  async updateMe(userId: string, input: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: {id: userId},
      data: {
        name: input.name?.trim() || undefined,
        avatarUrl: input.avatarUrl,
        emailNotifications: input.emailNotifications,
      },
    });
    return {user: this.serializeUser(user)};
  }

  async changePassword(userId: string, input: ChangePasswordDto) {
    const user = await this.prisma.user.findUniqueOrThrow({where: {id: userId}});
    if (user.passwordHash && !(input.currentPassword && (await compare(input.currentPassword, user.passwordHash)))) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    await this.prisma.user.update({where: {id: userId}, data: {passwordHash: await hash(input.newPassword, 10)}});
    return {ok: true};
  }

  // ---------- email tokens ----------

  private async issueToken(userId: string, purpose: 'verify_email' | 'reset_password', ttlMs: number) {
    const token = this.crypto.randomToken();
    await this.prisma.emailToken.create({
      data: {userId, purpose, tokenHash: this.crypto.hash(token), expiresAt: new Date(Date.now() + ttlMs)},
    });
    return token;
  }

  private async consumeToken(token: string, purpose: 'verify_email' | 'reset_password') {
    const record = await this.prisma.emailToken.findUnique({where: {tokenHash: this.crypto.hash(token)}});
    if (!record || record.purpose !== purpose || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('This link is invalid or has expired');
    }
    const used = await this.prisma.emailToken.updateMany({
      where: {id: record.id, usedAt: null},
      data: {usedAt: new Date()},
    });
    if (used.count === 0) {
      throw new BadRequestException('This link has already been used');
    }
    return record;
  }

  private async sendVerification(user: User) {
    const token = await this.issueToken(user.id, 'verify_email', VERIFY_TTL_MS);
    await this.mail.send(
      user.email,
      'Verify your PostPilot email',
      `Hi ${user.name},\n\nConfirm your email to finish setting up PostPilot:\n${this.webUrl()}/verify-email?token=${token}\n\nThe link expires in 48 hours.`,
    );
  }

  async resendVerification(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({where: {id: userId}});
    if (user.emailVerifiedAt) {
      return {ok: true, alreadyVerified: true};
    }
    const recent = await this.prisma.emailToken.findFirst({
      where: {userId, purpose: 'verify_email', createdAt: {gt: new Date(Date.now() - RESEND_COOLDOWN_MS)}},
    });
    if (!recent) {
      await this.sendVerification(user);
    }
    return {ok: true};
  }

  async verifyEmail(token: string) {
    const record = await this.consumeToken(token, 'verify_email');
    const user = await this.prisma.user.update({
      where: {id: record.userId},
      data: {emailVerifiedAt: new Date()},
    });
    return {ok: true, user: this.serializeUser(user)};
  }

  /** Always succeeds so the endpoint can't be used to discover which emails have accounts. */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({where: {email: email.toLowerCase()}});
    if (user) {
      const token = await this.issueToken(user.id, 'reset_password', RESET_TTL_MS);
      await this.mail.send(
        user.email,
        'Reset your PostPilot password',
        `Hi ${user.name},\n\nReset your password here:\n${this.webUrl()}/reset-password?token=${token}\n\nThe link expires in 1 hour. If you didn't ask for this, ignore this email.`,
      );
    }
    return {ok: true};
  }

  async resetPassword(input: ResetPasswordDto) {
    const record = await this.consumeToken(input.token, 'reset_password');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: {id: record.userId},
        // Resetting through an emailed link also proves the address.
        data: {passwordHash: await hash(input.password, 10), emailVerifiedAt: new Date()},
      }),
      this.prisma.emailToken.updateMany({
        where: {userId: record.userId, purpose: 'reset_password', usedAt: null},
        data: {usedAt: new Date()},
      }),
    ]);
    return {ok: true};
  }

  // ---------- Google sign-in ----------

  private googleRedirectUri() {
    return `${this.webUrl()}/api/auth/google/callback`;
  }

  googleAuthUrl() {
    const clientId = this.config.get<string>('GOOGLE_CLIENT_ID');
    if (!clientId || !this.config.get<string>('GOOGLE_CLIENT_SECRET')) {
      throw new BadRequestException('Google sign-in is not configured');
    }
    const payload = `${this.crypto.randomToken(16)}.${Date.now() + GOOGLE_STATE_TTL_MS}`;
    const state = `${payload}.${this.crypto.sign(`google:${payload}`)}`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: this.googleRedirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    return {url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, state};
  }

  async googleLogin(input: GoogleLoginDto) {
    const [nonce, exp, sig] = input.state.split('.');
    if (!nonce || !exp || !sig || Number(exp) < Date.now() || !this.crypto.verify(`google:${nonce}.${exp}`, sig)) {
      throw new UnauthorizedException('Google sign-in expired. Please try again.');
    }
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        code: input.code,
        client_id: String(this.config.get<string>('GOOGLE_CLIENT_ID')),
        client_secret: String(this.config.get<string>('GOOGLE_CLIENT_SECRET')),
        redirect_uri: this.googleRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const tokens = (await tokenResponse.json().catch(() => ({}))) as {access_token?: string; error_description?: string};
    if (!tokenResponse.ok || !tokens.access_token) {
      throw new UnauthorizedException(tokens.error_description || 'Google sign-in failed');
    }
    const infoResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: {Authorization: `Bearer ${tokens.access_token}`},
      signal: AbortSignal.timeout(20_000),
    });
    const info = (await infoResponse.json().catch(() => ({}))) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    };
    if (!info.sub || !info.email || !info.email_verified) {
      throw new UnauthorizedException('Your Google account email is not verified');
    }
    const email = info.email.toLowerCase();

    let user =
      (await this.prisma.user.findUnique({where: {googleId: info.sub}})) ||
      (await this.prisma.user.findUnique({where: {email}}));
    if (user) {
      user = await this.prisma.user.update({
        where: {id: user.id},
        data: {googleId: info.sub, emailVerifiedAt: user.emailVerifiedAt || new Date()},
      });
      return this.session(user);
    }
    if (!input.acceptTerms) {
      throw new BadRequestException({code: 'TERMS_REQUIRED', message: 'Accept the Terms and Privacy Policy to create your account'});
    }
    const name = info.name?.trim() || email.split('@')[0];
    const created = await this.prisma.$transaction(async tx => {
      const u = await tx.user.create({
        data: {
          name,
          email,
          googleId: info.sub,
          avatarUrl: info.picture,
          emailVerifiedAt: new Date(),
          tosAcceptedAt: new Date(),
        },
      });
      await this.workspacesService.create(u.id, {name: `${name}'s workspace`}, tx);
      return u;
    });
    return this.session(created);
  }
}
