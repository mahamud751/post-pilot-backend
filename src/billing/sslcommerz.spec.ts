import {ConfigService} from '@nestjs/config';
import {BillingService, addPeriod} from './billing.service';
import {SslcommerzGateway} from './sslcommerz.gateway';

describe('Verified online billing', () => {
  it('clamps billing periods at month end and leap years', () => {
    expect(addPeriod(new Date('2026-01-31T10:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addPeriod(new Date('2024-02-29T10:00:00Z'), 'annual').toISOString()).toBe('2025-02-28T10:00:00.000Z');
  });
  it('requires configuration before starting a gateway session', async () => {
    const gateway = new SslcommerzGateway(new ConfigService({}));
    expect(gateway.ready()).toBe(false);
    await expect(gateway.validate('id')).rejects.toThrow('not configured');
  });
  const good = {status: 'VALIDATED', tran_id: 'reference', val_id: 'validation', amount: '499.00', currency: 'BDT', risk_level: '0'};
  function setup(payment: Record<string, unknown>) {
    const prisma = {invoice: {findFirst: jest.fn().mockResolvedValue({id: 'invoice', workspaceId: 'workspace', plan: 'STARTER', amount: 49900, currency: 'BDT', providerRef: 'reference', billingCycle: 'annual'})}};
    const gateway = {validate: jest.fn().mockResolvedValue(payment)};
    const service = new BillingService(prisma as never, new ConfigService({BILLING_PROVIDER: 'sslcommerz'}), {} as never, {} as never, {} as never, gateway as never);
    const event = jest.spyOn(service, 'handleEvent').mockResolvedValue({received: true, duplicate: false});
    return {service, event};
  }
  it.each([{...good, amount: '1'}, {...good, currency: 'USD'}, {...good, risk_level: '1'}, {...good, status: 'FAILED'}, {...good, val_id: 'different'}])('never activates a mismatched, risky or failed payment', async payment => {
    const {service, event} = setup(payment);
    await expect(service.confirmOnlinePayment('validation')).rejects.toThrow();
    expect(event).not.toHaveBeenCalled();
  });
  it('uses the persisted invoice identity, plan and cycle for idempotent activation', async () => {
    const {service, event} = setup(good);
    await service.confirmOnlinePayment('validation');
    expect(event).toHaveBeenCalledWith('sslcommerz', {id: 'invoice:invoice', type: 'payment.succeeded', data: {workspaceId: 'workspace', plan: 'STARTER', cycle: 'annual', amount: 49900, reference: 'reference'}});
  });
});
