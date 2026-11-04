import type { Queryable } from '../db/pool.js';

export interface Business {
  id: string;
  owner_id: string;
  name: string;
  industry: string;
  discount_pct: number;
  overdue_multiplier: number;
  timezone: string;
  send_window_start: number;
  send_window_end: number;
  autopilot: boolean;
  booking_url: string | null;
  reply_to_email: string | null;
  postal_address: string | null;
  sms_from: string | null;
  plan: string;
  plan_status: string;
  trial_ends_at: Date;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  created_at: Date;
}

export async function getBusiness(db: Queryable, id: string): Promise<Business | null> {
  const { rows } = await db.query<Business>('SELECT * FROM businesses WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getBusinessForOwner(db: Queryable, ownerId: string): Promise<Business | null> {
  const { rows } = await db.query<Business>('SELECT * FROM businesses WHERE owner_id = $1 ORDER BY created_at LIMIT 1', [ownerId]);
  return rows[0] ?? null;
}

/** Public shape for the API: hides billing IDs. */
export function publicBusiness(b: Business) {
  const { stripe_customer_id, stripe_subscription_id, owner_id, ...rest } = b;
  return { ...rest, has_billing: Boolean(stripe_customer_id) };
}
