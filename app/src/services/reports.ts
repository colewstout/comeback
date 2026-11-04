import type { Db, Queryable } from '../db/pool.js';
import type { Providers } from '../providers/index.js';
import { canSend } from '../lib/plans.js';
import type { Business } from './businesses.js';
import { loadCustomerStates, type CustomerState } from './customers.js';

const money = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

export interface Dashboard {
  customers: number;
  due: number;
  overdue: number;
  lapsed: number;
  inProgress: number;
  slippingMonthlyCents: number;
  estimatedRecoverableCents: number;
  yearlyValueCents: number;
  last30: { wins: number; recoveredCents: number; messagesSent: number };
  allTime: { wins: number; recoveredCents: number };
}

export async function dashboard(db: Queryable, b: Business, now: Date, states?: CustomerState[]): Promise<Dashboard> {
  const list = states ?? (await loadCustomerStates(db, b, now));
  const slipping = list.filter((c) => c.rhythm && (c.rhythm.status === 'overdue' || c.rhythm.status === 'lapsed') && c.display !== 'won');
  const slippingMonthlyCents = slipping.reduce((s, c) => s + c.rhythm!.monthlyValueCents, 0);
  const { rows: [r] } = await db.query<{ wins30: number; rec30: number; wins: number; rec: number; sent30: number }>(
    `SELECT
       (SELECT count(*) FROM sequences WHERE business_id = $1 AND status = 'won' AND ended_at > $2::timestamptz - interval '30 days') AS wins30,
       (SELECT coalesce(sum(recovered_cents),0) FROM sequences WHERE business_id = $1 AND status = 'won' AND ended_at > $2::timestamptz - interval '30 days') AS rec30,
       (SELECT count(*) FROM sequences WHERE business_id = $1 AND status = 'won') AS wins,
       (SELECT coalesce(sum(recovered_cents),0) FROM sequences WHERE business_id = $1 AND status = 'won') AS rec,
       (SELECT count(*) FROM messages WHERE business_id = $1 AND direction = 'out' AND status = 'sent' AND created_at > $2::timestamptz - interval '30 days') AS sent30`,
    [b.id, now],
  );
  return {
    customers: list.length,
    due: list.filter((c) => c.display === 'due').length,
    overdue: list.filter((c) => c.display === 'overdue').length,
    lapsed: list.filter((c) => c.display === 'lapsed').length,
    inProgress: list.filter((c) => c.display === 'in_progress').length,
    slippingMonthlyCents,
    estimatedRecoverableCents: Math.round(slippingMonthlyCents * 0.15),
    yearlyValueCents: list.reduce((s, c) => s + (c.rhythm ? Math.round((c.rhythm.avgCents * 365) / c.rhythm.intervalDays) : 0), 0),
    last30: { wins: r!.wins30, recoveredCents: r!.rec30, messagesSent: r!.sent30 },
    allTime: { wins: r!.wins, recoveredCents: r!.rec },
  };
}

export interface WeeklyReport {
  wins: { name: string; recoveredCents: number }[];
  recoveredCents: number;
  messagesSent: number;
  overdueNow: number;
  subject: string;
  text: string;
}

export async function weeklyReport(db: Queryable, b: Business, now: Date, appUrl: string): Promise<WeeklyReport> {
  const { rows: wins } = await db.query<{ name: string; recovered_cents: number }>(
    `SELECT c.name, s.recovered_cents FROM sequences s JOIN customers c ON c.id = s.customer_id
      WHERE s.business_id = $1 AND s.status = 'won' AND s.ended_at > $2::timestamptz - interval '7 days'
      ORDER BY s.recovered_cents DESC`,
    [b.id, now],
  );
  const { rows: [m] } = await db.query<{ n: number }>(
    `SELECT count(*) AS n FROM messages WHERE business_id = $1 AND direction = 'out' AND status = 'sent' AND created_at > $2::timestamptz - interval '7 days'`,
    [b.id, now],
  );
  const d = await dashboard(db, b, now);
  const recovered = wins.reduce((s, w) => s + w.recovered_cents, 0);
  const subject = wins.length
    ? `${wins.length} customer${wins.length === 1 ? '' : 's'} came back this week: ${money(recovered)} recovered`
    : `Your week with One More Time: ${m!.n} win-back messages sent`;
  const lines = [
    `Here's your week at ${b.name}.`,
    '',
    wins.length ? `Came back (${money(recovered)}):` : 'Nobody came back this week yet. Win-backs often take 2–3 weeks.',
    ...wins.slice(0, 15).map((w) => `  • ${w.name}: ${money(w.recovered_cents)}`),
    '',
    `Messages sent this week: ${m!.n}`,
    `Win-backs in progress: ${d.inProgress}`,
    `Customers overdue right now: ${d.overdue + d.lapsed} (about ${money(d.slippingMonthlyCents)} a month slipping)`,
    `Recovered in the last 30 days: ${money(d.last30.recoveredCents)}`,
    '',
    b.autopilot ? 'Autopilot is on.' : `Autopilot is off. Turn it on to start win-backs automatically: ${appUrl}/app#settings`,
    `Open your dashboard: ${appUrl}/app`,
  ];
  return { wins: wins.map((w) => ({ name: w.name, recoveredCents: w.recovered_cents })), recoveredCents: recovered, messagesSent: m!.n, overdueNow: d.overdue + d.lapsed, subject, text: lines.join('\n') };
}

export async function sendWeeklyReports(db: Db, providers: Providers, appUrl: string, now = new Date(), log: (s: string) => void = () => {}) {
  if (!providers.email) return { sent: 0, reason: 'email not configured' };
  const { rows } = await db.query<Business & { owner_email: string }>(
    `SELECT b.*, u.email AS owner_email FROM businesses b JOIN users u ON u.id = b.owner_id`,
  );
  let sent = 0;
  for (const b of rows) {
    if (!canSend(b, now)) continue;
    try {
      const r = await weeklyReport(db, b, now, appUrl);
      await providers.email.send({ to: b.owner_email, fromName: 'One More Time', subject: r.subject, text: r.text });
      sent++;
    } catch (err) {
      log(`weekly report failed for ${b.id}: ${(err as Error).message}`);
    }
  }
  return { sent };
}
