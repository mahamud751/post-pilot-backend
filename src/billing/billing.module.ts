import {Global, Module} from '@nestjs/common';
import {BillingController} from './billing.controller';
import {BillingService} from './billing.service';
import {EntitlementsService} from './entitlements.service';
import {SslcommerzGateway} from './sslcommerz.gateway';

@Global()
@Module({
  controllers: [BillingController],
  providers: [BillingService, EntitlementsService, SslcommerzGateway],
  exports: [BillingService, EntitlementsService],
})
export class BillingModule {}
