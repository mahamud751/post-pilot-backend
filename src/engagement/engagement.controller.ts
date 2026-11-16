import {Body, Controller, Get, Param, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {IsOptional, IsString, MaxLength} from 'class-validator';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {CONTENT_WRITERS, RequireRoles, WORKSPACE_HEADER, WorkspaceContext, WorkspaceGuard} from '../workspaces/workspace.guard';
import {EngagementService} from './engagement.service';

class ReplyDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  text?: string;
}

/** Comment and DM inbox: what autopilot answered, drafted, or left for a person. */
@ApiTags('inbox')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('autopilot/inbox')
export class EngagementController {
  constructor(private readonly engagement: EngagementService) {}

  @Get()
  list(@CurrentWorkspace() ctx: WorkspaceContext, @Query('status') status?: string) {
    return this.engagement.list(ctx, status);
  }

  @Post(':id/reply')
  @RequireRoles(...CONTENT_WRITERS)
  reply(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: ReplyDto,
  ) {
    return this.engagement.sendManual(ctx, userId, id, input.text);
  }

  @Post(':id/skip')
  @RequireRoles(...CONTENT_WRITERS)
  skip(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.engagement.skip(ctx, id);
  }
}
