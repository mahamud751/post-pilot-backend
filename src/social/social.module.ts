import {Global, Module} from '@nestjs/common';
import {LegacyTokenMigrator} from './legacy-token-migrator';
import {MetaOAuthService} from './meta-oauth.service';
import {SocialAccountsService} from './social-accounts.service';
import {SocialController} from './social.controller';

@Global()
@Module({
  controllers: [SocialController],
  providers: [SocialAccountsService, MetaOAuthService, LegacyTokenMigrator],
  exports: [SocialAccountsService],
})
export class SocialModule {}
