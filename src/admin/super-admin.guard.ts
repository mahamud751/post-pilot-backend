import {CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {PrismaService} from '../prisma/prisma.service';

/** Platform super-admin (PRD section 5). Every admin request is logged (FR-15). */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  private readonly logger = new Logger('AdminAccess');

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = request.user?.userId
      ? await this.prisma.user.findUnique({where: {id: request.user.userId}})
      : null;
    const allowed = String(this.config.get<string>('SUPER_ADMIN_EMAILS') || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);
    if (!user || !(user.isSuperAdmin || allowed.includes(user.email.toLowerCase()))) {
      throw new ForbiddenException('Platform administrators only');
    }
    this.logger.log(`${user.email} ${request.method} ${request.originalUrl}`);
    return true;
  }
}
