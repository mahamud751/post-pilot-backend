import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import {Reflector} from '@nestjs/core';
import {WorkspaceRole} from '@prisma/client';
import {PrismaService} from '../prisma/prisma.service';

export const WORKSPACE_HEADER = 'x-workspace-id';

const ROLES_KEY = 'workspaceRoles';

/** Restricts a route to members holding one of these roles. Without it, any active member passes. */
export const RequireRoles = (...roles: WorkspaceRole[]) => SetMetadata(ROLES_KEY, roles);

export const CONTENT_WRITERS: WorkspaceRole[] = ['OWNER', 'ADMIN', 'EDITOR'];
export const WORKSPACE_MANAGERS: WorkspaceRole[] = ['OWNER', 'ADMIN'];

export type WorkspaceContext = {
  id: string;
  role: WorkspaceRole;
  timezone: string;
  approvalRequired: boolean;
  ownerId: string;
};

/**
 * Resolves the workspace for a request and verifies active membership (PRD section 5).
 * The workspace comes from the `:workspaceId` route param, then the `x-workspace-id` header,
 * then the user's oldest active membership. Must run after JwtAuthGuard.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const userId: string | undefined = request.user?.userId;
    if (!userId) {
      throw new ForbiddenException('Authentication required');
    }

    const requested = request.params?.workspaceId || request.headers?.[WORKSPACE_HEADER];
    if (Array.isArray(requested)) {
      throw new BadRequestException(`Only one ${WORKSPACE_HEADER} header is allowed`);
    }

    const membership = await this.prisma.workspaceMember.findFirst({
      where: {
        userId,
        inviteStatus: 'ACTIVE',
        ...(requested ? {workspaceId: String(requested)} : {}),
      },
      include: {workspace: true},
      orderBy: {createdAt: 'asc'},
    });

    // Same response for "does not exist" and "not a member" so workspace IDs can't be probed.
    if (!membership || membership.workspace.state !== 'active') {
      throw new ForbiddenException('You do not have access to this workspace');
    }

    const allowed = this.reflector.getAllAndOverride<WorkspaceRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed && !allowed.includes(membership.role)) {
      throw new ForbiddenException('Your role does not allow this action');
    }

    request.workspace = {
      id: membership.workspaceId,
      role: membership.role,
      timezone: membership.workspace.timezone,
      approvalRequired: membership.workspace.approvalRequired,
      ownerId: membership.workspace.ownerId,
    } satisfies WorkspaceContext;
    return true;
  }
}
