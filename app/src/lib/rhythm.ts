import { addDays, daysBetween } from './dates.js';

export type RhythmStatus = 'ok' | 'due' | 'overdue' | 'lapsed';

export interface VisitLite {
  date: string; // YYYY-MM-DD
  amountCents: number;
}

export interface Rhythm {
  visitCount: number;
  intervalDays: number;
  learned: boolean; // false when the customer has only one visit date and we used the industry default
  firstVisit: string;
  lastVisit: string;
  nextExpected: string;
  daysSince: number;
  ratio: number;
  overdueByDays: number;
  avgCents: number;
  monthlyValueCents: number;
  status: RhythmStatus;
}

export interface RhythmOptions {
  defaultIntervalDays: number;
  overdueMultiplier: number;
}

export const LAPSED_MULTIPLIER = 3;
const MIN_INTERVAL_DAYS = 3;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Work out a customer's usual buying rhythm and whether they're overdue.
 * The usual gap is the median of the gaps between distinct visit dates, which ignores
 * one-off long breaks better than an average does.
 */
export function computeRhythm(visits: VisitLite[], today: string, opts: RhythmOptions): Rhythm | null {
  if (visits.length === 0) return null;
  const dates = [...new Set(visits.map((v) => v.date))].filter((d) => d <= today).sort();
  if (dates.length === 0) return null;

  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1]!, dates[i]!));

  const learned = gaps.length > 0;
  const intervalDays = Math.max(MIN_INTERVAL_DAYS, learned ? median(gaps) : opts.defaultIntervalDays);
  const firstVisit = dates[0]!;
  const lastVisit = dates[dates.length - 1]!;
  const daysSince = daysBetween(lastVisit, today);
  const ratio = daysSince / intervalDays;
  const totalCents = visits.reduce((sum, v) => sum + v.amountCents, 0);
  const avgCents = Math.round(totalCents / visits.length);
  const monthlyValueCents = Math.round((avgCents * 30) / intervalDays);

  const lapsedAt = Math.max(LAPSED_MULTIPLIER, opts.overdueMultiplier);
  let status: RhythmStatus;
  if (ratio >= lapsedAt) status = 'lapsed';
  else if (ratio >= opts.overdueMultiplier) status = 'overdue';
  else if (ratio >= 1) status = 'due';
  else status = 'ok';

  return {
    visitCount: visits.length,
    intervalDays: Math.round(intervalDays * 10) / 10,
    learned,
    firstVisit,
    lastVisit,
    nextExpected: addDays(lastVisit, Math.round(intervalDays)),
    daysSince,
    ratio: Math.round(ratio * 100) / 100,
    overdueByDays: Math.max(0, Math.round(daysSince - intervalDays)),
    avgCents,
    monthlyValueCents,
    status,
  };
}
