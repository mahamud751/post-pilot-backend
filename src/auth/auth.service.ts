import {ConflictException, Injectable, UnauthorizedException} from '@nestjs/common';
import {JwtService} from '@nestjs/jwt';
import {compare, hash} from 'bcrypt';
import {PrismaService} from '../prisma/prisma.service';
import {LoginDto} from './dto/login.dto';
import {RegisterDto} from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async register(input: RegisterDto) {
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
      user: {id: user.id, name: user.name, email: user.email, createdAt: user.createdAt},
    };
  }

  async login(input: LoginDto) {
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
      user: {id: user.id, name: user.name, email: user.email, createdAt: user.createdAt},
    };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({where: {id: userId}});
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    return {user: {id: user.id, name: user.name, email: user.email, createdAt: user.createdAt}};
  }
}

