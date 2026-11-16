import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseEnumPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {SocialPlatform} from '@prisma/client';
import {ArrayMinSize, IsArray, IsString} from 'class-validator';
import type {Response} from 'express';
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
import {MetaOAuthService} from './meta-oauth.service';
import {PLATFORMS} from './platforms';
import {SocialAccountsService} from './social-accounts.service';

class SelectAccountsDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({each: true})
  keys: string[];
}

@ApiTags('social')
@Controller()
export class SocialController {
  constructor(
    private readonly accounts: SocialAccountsService,
    private readonly metaOAuth: MetaOAuthService,
  ) {}

  @Get('social/platforms')
  platforms() {
    return {
      platforms: Object.values(PLATFORMS).map(p => ({
        ...p,
        configured: p.available ? this.metaOAuth.configured() : false,
      })),
      redirectUri: this.metaOAuth.redirectUri(),
    };
  }

  @Get('social-accounts')
  @ApiBearerAuth()
  @ApiHeader({name: WORKSPACE_HEADER, required: false})
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  async list(@CurrentWorkspace() ctx: WorkspaceContext) {
    return {accounts: await this.accounts.list(ctx.id)};
  }

  @Post('social-accounts/:id/check')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async check(@CurrentWorkspace() ctx: WorkspaceContext, @Param('id') id: string) {
    return {account: await this.accounts.checkHealth(ctx, id)};
  }

  @Delete('social-accounts/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  disconnect(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('id') id: string,
  ) {
    return this.accounts.disconnect(ctx, userId, id);
  }

  @Get('social/:platform/connect')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  connect(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('platform', new ParseEnumPipe(SocialPlatform)) platform: SocialPlatform,
  ) {
    return this.metaOAuth.startConnect(ctx, userId, platform);
  }

  /** Browser redirect target registered with Meta; authenticated by single-use state. */
  @Get('social-auth/facebook/callback')
  async facebookCallback(
    @Res() res: Response,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    res.redirect(302, await this.metaOAuth.handleCallback(code, state, error));
  }

  @Get('social/connections/:stateId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  candidates(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('stateId') stateId: string,
  ) {
    return this.metaOAuth.listCandidates(ctx, userId, stateId);
  }

  @Post('social/connections/:stateId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles(...WORKSPACE_MANAGERS)
  async select(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Param('stateId') stateId: string,
    @Body() input: SelectAccountsDto,
  ) {
    return {accounts: await this.metaOAuth.selectCandidates(ctx, userId, stateId, input.keys)};
  }
}
