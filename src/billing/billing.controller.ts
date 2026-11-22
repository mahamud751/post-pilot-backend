import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {PlanCode} from '@prisma/client';
import {IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength} from 'class-validator';
import type {Request, Response} from 'express';
import {JwtAuthGuard} from '../auth/jwt-auth.guard';
import {CurrentUserId} from '../common/decorators/current-user.decorator';
import {CurrentWorkspace} from '../common/decorators/current-workspace.decorator';
import {
  RequireRoles,
  WORKSPACE_HEADER,
  WorkspaceContext,
  WorkspaceGuard,
} from '../workspaces/workspace.guard';
import {BillingService} from './billing.service';
import {PAID_PLANS} from './plans';

class CheckoutDto {
  @IsIn(PAID_PLANS)
  plan: PlanCode;

  @IsIn(['monthly', 'annual'])
  cycle: 'monthly' | 'annual';

  @IsOptional() @IsString() @Matches(/^\+?[0-9 ()-]{7,25}$/) phone?: string;
  @IsOptional() @IsString() @MaxLength(50) address?: string;
  @IsOptional() @IsString() @MaxLength(50) city?: string;
}

class CancelDto {
  @IsBoolean()
  cancel: boolean;
}

@ApiTags('billing')
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Get()
  @ApiBearerAuth()
  @ApiHeader({name: WORKSPACE_HEADER, required: false})
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  overview(@CurrentWorkspace() ctx: WorkspaceContext) {
    return this.billingService.overview(ctx.id);
  }

  @Post('checkout')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles('OWNER')
  checkout(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: CheckoutDto,
  ) {
    return this.billingService.checkout(ctx, userId, input.plan, input.cycle, input);
  }

  @Post('sslcommerz/ipn')
  @HttpCode(200)
  onlineNotification(@Body() body: Record<string, unknown>) {
    return this.billingService.confirmOnlinePayment(typeof body.val_id === 'string' ? body.val_id : '');
  }

  @Post('sslcommerz/return')
  async onlineReturn(@Body() body: Record<string, unknown>, @Res() response: Response) {
    // Only server-validated payments activate plans. Browser status fields are untrusted.
    if (typeof body.val_id === 'string' && body.val_id) {
      await this.billingService.confirmOnlinePayment(body.val_id);
      return response.redirect(303, this.billingService.paymentReturnUrl('verified'));
    }
    return response.redirect(303, this.billingService.paymentReturnUrl('pending'));
  }

  @Post('cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, WorkspaceGuard)
  @RequireRoles('OWNER')
  async cancel(
    @CurrentWorkspace() ctx: WorkspaceContext,
    @CurrentUserId() userId: string,
    @Body() input: CancelDto,
  ) {
    const subscription = await this.billingService.cancelAtPeriodEnd(ctx, userId, input.cancel);
    return {subscription};
  }

  /** Payment provider callback; authenticated by HMAC signature, not by user session. */
  @Post('webhook')
  @HttpCode(200)
  webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-postpilot-signature') signature: string | undefined,
    @Headers('x-billing-provider') provider: string | undefined,
  ) {
    this.billingService.verifySignature(req.rawBody, signature);
    return this.billingService.handleEvent(provider || 'webhook', req.body);
  }
}
