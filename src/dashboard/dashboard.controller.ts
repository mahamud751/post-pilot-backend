import {Controller, Get, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {WORKSPACE_HEADER, WorkspaceContext, WorkspaceGuard} from '../workspaces/workspace.guard';
import {DashboardService} from './dashboard.service';

@ApiTags('dashboard')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @Get()
  get(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string) {
    return this.dashboardService.getDashboard(ctx, userId);
  }
}
