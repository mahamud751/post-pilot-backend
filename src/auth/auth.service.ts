import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {JwtService} from '@nestjs/jwt';
import {compare, hash} from 'bcrypt';
import {Prisma} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';
import {LoginDto} from './dto/login.dto';
import {RegisterDto} from './dto/register.dto';
import {UpdateProfileDto} from './dto/update-profile.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  private normalizePrismaError(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        throw new ConflictException('Email already registered');
      }
      if (error.code === 'P2021') {
        throw new ServiceUnavailableException(
          'Database not ready. Please run Prisma migrations.',
        );
      }
    }

    if (error instanceof Prisma.PrismaClientInitializationError) {
      throw new ServiceUnavailableException(
        'Database connection failed. Please check DATABASE_URL.',
      );
    }

    throw new InternalServerErrorException('Auth service failed. Please try again.');
  }

  private serializeUser(user: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    facebookUrl: string | null;
    instagramUrl: string | null;
    youtubeUrl: string | null;
    facebookName: string | null;
    instagramName: string | null;
    youtubeName: string | null;
    facebookVerified: boolean;
    instagramVerified: boolean;
    youtubeVerified: boolean;
    createdAt: Date;
  }) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      facebookUrl: user.facebookUrl,
      instagramUrl: user.instagramUrl,
      youtubeUrl: user.youtubeUrl,
      facebookName: user.facebookName,
      instagramName: user.instagramName,
      youtubeName: user.youtubeName,
      facebookVerified: user.facebookVerified,
      instagramVerified: user.instagramVerified,
      youtubeVerified: user.youtubeVerified,
      createdAt: user.createdAt,
    };
  }

  async register(input: RegisterDto) {
    try {
      const exists = await this.prisma.user.findUnique({
        where: {email: input.email.toLowerCase()},
      });
      if (exists) {
        throw new ConflictException('Email already registered');
      }

      const passwordHash = await hash(input.password, 10);
      const user = await this.prisma.user.create({
        data: {
          name: input.name,
          email: input.email.toLowerCase(),
          passwordHash,
        },
      });

      const token = this.jwtService.sign({userId: user.id});
      return {
        token,
        user: this.serializeUser(user),
      };
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }

  async login(input: LoginDto) {
    try {
      const user = await this.prisma.user.findUnique({
        where: {email: input.email.toLowerCase()},
      });
      if (!user) {
        throw new UnauthorizedException('Invalid credentials');
      }
      const matched = await compare(input.password, user.passwordHash);
      if (!matched) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const token = this.jwtService.sign({userId: user.id});
      return {
        token,
        user: this.serializeUser(user),
      };
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({where: {id: userId}});
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {
      user: this.serializeUser(user),
    };
  }

  async updateMe(userId: string, input: UpdateProfileDto) {
    try {
      const existing = await this.prisma.user.findUnique({where: {id: userId}});
      if (!existing) {
        throw new UnauthorizedException('User not found');
      }
      const user = await this.prisma.user.update({
        where: {id: userId},
        data: {
          ...(typeof input.name === 'string' ? {name: input.name.trim()} : {}),
          ...(typeof input.avatarUrl === 'string' ? {avatarUrl: input.avatarUrl} : {}),
          ...(typeof input.facebookUrl === 'string'
            ? {
                facebookUrl: input.facebookUrl,
                facebookVerified: input.facebookUrl !== existing.facebookUrl ? false : undefined,
              }
            : {}),
          ...(typeof input.instagramUrl === 'string'
            ? {
                instagramUrl: input.instagramUrl,
                instagramVerified:
                  input.instagramUrl !== existing.instagramUrl ? false : undefined,
              }
            : {}),
          ...(typeof input.youtubeUrl === 'string'
            ? {
                youtubeUrl: input.youtubeUrl,
                youtubeVerified: input.youtubeUrl !== existing.youtubeUrl ? false : undefined,
              }
            : {}),
          ...(typeof input.facebookName === 'string' ? {facebookName: input.facebookName} : {}),
          ...(typeof input.instagramName === 'string'
            ? {instagramName: input.instagramName}
            : {}),
          ...(typeof input.youtubeName === 'string' ? {youtubeName: input.youtubeName} : {}),
        },
      });

      return {
        user: this.serializeUser(user),
      };
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }
}

