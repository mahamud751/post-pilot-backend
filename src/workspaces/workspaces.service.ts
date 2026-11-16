import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {AuditService} from '../audit/audit.service';
import {EntitlementsService} from '../billing/entitlements.service';
import {PrismaService} from '../prisma/prisma.service';
import {
  CreateWorkspaceDto,
  InviteMemberDto,
  UpdateMemberDto,
  UpdateWorkspaceDto,
} from './dto/workspace.dto';
import type {WorkspaceContext} from './workspace.guard';

const memberSelect = {
  id: true,
  role: true,
  inviteStatus: true,
  createdAt: true,
  user: {select: {id: true, name: true, email: true, avatarUrl: true}},
} satisfies Prisma.WorkspaceMemberSelect;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly entitlements: EntitlementsService,
  ) {}

  /** Creates a workspace with `userId` as OWNER. Accepts a transaction so signup stays atomic. */
  async create(
    userId: string,
    input: CreateWorkspaceDto,
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    await this.entitlements.assertCanCreateWorkspace(userId);
    const name = input.name.trim();
    const workspace = await tx.workspace.create({
      data: {
        name,
        timezone: input.timezone || 'Asia/Dhaka',
        businessType: input.businessType?.trim() || null,
        ownerId: userId,
        members: {create: {userId, role: 'OWNER'}},
        brand: {create: {name}},
        subscription: {create: EntitlementsService.newTrial()},
      },
    });
    await this.audit.record(
      {
        workspaceId: workspace.id,
        actorId: userId,
        action: 'workspace.created',
        entityType: 'workspace',
        entityId: workspace.id,
      },
      tx,
    );
    return workspace;
  }

  async listForUser(userId: string) {
    const memberships = await this.prisma.workspaceMember.findMany({
      where: {userId, workspace: {state: 'active'}},
      include: {workspace: true},
      orderBy: {createdAt: 'asc'},
    });
    return memberships.map(m => ({
      ...this.serialize(m.workspace),
      role: m.role,
      inviteStatus: m.inviteStatus,
    }));
  }

  async get(ctx: WorkspaceContext) {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({where: {id: ctx.id}});
    return {...this.serialize(workspace), role: ctx.role};
  }

  async update(ctx: WorkspaceContext, actorId: string, input: UpdateWorkspaceDto) {
    const workspace = await this.prisma.workspace.update({
      where: {id: ctx.id},
      data: {
        name: input.name?.trim(),
        timezone: input.timezone,
        businessType: input.businessType?.trim(),
        approvalRequired: input.approvalRequired,
      },
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: 'workspace.updated',
      entityType: 'workspace',
      entityId: ctx.id,
      metadata: {...input},
    });
    return {...this.serialize(workspace), role: ctx.role};
  }

  listMembers(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
      where: {workspaceId},
      select: memberSelect,
      orderBy: {createdAt: 'asc'},
    });
  }

  async invite(ctx: WorkspaceContext, actorId: string, input: InviteMemberDto) {
    this.assertCanAssign(ctx, input.role);

    // Invites go to existing accounts only until email invitations ship.
    const user = await this.prisma.user.findUnique({
      where: {email: input.email.toLowerCase()},
    });
    if (!user) {
      throw new NotFoundException('No PostPilot account uses that email. Ask them to sign up first.');
    }

    try {
      const member = await this.prisma.workspaceMember.create({
        data: {workspaceId: ctx.id, userId: user.id, role: input.role, inviteStatus: 'PENDING'},
        select: memberSelect,
      });
      await this.audit.record({
        workspaceId: ctx.id,
        actorId,
        action: 'member.invited',
        entityType: 'workspace_member',
        entityId: member.id,
        metadata: {userId: user.id, role: input.role},
      });
      return member;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('That user is already a member or has a pending invite');
      }
      throw error;
    }
  }

  /** Accepts a pending invite. Not behind WorkspaceGuard, since pending members aren't active yet. */
  async acceptInvite(userId: string, workspaceId: string) {
    const member = await this.prisma.workspaceMember.findUnique({
      where: {workspaceId_userId: {workspaceId, userId}},
    });
    if (!member || member.inviteStatus !== 'PENDING') {
      throw new NotFoundException('No pending invite for this workspace');
    }
    await this.prisma.workspaceMember.update({
      where: {id: member.id},
      data: {inviteStatus: 'ACTIVE'},
    });
    await this.audit.record({
      workspaceId,
      actorId: userId,
      action: 'member.joined',
      entityType: 'workspace_member',
      entityId: member.id,
    });
    return {ok: true};
  }

  async updateMember(
    ctx: WorkspaceContext,
    actorId: string,
    memberId: string,
    input: UpdateMemberDto,
  ) {
    const member = await this.findMember(ctx.id, memberId);
    this.assertCanManage(ctx, member.role);
    this.assertCanAssign(ctx, input.role);

    const updated = await this.prisma.workspaceMember.update({
      where: {id: member.id},
      data: {role: input.role},
      select: memberSelect,
    });
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: 'member.role_changed',
      entityType: 'workspace_member',
      entityId: member.id,
      metadata: {from: member.role, to: input.role},
    });
    return updated;
  }

  async removeMember(ctx: WorkspaceContext, actorId: string, memberId: string) {
    const member = await this.findMember(ctx.id, memberId);
    const leavingSelf = member.userId === actorId;
    if (member.role === 'OWNER') {
      throw new ForbiddenException('The workspace owner cannot be removed');
    }
    if (!leavingSelf) {
      this.assertCanManage(ctx, member.role);
    }

    await this.prisma.workspaceMember.delete({where: {id: member.id}});
    await this.audit.record({
      workspaceId: ctx.id,
      actorId,
      action: leavingSelf ? 'member.left' : 'member.removed',
      entityType: 'workspace_member',
      entityId: member.id,
      metadata: {userId: member.userId},
    });
    return {ok: true};
  }

  private async findMember(workspaceId: string, memberId: string) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {id: memberId, workspaceId},
    });
    if (!member) {
      throw new NotFoundException('Member not found');
    }
    return member;
  }

  /** Only managers act on others; only the owner may act on admins. */
  private assertCanManage(ctx: WorkspaceContext, targetRole: string) {
    if (ctx.role !== 'OWNER' && ctx.role !== 'ADMIN') {
      throw new ForbiddenException('Your role does not allow managing members');
    }
    if (targetRole === 'OWNER' || (targetRole === 'ADMIN' && ctx.role !== 'OWNER')) {
      throw new ForbiddenException('Only the owner can change admins');
    }
  }

  private assertCanAssign(ctx: WorkspaceContext, role: string) {
    if (role === 'ADMIN' && ctx.role !== 'OWNER') {
      throw new ForbiddenException('Only the owner can grant the admin role');
    }
  }

  private serialize(workspace: {
    id: string;
    name: string;
    timezone: string;
    businessType: string | null;
    ownerId: string;
    approvalRequired: boolean;
    onboardingStep?: string;
    createdAt: Date;
  }) {
    return {
      id: workspace.id,
      name: workspace.name,
      timezone: workspace.timezone,
      businessType: workspace.businessType,
      ownerId: workspace.ownerId,
      approvalRequired: workspace.approvalRequired,
      onboardingStep: workspace.onboardingStep,
      createdAt: workspace.createdAt,
    };
  }
}
