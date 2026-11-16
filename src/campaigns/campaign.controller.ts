import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  CONTENT_WRITERS,
  RequireRoles,
  WORKSPACE_HEADER,
  WORKSPACE_MANAGERS,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {
  CampaignActionDto,
  CreateCampaignDto,
  UpdateCampaignItemDto,
} from './campaign.dto';
import {CampaignService} from './campaign.service';

@ApiTags('campaigns')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('campaigns')
export class CampaignController {
  constructor(private readonly campaigns: CampaignService) {}

  @Get('options')
  options(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.campaigns.options(ctx);
  }

  @Get()
  list(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.campaigns.list(ctx);
  }

  @Get(':id')
  get(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.campaigns.get(ctx, id);
  }

  @Post()
  @RequireRoles(...CONTENT_WRITERS)
  create(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: CreateCampaignDto,
  ) {
    return this.campaigns.create(ctx, userId, input);
  }

  @Patch(':id/items/:itemId')
  @RequireRoles(...CONTENT_WRITERS)
  updateItem(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() input: UpdateCampaignItemDto,
  ) {
    return this.campaigns.updateItem(ctx, userId, id, itemId, input);
  }

  @Post(':id/actions')
  @RequireRoles(...WORKSPACE_MANAGERS)
  action(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
    @Body() input: CampaignActionDto,
  ) {
    return this.campaigns.action(ctx, userId, id, input.action);
  }
}
