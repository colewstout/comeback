import type { Db, Queryable } from '../db/pool.js';
import type { Providers } from '../providers/index.js';
import { addDays, inSendWindow, localDate } from '../lib/dates.js';
import { canSend, planLimits } from '../lib/plans.js';
import { signToken } from '../lib/security.js';
import { baseDiscountCode, industry, renderMessage, SEQUENCE_KINDS, type SequenceKind } from '../lib/templates.js';
import type { Business } from './businesses.js';
import { loadCustomerStates, type CustomerState } from './customers.js';

/** Don't start a new win-back for someone who got one in the last 90 days. */
export const COOLDOWN_DAYS = 90;
/** Customers gone longer than two years are left alone; they're unlikely to welcome a text. */
export const MAX_STALE_DAYS = 730;
/** A return visit within 30 days after the last message still counts as won back. */
export const WIN_WINDOW_DAYS = 30;
export const MAX_SEND_ATTEMPTS = 3;
const DAY = 864e5;

export interface EngineDeps {
  db: Db;
  providers: Providers;
  appUrl: string;
  secret: string;
  log?: (msg: string) => void;
}

type Reachable = Pick<CustomerState, 'phone' | 'email' | 'sms_consent' | 'sms_opted_out' | 'email_opted_out'>;

/** Text if we may, otherwise email, otherwise nothing. */
export function chooseChannel(c: Reachable, smsAllowed: boolean): 'sms' | 'email' | null {
  if (smsAllowed && c.phone && c.sms_consent && !c.sms_opted_out) return 'sms';
  if (c.email && !c.email_opted_out) return 'email';
  return null;
}

export function smsAllowedFor(b: Business, providers: Providers): boolean {
  return providers.sms !== null && planLimits(b.plan).sms;
}

export const unsubscribeUrl = (appUrl: string, secret: string, customerId: string) =>
  `${appUrl.replace(/\/$/, '')}/u/${signToken(`unsub:${customerId}`, secret)}`;

async function uniqueCode(db: Queryable, businessId: string, base: string): Promise<string> {
  const { rows } = await db.query<{ discount_code: string }>(
    `SELECT discount_code FROM sequences WHERE business_id = $1 AND discount_code LIKE $2`,
    [businessId, `${base}%`],
  );
  const taken = new Set(rows.map((r) => r.discount_code));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now() % 100000}`;
}

/** Start a win-back for one customer. Returns null if one is already running. */
export async function startSequence(db: Queryable, b: Business, customer: { id: string; name: string }, now: Date, kind: SequenceKind = 'winback') {
  const pct = kind === 'second_visit' ? b.second_visit_discount_pct : b.discount_pct;
  const code = await uniqueCode(db, b.id, baseDiscountCode(customer.name, pct));
  try {
    const { rows } = await db.query<{ id: string; discount_code: string }>(
      `INSERT INTO sequences (business_id, customer_id, started_at, next_step_at, discount_code, discount_pct, kind)
       VALUES ($1, $2, $3, $3, $4, $5, $6) RETURNING id, discount_code`,
      [b.id, customer.id, now, code, pct, kind],
    );
    return rows[0]!;
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return null; // already active
    throw err;
  }
}

export async function stopSequences(db: Queryable, customerId: string, reason: string, now: Date) {
  await db.query(
    `UPDATE sequences SET status = 'stopped', stop_reason = $2, ended_at = $3, next_step_at = NULL
      WHERE customer_id = $1 AND status = 'active'`,
    [customerId, reason, now],
  );
}

/** Mark sequences as won when the customer has a visit on or after the day the win-back started. */
export async function detectWins(db: Queryable, b: Business, now: Date): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE sequences s
        SET status = 'won', ended_at = $3, next_step_at = NULL, won_visit_id = w.visit_id, recovered_cents = w.amount_cents
       FROM (
         SELECT DISTINCT ON (s2.id) s2.id AS seq_id, v.id AS visit_id, v.amount_cents
           FROM sequences s2
           JOIN visits v ON v.customer_id = s2.customer_id
                        AND v.visited_at >= (s2.started_at AT TIME ZONE $2)::date
          WHERE s2.business_id = $1
            AND (s2.status = 'active' OR (s2.status = 'completed' AND s2.ended_at > $3::timestamptz - make_interval(days => $4)))
            AND (s2.status = 'active' OR v.visited_at <= (s2.ended_at AT TIME ZONE $2)::date + $4)
          ORDER BY s2.id, v.visited_at, v.id
       ) w
      WHERE s.id = w.seq_id`,
    [b.id, b.timezone, now, WIN_WINDOW_DAYS],
  );
  return rowCount ?? 0;
}

