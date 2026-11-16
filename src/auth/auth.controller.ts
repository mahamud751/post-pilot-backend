import {Body, Controller, Get, HttpCode, Patch, Post, UseGuards} from '@nestjs/common';
import {ApiBearerAuth, ApiTags} from '@nestjs/swagger';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {AuthService} from './auth.service';
import {AuthThrottlerGuard} from './auth-throttler.guard';
import {ChangePasswordDto, EmailDto, GoogleLoginDto, ResetPasswordDto, TokenDto} from './dto/account.dto';
import {LoginDto} from './dto/login.dto';
import {RegisterDto} from './dto/register.dto';
import {UpdateProfileDto} from './dto/update-profile.dto';
import {JwtAuthGuard} from './jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @UseGuards(AuthThrottlerGuard)
  register(@Body() input: RegisterDto) {
    return this.authService.register(input);
  }

  @Post('login')
  @UseGuards(AuthThrottlerGuard)
  login(@Body() input: LoginDto) {
    return this.authService.login(input);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  me(@CurrentUserId() userId: string) {
    return this.authService.me(userId);
  }

  @Patch('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  updateMe(@CurrentUserId() userId: string, @Body() input: UpdateProfileDto) {
    return this.authService.updateMe(userId, input);
  }

  @Post('change-password')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  changePassword(@CurrentUserId() userId: string, @Body() input: ChangePasswordDto) {
    return this.authService.changePassword(userId, input);
  }

  @Post('verify-email')
  @HttpCode(200)
  verifyEmail(@Body() input: TokenDto) {
    return this.authService.verifyEmail(input.token);
  }

  @Post('resend-verification')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  resendVerification(@CurrentUserId() userId: string) {
    return this.authService.resendVerification(userId);
  }

  @Post('forgot-password')
  @HttpCode(200)
  @UseGuards(AuthThrottlerGuard)
  forgotPassword(@Body() input: EmailDto) {
    return this.authService.forgotPassword(input.email);
  }

  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() input: ResetPasswordDto) {
    return this.authService.resetPassword(input);
  }

  @Get('google/url')
  googleUrl() {
    return this.authService.googleAuthUrl();
  }

  @Post('google')
  @HttpCode(200)
  google(@Body() input: GoogleLoginDto) {
    return this.authService.googleLogin(input);
  }
}
