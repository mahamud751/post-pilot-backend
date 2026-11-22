import {BadRequestException, Injectable, ServiceUnavailableException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';

export type BillingCustomer = {phone?: string; address?: string; city?: string};
export type ValidatedPayment = {status: string; tran_id: string; val_id: string; amount: string; currency: string; risk_level: string};

/** Hosted checkout: card/mobile payment details never pass through PostPilot. */
@Injectable()
export class SslcommerzGateway {
  constructor(private readonly config: ConfigService) {}
  ready() { return Boolean(this.config.get('SSLCOMMERZ_STORE_ID') && this.config.get('SSLCOMMERZ_STORE_PASSWORD') && this.config.get('APP_URL') && this.config.get('WEB_APP_URL')); }
  private base() { return this.config.get<string>('SSLCOMMERZ_SANDBOX') === 'false' ? 'https://securepay.sslcommerz.com' : 'https://sandbox.sslcommerz.com'; }
  private credentials() {
    if (!this.ready()) throw new ServiceUnavailableException('Online payments are not configured yet. Contact the workspace administrator.');
    return {store_id: this.config.get<string>('SSLCOMMERZ_STORE_ID')!, store_passwd: this.config.get<string>('SSLCOMMERZ_STORE_PASSWORD')!};
  }
  async initiate(input: {reference: string; amount: number; plan: string; name: string; email: string; customer: BillingCustomer}) {
    const credentials = this.credentials();
    const {phone, address, city} = input.customer;
    if (!phone?.trim() || !address?.trim() || !city?.trim()) throw new BadRequestException('Enter your billing phone, address and city before checkout.');
    const callback = `${this.config.get<string>('APP_URL')!.replace(/\/+$/, '')}/billing/sslcommerz/return`;
    const form = new URLSearchParams({...credentials, tran_id: input.reference, total_amount: (input.amount / 100).toFixed(2), currency: 'BDT',
      success_url: callback, fail_url: callback, cancel_url: callback,
      ipn_url: `${this.config.get<string>('APP_URL')!.replace(/\/+$/, '')}/billing/sslcommerz/ipn`,
      cus_name: input.name.slice(0, 50), cus_email: input.email, cus_phone: phone.trim(), cus_add1: address.trim(), cus_city: city.trim(), cus_country: 'Bangladesh',
      shipping_method: 'NO', num_of_item: '1', product_name: `PostPilot ${input.plan}`, product_category: 'Software', product_profile: 'non-physical-goods', emi_option: '0',
    });
    let result: {status?: string; GatewayPageURL?: string};
    try {
      const response = await fetch(`${this.base()}/gwprocess/v4/api.php`, {method: 'POST', body: form, signal: AbortSignal.timeout(15_000)});
      if (!response.ok) throw new Error('Gateway unavailable');
      result = await response.json();
    } catch { throw new ServiceUnavailableException('The payment gateway is unavailable. Please try again shortly.'); }
    if (result.status !== 'SUCCESS' || !result.GatewayPageURL) throw new BadRequestException('The payment gateway could not start checkout. Please check your billing details or contact support.');
    const url = new URL(result.GatewayPageURL);
    if (url.protocol !== 'https:' || !(url.hostname === 'sslcommerz.com' || url.hostname.endsWith('.sslcommerz.com'))) throw new ServiceUnavailableException('The gateway returned an invalid checkout URL.');
    return url.toString();
  }
  async validate(validationId: string): Promise<ValidatedPayment> {
    const credentials = this.credentials();
    if (!validationId || validationId.length > 100) throw new BadRequestException('Missing payment validation ID.');
    const query = new URLSearchParams({...credentials, val_id: validationId, format: 'json'});
    try {
      const response = await fetch(`${this.base()}/validator/api/validationserverAPI.php?${query}`, {signal: AbortSignal.timeout(15_000)});
      if (!response.ok) throw new Error('Validation unavailable');
      return await response.json() as ValidatedPayment;
    } catch { throw new ServiceUnavailableException('Payment validation is temporarily unavailable. Your payment notification will be retried.'); }
  }
}