/** Customers autopilot would start a win-back for right now. */
export function eligibleForWinback(states: CustomerState[], smsAllowed: boolean, now: Date): CustomerState[] {
  return states.filter((c) => {
    if (!c.rhythm || (c.rhythm.status !== 'overdue' && c.rhythm.status !== 'lapsed')) return false;
    if (c.rhythm.daysSince > MAX_STALE_DAYS) return false;
    if (c.sequence?.status === 'active') return false;
    if (c.sequence && now.getTime() - new Date(c.sequence.started_at).getTime() < COOLDOWN_DAYS * DAY) return false;
    // A visit after the last win-back started means they came back; their rhythm resets naturally.
    return chooseChannel(c, smsAllowed) !== null;
  });
}

/**
 * First-time customers who haven't come back yet and are approaching the usual gap for this
 * kind of business: thank them with an offer before they drift away. Customers who've been
 * gone much longer are left to the regular win-back.
 */
export function eligibleForSecondVisit(states: CustomerState[], b: Pick<Business, 'industry'>, smsAllowed: boolean): CustomerState[] {
  const gap = industry(b.industry).defaultIntervalDays;
  return states.filter((c) => {
    if (!c.rhythm || c.rhythm.learned) return false; // only customers with a single visit date
    if (c.sequence) return false; // never contacted before
    const d = c.rhythm.daysSince;
    if (d < Math.round(gap * 0.75) || d > Math.round(gap * 1.5)) return false;
    return chooseChannel(c, smsAllowed) !== null;
  });
}

interface DueRow {
  id: string; customer_id: string; steps_sent: number; started_at: Date; discount_code: string; discount_pct: number; kind: SequenceKind;
}

export interface SendSummary { sent: number; failed: number; stopped: number; completed: number; outsideWindow: boolean }

export async function sendDueSteps(deps: EngineDeps, b: Business & { owner_email?: string }, now: Date, states?: CustomerState[]): Promise<SendSummary> {
  const summary: SendSummary = { sent: 0, failed: 0, stopped: 0, completed: 0, outsideWindow: false };
  if (!inSendWindow(now, b.timezone, b.send_window_start, b.send_window_end)) {
    summary.outsideWindow = true;
    return summary;
  }
  const { db, providers } = deps;
  const { rows: due } = await db.query<DueRow>(
    `SELECT id, customer_id, steps_sent, started_at, discount_code, discount_pct, kind
       FROM sequences WHERE business_id = $1 AND status = 'active' AND next_step_at <= $2
      ORDER BY next_step_at LIMIT 500`,
    [b.id, now],
  );
  if (due.length === 0) return summary;

  const byId = new Map((states ?? (await loadCustomerStates(db, b, now))).map((c) => [c.id, c]));
  const smsAllowed = smsAllowedFor(b, providers);

  for (const s of due) {
    const c = byId.get(s.customer_id);
    const step = s.steps_sent;
    const plan = SEQUENCE_KINDS[s.kind] ?? SEQUENCE_KINDS.winback;
    if (!c || step >= plan.offsets.length) {
      await db.query(`UPDATE sequences SET status = 'completed', ended_at = $2, next_step_at = NULL WHERE id = $1`, [s.id, now]);
      summary.completed++;
      continue;
    }
    const channel = chooseChannel(c, smsAllowed);
    if (!channel) {
      await stopSequences(db, c.id, 'unreachable', now);
      summary.stopped++;
      continue;
    }

    const startedLocal = localDate(new Date(s.started_at), b.timezone);
    const unsub = unsubscribeUrl(deps.appUrl, deps.secret, c.id);
    const msg = renderMessage({
      kind: s.kind, templates: b.message_templates,
      step, channel, businessName: b.name, industryKey: b.industry, customerName: c.name,
      daysSince: c.rhythm?.daysSince ?? 0, learned: c.rhythm?.learned ?? false,
      discountPct: s.discount_pct, code: s.discount_code, expires: addDays(startedLocal, plan.codeValidDays),
      bookingUrl: b.booking_url, unsubscribeUrl: unsub, postalAddress: b.postal_address,
    });
    const to = channel === 'sms' ? c.phone! : c.email!;

    let messageId: string;
    try {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO messages (business_id, customer_id, sequence_id, step, channel, to_address, subject, body, status, provider)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sending', $9) RETURNING id`,
        [b.id, c.id, s.id, step, channel, to, channel === 'email' ? msg.subject : null, msg.body,
          channel === 'sms' ? providers.sms!.name : providers.email?.name ?? 'none'],
      );
      messageId = rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') continue; // another run is sending this step
      throw err;
    }

    try {
      const result = channel === 'sms'
        ? await providers.sms!.send({ to, from: b.sms_from, body: msg.body })
        : await sendEmail(providers, { to, fromName: b.name, replyTo: b.reply_to_email || b.owner_email, subject: msg.subject, text: msg.body, unsub });
      await db.query(`UPDATE messages SET status = 'sent', provider_id = $2 WHERE id = $1`, [messageId, result.providerId]);
      const nextStep = step + 1;
      if (nextStep >= plan.offsets.length) {
        await db.query(`UPDATE sequences SET steps_sent = $2, status = 'completed', ended_at = $3, next_step_at = NULL WHERE id = $1`, [s.id, nextStep, now]);
        summary.completed++;
      } else {
        const next = new Date(new Date(s.started_at).getTime() + plan.offsets[nextStep]! * DAY);
        await db.query(`UPDATE sequences SET steps_sent = $2, next_step_at = $3 WHERE id = $1`, [s.id, nextStep, next]);
      }
      summary.sent++;
    } catch (err) {
      await db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [messageId, String((err as Error).message).slice(0, 500)]);
      summary.failed++;
      deps.log?.(`send failed for sequence ${s.id} step ${step}: ${(err as Error).message}`);
      const { rows: [f] } = await db.query<{ n: number }>(
        `SELECT count(*) AS n FROM messages WHERE sequence_id = $1 AND step = $2 AND status = 'failed'`, [s.id, step]);
      if (f!.n >= MAX_SEND_ATTEMPTS) {
        await stopSequences(db, c.id, 'send_failed', now);
        summary.stopped++;
      }
    }
  }
  return summary;
}

