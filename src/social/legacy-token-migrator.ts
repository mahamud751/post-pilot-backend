import {Injectable, Logger, OnApplicationBootstrap} from '@nestjs/common';
import {PrismaService} from '../prisma/prisma.service';
import {SocialAccountsService} from './social-accounts.service';

/**
 * Moves plaintext Facebook/Instagram tokens from legacy User columns into encrypted
 * SocialAccount rows in the user's own workspace, then clears the plaintext. Idempotent.
 */
@Injectable()
export class LegacyTokenMigrator implements OnApplicationBootstrap {
  private readonly logger = new Logger(LegacyTokenMigrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: SocialAccountsService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.migrate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Legacy token migration failed: ${message}`);
    }
  }

  async migrate() {
    const users = await this.prisma.user.findMany({
      where: {facebookPageAccessToken: {not: null}, facebookPageId: {not: null}},
      include: {ownedWorkspaces: {orderBy: {createdAt: 'asc'}, take: 1}},
    });
    for (const user of users) {
      const workspace = user.ownedWorkspaces[0];
      if (!workspace || !user.facebookPageId || !user.facebookPageAccessToken) {
        continue;
      }
      const pageId = user.facebookPageId;
      const pageToken = user.facebookPageAccessToken;
      await this.prisma.$transaction(async tx => {
        await this.accounts.upsertConnected(tx, {
          workspaceId: workspace.id,
          platform: 'FACEBOOK',
          platformAccountId: pageId,
          name: user.facebookPageName || user.facebookName || 'Facebook Page',
          accessToken: pageToken,
          userToken: user.facebookUserAccessToken,
          scopes: [],
          meta: {pageId},
          connectedById: user.id,
        });
        if (user.instagramBusinessAccountId) {
          await this.accounts.upsertConnected(tx, {
            workspaceId: workspace.id,
            platform: 'INSTAGRAM',
            platformAccountId: user.instagramBusinessAccountId,
            name: user.instagramName ? `@${user.instagramName.replace(/^@/, '')}` : 'Instagram',
            handle: user.instagramName,
            accessToken: pageToken,
            userToken: user.facebookUserAccessToken,
            scopes: [],
            meta: {pageId},
            connectedById: user.id,
          });
        }
        await tx.user.update({
          where: {id: user.id},
          data: {facebookPageAccessToken: null, facebookUserAccessToken: null},
        });
      });
      this.logger.log(`Moved legacy Meta tokens for user ${user.id} into workspace ${workspace.id}`);
    }
  }
}
