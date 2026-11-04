import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import type { Business } from './businesses.js';

export class BillingError extends Error {}

const priceFor = (c: Config, plan: string) =>
  ({ starter: c.STRIPE_PRICE_STARTER, growth: c.STRIPE_PRICE_GROWTH, multi: c.STRIPE_PRICE_MULTI })[plan];

const planForPrice = (c: Config, priceId: string | undefined) =>
  priceId === c.STRIPE_PRICE_STARTER ? 'starter' : priceId === c.STRIPE_PRICE_GROWTH ? 'growth' : priceId === c.STRIPE_PRICE_MULTI ? 'multi' : null;

async function stripe(c: Config, path: string, params: Record<string, string>) {
  if (!c.STRIPE_SECRET_KEY) throw new BillingError('Billing is not set up yet. Add STRIPE_SECRET_KEY.');
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as { url?: string; error?: { message?: string } };
  if (!res.ok) throw new BillingError(`Stripe: ${json.error?.message ?? res.status}`);
  return json;
}

export async function createCheckout(c: Config, b: Business, ownerEmail: string, plan: string): Promise<string> {
  const price = priceFor(c, plan);
  if (!price) throw new BillingError(`No Stripe price configured for the ${plan} plan.`);
  const params: Record<string, string> = {
    mode: 'subscription',
    'line_items[0][price]': price,
    'line_items[0][quantity]': '1',
    client_reference_id: b.id,
    'metadata[business_id]': b.id,
    'metadata[plan]': plan,
    'subscription_data[metadata][business_id]': b.id,
    success_url: `${c.APP_URL}/app#billing-success`,
    cancel_url: `${c.APP_URL}/app#settings`,
    allow_promotion_codes: 'true',
  };
  if (b.stripe_customer_id) params.customer = b.stripe_customer_id;
  else params.customer_email = ownerEmail;
  const session = await stripe(c, 'checkout/sessions', params);
  return session.url!;
}

export async function createPortal(c: Config, b: Business): Promise<string> {
  if (!b.stripe_customer_id) throw new BillingError('No subscription yet. Choose a plan first.');
  const session = await stripe(c, 'billing_portal/sessions', { customer: b.stripe_customer_id, return_url: `${c.APP_URL}/app#settings` });
  return session.url!;
}

type StripeEvent = { id: string; type: string; data: { object: Record<string, any> } };

const STATUS_MAP: Record<string, string> = {
  active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due',
  canceled: 'canceled', incomplete_expired: 'canceled', incomplete: 'past_due',
};

/** Apply a verified Stripe webhook event. Idempotent by event id. */
export async function handleStripeEvent(db: Db, c: Config, event: StripeEvent): Promise<string> {
  const { rowCount } = await db.query(`INSERT INTO webhook_events (id, source) VALUES ($1, 'stripe') ON CONFLICT DO NOTHING`, [event.id]);
  if (!rowCount) return 'duplicate';
  const o = event.data.object;

  if (event.type === 'checkout.session.completed') {
    const businessId = o.client_reference_id ?? o.metadata?.business_id;
    const plan = o.metadata?.plan;
    if (!businessId) return 'ignored';
    await db.query(
      `UPDATE businesses SET stripe_customer_id = $2, stripe_subscription_id = $3, plan = COALESCE($4, plan), plan_status = 'active' WHERE id = $1`,
      [businessId, o.customer, o.subscription, plan && ['starter', 'growth', 'multi'].includes(plan) ? plan : null],
    );
    return 'activated';
  }

  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : STATUS_MAP[o.status] ?? 'past_due';
    const plan = planForPrice(c, o.items?.data?.[0]?.price?.id);
    await db.query(
      `UPDATE businesses SET plan_status = $2, plan = COALESCE($3, plan)
        WHERE stripe_subscription_id = $1 OR id::text = $4`,
      [o.id, status, plan, o.metadata?.business_id ?? ''],
    );
    return `subscription ${status}`;
  }
  return 'ignored';
}
