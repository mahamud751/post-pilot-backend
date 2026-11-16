import {Body, Controller, Get, Param, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  CONTENT_WRITERS,
  RequireRoles,
  WORKSPACE_HEADER,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {CaptionRequestDto, ContentPlanRequestDto, FeedbackDto, RegenerateDto} from './ai.dto';
import {AiService} from './ai.service';

@ApiTags('ai')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('captions')
  @RequireRoles(...CONTENT_WRITERS)
  captions(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: CaptionRequestDto,
  ) {
    return this.aiService.captions(ctx, userId, input);
  }

  @Post('captions/regenerate')
  @RequireRoles(...CONTENT_WRITERS)
  regenerate(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: RegenerateDto,
  ) {
    return this.aiService.regenerate(ctx, userId, input);
  }

  @Post('content-plans')
  @RequireRoles(...CONTENT_WRITERS)
  contentPlan(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: ContentPlanRequestDto,
  ) {
    return this.aiService.contentPlan(ctx, userId, input);
  }

  @Post('generations/:id/feedback')
  @RequireRoles(...CONTENT_WRITERS)
  feedback(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string, @Body() input: FeedbackDto) {
    return this.aiService.feedback(ctx, id, input.value);
  }

  @Get('history')
  history(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.aiService.history(ctx);
  }
}
