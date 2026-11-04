export type PlanKey = 'trial' | 'starter' | 'growth' | 'multi';

export interface PlanLimits {
  label: string;
  priceUsd: number;
  maxCustomers: number;
  sms: boolean;
}

export const PLANS: Record<PlanKey, PlanLimits> = {
  trial: { label: 'Free trial', priceUsd: 0, maxCustomers: 2500, sms: true },
  starter: { label: 'Starter', priceUsd: 49, maxCustomers: 500, sms: false },
  growth: { label: 'Growth', priceUsd: 99, maxCustomers: 2500, sms: true },
  multi: { label: 'Multi-location', priceUsd: 199, maxCustomers: 10000, sms: true },
};

export const PAID_PLANS = ['starter', 'growth', 'multi'] as const;

export function planLimits(plan: string): PlanLimits {
  return PLANS[plan as PlanKey] ?? PLANS.starter;
}

export interface BillingState {
  plan: string;
  plan_status: string;
  trial_ends_at: Date | string;
}

/** Whether the business is allowed to send messages right now. */
export function canSend(b: BillingState, now: Date): boolean {
  if (b.plan_status === 'active') return true;
  if (b.plan_status === 'trialing') return new Date(b.trial_ends_at) > now;
  return false;
}