async function sendEmail(providers: Providers, m: { to: string; fromName: string; replyTo?: string | null; subject: string; text: string; unsub: string }) {
  if (!providers.email) throw new Error('Email sending is not configured. Set RESEND_API_KEY and EMAIL_FROM.');
  return providers.email.send({
    to: m.to, fromName: m.fromName, replyTo: m.replyTo, subject: m.subject, text: m.text,
    headers: { 'List-Unsubscribe': `<${m.unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  });
}

export interface TickSummary {
  skipped?: 'locked';
  businesses: number;
  wins: number;
  started: number;
  sent: number;
  failed: number;
}

/**
 * The scheduled job. Run it every hour: it records wins, starts win-backs for businesses on
 * autopilot, and sends any messages that are due inside each business's sending hours.
 */
export async function runTick(deps: EngineDeps, now = new Date()): Promise<TickSummary> {
  const { db } = deps;
  const summary: TickSummary = { businesses: 0, wins: 0, started: 0, sent: 0, failed: 0 };
  const lock = await db.connect();
  try {
    const { rows: [l] } = await lock.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(727001) AS ok');
    if (!l!.ok) return { ...summary, skipped: 'locked' };

    const { rows: businesses } = await db.query<Business & { owner_email: string }>(
      `SELECT b.*, u.email AS owner_email FROM businesses b JOIN users u ON u.id = b.owner_id`,
    );
    for (const b of businesses) {
      if (!canSend(b, now)) continue;
      summary.businesses++;
      try {
        summary.wins += await detectWins(db, b, now);
        let states = await loadCustomerStates(db, b, now);
        if (b.autopilot) {
          const smsOk = smsAllowedFor(b, deps.providers);
          for (const c of eligibleForWinback(states, smsOk, now)) {
            if (await startSequence(db, b, c, now)) summary.started++;
          }
          if (b.second_visit_enabled) {
            for (const c of eligibleForSecondVisit(states, b, smsOk)) {
              if (await startSequence(db, b, c, now, 'second_visit')) summary.started++;
            }
          }
          states = await loadCustomerStates(db, b, now);
        }
        const r = await sendDueSteps(deps, b, now, states);
        summary.sent += r.sent;
        summary.failed += r.failed;
      } catch (err) {
        deps.log?.(`tick failed for business ${b.id}: ${(err as Error).message}`);
      }
    }
    return summary;
  } finally {
    await lock.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    lock.release();
  }
}
