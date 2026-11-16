import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UseGuards,
} from '@nestjs/common';
import {ApiBearerAuth, ApiHeader, ApiTags} from '@nestjs/swagger';
import {PlanCode} from '@prisma/client';
import {IsBoolean, IsIn} from 'class-validator';
import type {Request} from 'express';
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
    return this.billingService.checkout(ctx, userId, input.plan, input.cycle);
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
