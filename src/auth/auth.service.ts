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
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
        },
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
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
        },
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
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        createdAt: user.createdAt,
      },
    };
  }

  async updateMe(userId: string, input: UpdateProfileDto) {
    try {
      const user = await this.prisma.user.update({
        where: {id: userId},
        data: {
          ...(typeof input.name === 'string' ? {name: input.name.trim()} : {}),
          ...(typeof input.avatarUrl === 'string' ? {avatarUrl: input.avatarUrl} : {}),
        },
      });

      return {
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          createdAt: user.createdAt,
        },
      };
    } catch (error) {
      this.normalizePrismaError(error);
    }
  }
}

