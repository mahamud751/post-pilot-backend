import {Global, Module} from '@nestjs/common';
import {BillingController} from './billing.controller';
import {BillingService} from './billing.service';
import {EntitlementsService} from './entitlements.service';

@Global()
@Module({
  controllers: [BillingController],
  providers: [BillingService, EntitlementsService],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
