import {Controller, Get, Query, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {SocialAuthService} from './social-auth.service';

@ApiTags('social-auth')
@Controller('social-auth')
export class SocialAuthController {
  constructor(private readonly socialAuthService: SocialAuthService) {}

  @Get('verify-config')
  verifyConfig() {
    return this.socialAuthService.getVerifyConfig();
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('facebook/connect')
  facebookConnect(@CurrentUserId() userId: string, @Query('userId') _userId?: string) {
    return this.socialAuthService.getFacebookConnectUrl(userId);
  }

  @Get('facebook/callback')
  facebookCallback(@Query('code') code: string, @Query('state') state: string) {
    return this.socialAuthService.handleFacebookCallback(code, state);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('tiktok/connect')
  tiktokConnect(@CurrentUserId() userId: string, @Query('userId') _userId?: string) {
    return this.socialAuthService.getTikTokConnectUrl(userId);
  }

  @Get('tiktok/callback')
  tiktokCallback(@Query('code') code: string, @Query('state') state: string) {
    return this.socialAuthService.handleTikTokCallback(code, state);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('youtube/connect')
  youtubeConnect(@CurrentUserId() userId: string, @Query('userId') _userId?: string) {
    return this.socialAuthService.getYouTubeConnectUrl(userId);
  }

  @Get('youtube/callback')
  youtubeCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error?: string,
    @Query('error_description') errorDescription?: string,
  ) {
    return this.socialAuthService.handleYouTubeCallback(code, state, error, errorDescription);
  }
}
