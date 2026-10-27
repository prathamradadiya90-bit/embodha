import { Inject, Injectable } from '@nestjs/common';
import { fail } from '../common/errors';
import { hmacSha256, safeEqual } from '../common/crypto';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  notes: Record<string, string> | [];
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
  /** Razorpay's fee including the GST on it, in paise, worked out on the rupee amount. Present once captured. */
  fee?: number | null;
  /** The GST part of the fee, in paise. */
  tax?: number | null;
  /** For a payment in another currency: the rupee amount Razorpay converted it to, which fees and settlement use. */
  base_amount?: number | null;
  base_currency?: string | null;
  /** Set on a subscription's charges: the invoice, which names the subscription. */
  invoice_id?: string | null;
  /** Unix seconds: when the buyer paid. */
  created_at?: number;
  email?: string;
}

export interface RazorpaySubscription {
  id: string;
  plan_id: string;
  status: 'created' | 'authenticated' | 'active' | 'pending' | 'halted' | 'cancelled' | 'completed' | 'expired' | 'paused';
  /** Unix seconds: the paid-up period this subscription is in. */
  current_start?: number | null;
  current_end?: number | null;
  notes: Record<string, string> | [];
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string;
}

/** The few Razorpay calls Embodha makes, plus both signature checks. Amounts are in paise or cents. */
@Injectable()
export class RazorpayService {
  constructor(@Inject(ENV) private readonly env: Env) {}

  get ready() {
    return Boolean(this.env.RAZORPAY_KEY_ID && this.env.RAZORPAY_KEY_SECRET);
  }

  get keyId() {
    return this.env.RAZORPAY_KEY_ID;
  }

  createOrder(input: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) {
    return this.call<RazorpayOrder>('POST', '/orders', input);
  }

  fetchOrder(id: string) {
    return this.call<RazorpayOrder>('GET', `/orders/${encodeURIComponent(id)}`);
  }

  fetchPayment(id: string) {
    return this.call<RazorpayPayment>('GET', `/payments/${encodeURIComponent(id)}`);
  }

  capture(id: string, amount: number, currency: string) {
    return this.call<RazorpayPayment>('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount, currency });
  }

  refund(paymentId: string, amount: number, notes: Record<string, string>) {
    return this.call<RazorpayRefund>('POST', `/payments/${encodeURIComponent(paymentId)}/refund`, { amount, notes });
  }

  createPlan(input: { period: 'monthly'; interval: number; item: { name: string; amount: number; currency: string; description?: string } }) {
    return this.call<{ id: string }>('POST', '/plans', input);
  }

  createSubscription(input: { plan_id: string; total_count: number; customer_notify: 0 | 1; notes: Record<string, string> }) {
    return this.call<RazorpaySubscription>('POST', '/subscriptions', input);
  }

  fetchSubscription(id: string) {
    return this.call<RazorpaySubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`);
  }

  /** At the end of the paid month, so the member keeps what they paid for. */
  cancelSubscription(id: string) {
    return this.call<RazorpaySubscription>('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
  }

  /** A subscription charge's invoice, for the subscription it belongs to. */
  fetchInvoice(id: string) {
    return this.call<{ id: string; subscription_id?: string | null }>('GET', `/invoices/${encodeURIComponent(id)}`);
  }

  /**
   * Everything in the settlements received on one day: each payment with Razorpay's fee and the GST on it, each
   * refund, adjustment and dispute. Amounts in paise. Razorpay hands out at most 1,000 at a time, so this pages.
   */
  async settlementRecon(date: { year: number; month: number; day: number }): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let skip = 0; ; skip += 1000) {
      const query = `year=${date.year}&month=${String(date.month).padStart(2, '0')}&day=${String(date.day).padStart(2, '0')}&count=1000&skip=${skip}`;
      const page = await this.call<{ items?: Record<string, unknown>[] }>('GET', `/settlements/recon/combined?${query}`);
      items.push(...(page.items ?? []));
      if ((page.items?.length ?? 0) < 1000) return items;
    }
  }

  /** For a subscription, Checkout signs payment ID then subscription ID. */
  subscriptionSignatureValid(paymentId: string, subscriptionId: string, signature: string) {
    return this.ready && safeEqual(hmacSha256(this.env.RAZORPAY_KEY_SECRET, `${paymentId}|${subscriptionId}`), signature);
  }

  /** Checkout hands the app order ID, payment ID and this signature; only someone with the key secret can make it. */
  checkoutSignatureValid(orderId: string, paymentId: string, signature: string) {
    return this.ready && safeEqual(hmacSha256(this.env.RAZORPAY_KEY_SECRET, `${orderId}|${paymentId}`), signature);
  }

  webhookSignatureValid(rawBody: Buffer | undefined, signature: string | undefined) {
    if (!this.env.RAZORPAY_WEBHOOK_SECRET || !rawBody || !signature) return false;
    return safeEqual(hmacSha256(this.env.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    if (!this.ready) throw fail(503, 'payments_not_configured', 'Payments are not switched on for this server yet.');
    const auth = Buffer.from(`${this.env.RAZORPAY_KEY_ID}:${this.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch(`${this.env.RAZORPAY_API_URL}${path}`, {
      method,
      headers: { authorization: `Basic ${auth}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } };
    if (!res.ok) throw fail(502, 'razorpay_error', `Razorpay said: ${data.error?.description ?? res.status}`);
    return data as T;
  }
}
