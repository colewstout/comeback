import type { Queryable } from '../db/pool.js';
import { addDays, localDate } from '../lib/dates.js';
import { computeRhythm, type Rhythm } from '../lib/rhythm.js';
import { industry } from '../lib/templates.js';
import type { Business } from './businesses.js';

export interface SequenceSummary {
  id: string;
  status: 'active' | 'won' | 'completed' | 'stopped';
  steps_sent: number;
  started_at: Date;
  next_step_at: Date | null;
  ended_at: Date | null;
  discount_code: string;
  recovered_cents: number;
}

export interface CustomerState {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  sms_consent: boolean;
  sms_opted_out: boolean;
  email_opted_out: boolean;
  rhythm: Rhythm | null;
  /** Distinct visit dates in the last 13 months, oldest first, for the timeline. */
  recentVisits: string[];
  sequence: SequenceSummary | null; // most recent sequence, if any
  /** What the dashboard shows: rhythm status, or the win-back state when one is in progress. */
  display: 'ok' | 'due' | 'overdue' | 'lapsed' | 'in_progress' | 'won';
}

interface Row {
  id: string; name: string; phone: string | null; email: string | null; sms_consent: boolean;
  sms_opted_out_at: Date | null; email_opted_out_at: Date | null;
  visits: { d: string; a: number }[] | null;
  sequence: SequenceSummary | null;
}

const WON_DISPLAY_DAYS = 30;

export async function loadCustomerStates(db: Queryable, b: Business, now: Date, customerId?: string): Promise<CustomerState[]> {
  const { rows } = await db.query<Row>(
    `SELECT c.id, c.name, c.phone, c.email, c.sms_consent, c.sms_opted_out_at, c.email_opted_out_at,
            (SELECT json_agg(json_build_object('d', v.visited_at, 'a', v.amount_cents) ORDER BY v.visited_at)
               FROM visits v WHERE v.customer_id = c.id) AS visits,
            (SELECT row_to_json(s) FROM (
               SELECT id, status, steps_sent, started_at, next_step_at, ended_at, discount_code, recovered_cents
                 FROM sequences WHERE customer_id = c.id ORDER BY started_at DESC LIMIT 1) s) AS sequence
       FROM customers c
      WHERE c.business_id = $1 AND ($2::uuid IS NULL OR c.id = $2)`,
    [b.id, customerId ?? null],
  );

  const today = localDate(now, b.timezone);
  const opts = { defaultIntervalDays: industry(b.industry).defaultIntervalDays, overdueMultiplier: Number(b.overdue_multiplier) };

  return rows.map((r) => {
    const visits = (r.visits ?? []).map((v) => ({ date: v.d, amountCents: v.a }));
    const rhythm = computeRhythm(visits, today, opts);
    const since = addDays(today, -400);
    const recentVisits = [...new Set(visits.map((v) => v.date).filter((d) => d >= since && d <= today))];
    const seq = r.sequence;
    let display: CustomerState['display'] = rhythm?.status ?? 'ok';
    if (seq?.status === 'active') display = 'in_progress';
    else if (seq?.status === 'won' && seq.ended_at && now.getTime() - new Date(seq.ended_at).getTime() < WON_DISPLAY_DAYS * 864e5) display = 'won';
    return {
      id: r.id, name: r.name, phone: r.phone, email: r.email, sms_consent: r.sms_consent,
      sms_opted_out: Boolean(r.sms_opted_out_at), email_opted_out: Boolean(r.email_opted_out_at),
      rhythm, recentVisits, sequence: seq, display,
    };
  });
}
