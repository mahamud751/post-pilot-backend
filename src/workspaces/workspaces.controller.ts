import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {AuditService} from '../audit/audit.service';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  CreateWorkspaceDto,
  InviteMemberDto,
  UpdateMemberDto,
  UpdateWorkspaceDto,
} from './dto/workspace.dto';
import {
  RequireRoles,
  WORKSPACE_MANAGERS,
  WorkspaceContext,
  WorkspaceGuard,
} from './workspace.guard';
import {WorkspacesService} from './workspaces.service';

@ApiTags('workspaces')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspacesService: WorkspacesService,
    private readonly auditService: AuditService,
  ) {}

  @Get()
  async list(@CurrentUserId() userId: string) {
    const workspaces = await this.workspacesService.listForUser(userId);
    return {workspaces};
  }

  @Post()
  async create(@CurrentUserId() userId: string, @Body() input: CreateWorkspaceDto) {
    const workspace = await this.workspacesService.create(userId, input);
    return {workspace: {...workspace, role: 'OWNER'}};
  }

  @Post(':workspaceId/accept')
  accept(@CurrentUserId() userId: string, @Param('workspaceId') workspaceId: string) {
    return this.workspacesService.acceptInvite(userId, workspaceId);
  }

  @Get(':workspaceId')
  @UseGuards(WorkspaceGuard)
  async get(@CurrentWorkspace() ctx: WorkspaceContext) {
    const workspace = await this.workspacesService.get(ctx);
    return {workspace};
  }

  @Patch(':workspaceId')
  @UseGuards(WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async update(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: UpdateWorkspaceDto,
  ) {
    const workspace = await this.workspacesService.update(ctx, userId, input);
    return {workspace};
  }

  @Get(':workspaceId/members')
  @UseGuards(WorkspaceGuard)
  async members(@CurrentWorkspace() ctx: WorkspaceContext) {
    const members = await this.workspacesService.listMembers(ctx.id);
    return {members};
  }

  @Post(':workspaceId/members')
  @UseGuards(WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async invite(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: InviteMemberDto,
  ) {
    const member = await this.workspacesService.invite(ctx, userId, input);
    return {member};
  }

  @Patch(':workspaceId/members/:memberId')
  @UseGuards(WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async updateMember(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('memberId') memberId: string,
    @Body() input: UpdateMemberDto,
  ) {
    const member = await this.workspacesService.updateMember(ctx, userId, memberId, input);
    return {member};
  }

  @Delete(':workspaceId/members/:memberId')
  @UseGuards(WorkspaceGuard)
  removeMember(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('memberId') memberId: string,
  ) {
    return this.workspacesService.removeMember(ctx, userId, memberId);
  }

  @Get(':workspaceId/audit-logs')
  @UseGuards(WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async auditLogs(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @Query('take', new DefaultValuePipe(50), ParseIntPipe) take: number,
  ) {
    const logs = await this.auditService.list(ctx.id, take);
    return {logs};
  }
}
