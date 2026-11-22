import {Body, Controller, Get, Headers, HttpCode, Post, Query, RawBodyRequest, Req, UnauthorizedException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import type {Request} from 'express';
import {timingSafeEqual} from 'crypto';
import {PrismaService} from '../prisma/prisma.service';
import {missingScopes} from './meta-inbox';
import {parseMetaWebhook, verifyMetaSignature} from './meta-webhook';

@Controller('webhooks/meta')
export class MetaWebhookController {
  constructor(private readonly config: ConfigService, private readonly prisma: PrismaService) {}

  @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    const secret = this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    const given = Buffer.from(token || ''); const expected = Buffer.from(secret || '');
    if (!secret || mode !== 'subscribe' || given.length !== expected.length || !timingSafeEqual(given, expected) || !challenge || challenge.length > 500) throw new UnauthorizedException('Webhook verification failed');
    return challenge;
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<Request>, @Headers('x-hub-signature-256') signature: string | undefined, @Body() body: unknown) {
    if (!verifyMetaSignature(request.rawBody, signature, this.config.get<string>('FACEBOOK_APP_SECRET'))) throw new UnauthorizedException('Invalid webhook signature');
    let received = 0;
    for (const entry of parseMetaWebhook(body)) {
      if (!entry.messages.length) continue;
      const accounts = await this.prisma.socialAccount.findMany({where: {platformAccountId: entry.accountId, platform: entry.platform, status: 'CONNECTED', workspace: {state: 'active'}}, include: {workspace: {include: {autopilot: true}}}});
      for (const account of accounts) {
        const settings = account.workspace.autopilot;
        if (!settings?.enabled || settings.replyMode === 'OFF') continue;
        const data = entry.messages.filter(message =>
          (message.kind === 'DM' ? settings.replyDms : settings.replyComments) && !missingScopes(account, message.kind).length,
        ).map(message => ({workspaceId: account.workspaceId, socialAccountId: account.id, platform: account.platform, ...message}));
        if (data.length) received += (await this.prisma.engagementItem.createMany({data, skipDuplicates: true})).count;
      }
    }
    // Durable ingestion only. The existing scheduler owns AI triage and its reply limits.
    return {received};
  }
}
