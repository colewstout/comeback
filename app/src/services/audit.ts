import { mapCsv, matchKey } from '../lib/csv.js';
import { daysBetween } from '../lib/dates.js';
import { computeRhythm, type RhythmStatus } from '../lib/rhythm.js';
import { industry } from '../lib/templates.js';

/**
 * A "lost customer audit" for a prospect: reads their sales export and reports how many
 * customers are overdue and what that's worth. Nothing is stored. Customer names are shortened
 * to first name and last initial so the report can be shared without exposing anyone.
 */

export interface AuditInput {
  csv: string;
  industryKey: string;
  overdueMultiplier?: number;
  today: string; // YYYY-MM-DD in the prospect's time zone
}

export interface AuditResult {
  customers: number;
  visits: number;
  firstVisit: string | null;
  lastVisit: string | null;
  avgVisitCents: number;
  medianGapDays: number | null;
  byStatus: Record<RhythmStatus, number>;
  slippingMonthlyCents: number;
  slippingYearlyCents: number;
  recover10MonthlyCents: number;
  recover20MonthlyCents: number;
  firstTimers: { total: number; cameBack: number; rate: number | null };
  reachable: { phone: number; email: number; none: number };
  topOverdue: { name: string; lastVisit: string; usualGapDays: number; daysOverdue: number; avgCents: number }[];
  skippedRows: number;
  columns: ReturnType<typeof mapCsv>['columns'];
}

function shortName(full: string): string {
  if (full.includes('@')) return full.split('@')[0]!.slice(0, 1).toUpperCase() + '.';
  const parts = full.trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]!.toUpperCase()}.` : parts[0] || 'Customer';
}

export function runAudit(input: AuditInput): AuditResult {
  const mapped = mapCsv(input.csv);
  const p = industry(input.industryKey);
  const opts = { defaultIntervalDays: p.defaultIntervalDays, overdueMultiplier: input.overdueMultiplier ?? 1.5 };

  const groups = new Map<string, { name: string; phone: string | null; email: string | null; visits: { date: string; amountCents: number }[] }>();
  for (const r of mapped.rows) {
    const key = matchKey(r);
    const g = groups.get(key) ?? { name: r.name, phone: r.phone, email: r.email, visits: [] };
    g.phone ??= r.phone;
    g.email ??= r.email;
    g.visits.push({ date: r.date, amountCents: r.amountCents });
    groups.set(key, g);
  }

  const byStatus: Record<RhythmStatus, number> = { ok: 0, due: 0, overdue: 0, lapsed: 0 };
  let slipping = 0;
  let totalCents = 0;
  let visitCount = 0;
  const gaps: number[] = [];
  const overdue: AuditResult['topOverdue'] = [];
  let firstTimersTotal = 0;
  let firstTimersBack = 0;
  const reachable = { phone: 0, email: 0, none: 0 };
  let first: string | null = null;
  let last: string | null = null;

  for (const g of groups.values()) {
    const r = computeRhythm(g.visits, input.today, opts);
    if (!r) continue;
    visitCount += g.visits.length;
    totalCents += g.visits.reduce((s, v) => s + v.amountCents, 0);
    if (!first || r.firstVisit < first) first = r.firstVisit;
    if (!last || r.lastVisit > last) last = r.lastVisit;
    if (r.learned) gaps.push(r.intervalDays);
    byStatus[r.status]++;
    if (g.phone) reachable.phone++;
    else if (g.email) reachable.email++;
    else reachable.none++;

    // A first-timer is anyone whose first visit was long enough ago that they "should" have returned.
    if (daysBetween(r.firstVisit, input.today) >= p.defaultIntervalDays) {
      firstTimersTotal++;
      if (r.learned) firstTimersBack++;
    }
    if ((r.status === 'overdue' || r.status === 'lapsed') && r.daysSince <= 730) {
      slipping += r.monthlyValueCents;
      overdue.push({ name: shortName(g.name), lastVisit: r.lastVisit, usualGapDays: Math.round(r.intervalDays), daysOverdue: r.overdueByDays, avgCents: r.avgCents });
    }
  }

  overdue.sort((a, b) => b.avgCents * 30 / b.usualGapDays - a.avgCents * 30 / a.usualGapDays);
  const sortedGaps = gaps.sort((a, b) => a - b);
  const customers = Object.values(byStatus).reduce((a, b) => a + b, 0);

  return {
    customers,
    visits: visitCount,
    firstVisit: first,
    lastVisit: last,
    avgVisitCents: visitCount ? Math.round(totalCents / visitCount) : 0,
    medianGapDays: sortedGaps.length ? Math.round(sortedGaps[sortedGaps.length >> 1]!) : null,
    byStatus,
    slippingMonthlyCents: slipping,
    slippingYearlyCents: slipping * 12,
    recover10MonthlyCents: Math.round(slipping * 0.1),
    recover20MonthlyCents: Math.round(slipping * 0.2),
    firstTimers: { total: firstTimersTotal, cameBack: firstTimersBack, rate: firstTimersTotal ? firstTimersBack / firstTimersTotal : null },
    reachable,
    topOverdue: overdue.slice(0, 15),
    skippedRows: mapped.skipped.length,
    columns: mapped.columns,
  };
}
