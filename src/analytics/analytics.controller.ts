import {Controller, Get, Header, Post, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  RequireRoles,
  WORKSPACE_HEADER,
  WORKSPACE_MANAGERS,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {AnalyticsService} from './analytics.service';

@ApiTags('analytics')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('overview')
  overview(@CurrentWorkspace() ctx: WorkspaceContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.overview(ctx, from, to);
  }

  @Get('export.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="postpilot-analytics.csv"')
  export(@CurrentWorkspace() ctx: WorkspaceContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.exportCsv(ctx, from, to);
  }

  @Get('report')
  report(@CurrentWorkspace() ctx: WorkspaceContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.businessReport(ctx, from, to);
  }

  @Get('report.md')
  @Header('Content-Type', 'text/markdown; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="postpilot-report.md"')
  exportReport(@CurrentWorkspace() ctx: WorkspaceContext, @Query('from') from?: string, @Query('to') to?: string) {
    return this.analyticsService.exportReport(ctx, from, to);
  }

  @Post('refresh')
  @RequireRoles(...WORKSPACE_MANAGERS)
  refresh(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string) {
    return this.analyticsService.refresh(ctx, userId);
  }
}
