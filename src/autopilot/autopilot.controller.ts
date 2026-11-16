import {Body, Controller, Delete, Get, Param, Patch, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {SocialPlatform} from '@prisma/client';
import {Type} from 'class-transformer';
import {IsEnum, IsNumber, IsOptional, IsString, MaxLength, Min} from 'class-validator';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {CreativeKind} from '../intelligence/creative.service';
import {ResearchService} from '../intelligence/research.service';
import {
  CONTENT_WRITERS,
  RequireRoles,
  WORKSPACE_HEADER,
  WORKSPACE_MANAGERS,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {UpdateAutopilotDto} from './autopilot.dto';
import {AutopilotService} from './autopilot.service';

class WatchDto {
  @IsEnum(SocialPlatform)
  platform: SocialPlatform;

  @IsString()
  @MaxLength(300)
  externalId: string;
}

class SaleDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  postId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  externalRef?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @IsOptional()
  @IsString()
  occurredAt?: string;
}

class CreativeDto {
  @IsString()
  @MaxLength(1000)
  prompt: string;

  @IsEnum(['image', 'thumbnail', 'video'])
  kind: CreativeKind;

  @IsOptional()
  @IsString()
  postId?: string;
}

@ApiTags('autopilot')
@ApiBearerAuth()
@ApiHeader({name: WORKSPACE_HEADER, required: false})
@UseGuards(JwtAuthGuard, WorkspaceGuard)
@Controller('autopilot')
export class AutopilotController {
  constructor(
    private readonly autopilot: AutopilotService,
    private readonly research: ResearchService,
  ) {}

  @Get()
  overview(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.autopilot.overview(ctx);
  }

  @Patch()
  @RequireRoles(...WORKSPACE_MANAGERS)
  update(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: UpdateAutopilotDto,
  ) {
    return this.autopilot.update(ctx, userId, input);
  }

  @Post('sync')
  @RequireRoles(...CONTENT_WRITERS)
  sync(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.autopilot.sync(ctx);
  }

  @Post('run')
  @RequireRoles(...CONTENT_WRITERS)
  run(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string) {
    return this.autopilot.run(ctx, userId);
  }

  @Post('experiments/:id/cancel')
  @RequireRoles(...CONTENT_WRITERS)
  cancel(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.autopilot.cancelExperiment(ctx, id);
  }

  @Post('trends/refresh')
  @RequireRoles(...CONTENT_WRITERS)
  trends(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.research.refreshTrends(ctx.id);
  }

  @Post('competitors')
  @RequireRoles(...CONTENT_WRITERS)
  addCompetitor(@CurrentWorkspace() ctx: WorkspaceContext, @Body() input: WatchDto) {
    return this.research.addCompetitor(ctx.id, input.platform, input.externalId);
  }

  @Delete('competitors/:id')
  @RequireRoles(...CONTENT_WRITERS)
  removeCompetitor(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return this.research.removeCompetitor(ctx.id, id);
  }

  @Post('competitors/refresh')
  @RequireRoles(...CONTENT_WRITERS)
  refreshCompetitors(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.research.refreshCompetitors(ctx.id);
  }

  @Post('sales')
  @RequireRoles(...CONTENT_WRITERS)
  sale(@CurrentWorkspace() ctx: WorkspaceContext, @Body() input: SaleDto) {
    return this.research.recordSale(ctx.id, input, 'manual');
  }

  @Post('conversion-key')
  @RequireRoles(...WORKSPACE_MANAGERS)
  conversionKey(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.research.issueConversionKey(ctx.id);
  }

  @Post('creatives')
  @RequireRoles(...CONTENT_WRITERS)
  creative(@CurrentWorkspace() ctx: WorkspaceContext, @CurrentUserId() userId: string, @Body() input: CreativeDto) {
    return this.autopilot.createCreative(ctx, userId, input);
  }
}
