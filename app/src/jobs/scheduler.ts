import type { Db } from '../db/pool.js';
import type { Providers } from '../providers/index.js';
import { runTick } from '../services/sequences.js';
import { sendWeeklyReports } from '../services/reports.js';

interface Opts { db: Db; providers: Providers; appUrl: string; secret: string; log: (msg: string, extra?: unknown) => void }

/** Claim a job for one period. Returns false if another run already claimed it. */
export async function claimRun(db: Db, id: string): Promise<boolean> {
  const { rowCount } = await db.query('INSERT INTO job_runs (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  return rowCount === 1;
}

/** Weekly report goes out on Mondays from 12:00 UTC (7–8am US Eastern), once. */
export async function maybeSendWeeklyReport(o: Opts, now: Date): Promise<boolean> {
  if (now.getUTCDay() !== 1 || now.getUTCHours() < 12) return false;
  if (!(await claimRun(o.db, `weekly-report:${now.toISOString().slice(0, 10)}`))) return false;
  const r = await sendWeeklyReports(o.db, o.providers, o.appUrl, now, o.log);
  o.log('weekly reports sent', r);
  return true;
}

export function startScheduler(o: Opts, everyMs = 15 * 60_000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      o.log('tick', await runTick({ db: o.db, providers: o.providers, appUrl: o.appUrl, secret: o.secret, log: o.log }, now));
      await maybeSendWeeklyReport(o, now);
    } catch (err) {
      o.log(`scheduler error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, everyMs);
  setTimeout(run, 10_000);
  return () => clearInterval(timer);
}
