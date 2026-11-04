import { tx, type Client, type Db } from '../db/pool.js';
import { matchKey } from '../lib/csv.js';
import { normalizeEmail, normalizePhone } from '../lib/contact.js';
import { localDate } from '../lib/dates.js';
import { planLimits } from '../lib/plans.js';
import { decrypt, encrypt } from '../lib/security.js';
import { SquareApiError, squareCustomerName, type SquareClient, type SquareCustomer, type SquarePayment, type SquareTokens } from '../integrations/square.js';
import { getBusiness, type Business } from './businesses.js';
import { detectWins } from './sequences.js';

/** First sync goes back a year: enough history to learn everyone's rhythm. */
export const BACKFILL_DAYS = 365;
/** Each sync re-reads the last 3 days so refunds and late updates are picked up. */
export const OVERLAP_DAYS = 3;
/** Refresh the access token when it has less than a week left (Square tokens last 30 days). */
const REFRESH_WITHIN_MS = 7 * 864e5;
/** Cap per run so one huge account can't hold up the scheduler; the next run continues. */
const MAX_PAGES_PER_RUN = 100;
/** Sync each connected account about once an hour. */
export const SYNC_EVERY_MS = 55 * 60_000;

export class SyncError extends Error {}

export interface SquareDeps {
  db: Db;
  square: SquareClient;
  tokenKey: Buffer;
  log?: (msg: string) => void;
}

export interface Integration {
  id: string;
  business_id: string;
  status: 'connected' | 'error' | 'needs_reauth' | 'disconnected';
  external_account: string | null;
  account_name: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
  synced_through: Date | null;
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
}

export async function getIntegration(db: Db | Client, businessId: string): Promise<Integration | null> {
  const { rows } = await db.query<Integration>(`SELECT * FROM integrations WHERE business_id = $1 AND provider = 'square'`, [businessId]);
  return rows[0] ?? null;
}

export function publicIntegration(i: Integration | null) {
  if (!i || i.status === 'disconnected') return { connected: false as const };
  return {
    connected: true as const, status: i.status, accountName: i.account_name, lastSyncedAt: i.last_synced_at,
    syncedThrough: i.synced_through, lastError: i.last_error, connectedAt: i.created_at,
  };
}

/** Save tokens after the merchant approves access. Reconnecting replaces old tokens but keeps sync progress. */
export async function saveConnection(deps: SquareDeps, businessId: string, t: SquareTokens) {
  let accountName: string | null = null;
  try { accountName = await deps.square.merchantName(t.accessToken, t.merchantId); } catch { /* display only */ }
  const prev = await getIntegration(deps.db, businessId);
  // Connecting a different Square account starts history over.
  const resetProgress = prev?.external_account && prev.external_account !== t.merchantId;
  await deps.db.query(
    `INSERT INTO integrations (business_id, provider, status, external_account, account_name, access_token_enc, refresh_token_enc, token_expires_at)
     VALUES ($1, 'square', 'connected', $2, $3, $4, $5, $6)
     ON CONFLICT (business_id, provider) DO UPDATE SET
       status = 'connected', external_account = EXCLUDED.external_account, account_name = EXCLUDED.account_name,
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       token_expires_at = EXCLUDED.token_expires_at, last_error = NULL,
       synced_through = CASE WHEN $7 THEN NULL ELSE integrations.synced_through END`,
    [businessId, t.merchantId, accountName, encrypt(t.accessToken, deps.tokenKey), encrypt(t.refreshToken, deps.tokenKey), t.expiresAt, Boolean(resetProgress)],
  );
}

export async function disconnect(deps: SquareDeps, businessId: string) {
  const i = await getIntegration(deps.db, businessId);
  if (!i || i.status === 'disconnected') return;
  if (i.access_token_enc) {
    try { await deps.square.revoke(decrypt(i.access_token_enc, deps.tokenKey)); }
    catch (err) { deps.log?.(`square revoke failed for ${businessId}: ${(err as Error).message}`); }
  }
  // Keep imported customers and visits; forget the credentials.
  await deps.db.query(
    `UPDATE integrations SET status = 'disconnected', access_token_enc = NULL, refresh_token_enc = NULL, token_expires_at = NULL, last_error = NULL WHERE id = $1`,
    [i.id],
  );
}

async function freshToken(deps: SquareDeps, i: Integration, now: Date): Promise<string> {
  if (!i.access_token_enc || !i.refresh_token_enc) throw new SyncError('Square is not connected.');
  if (i.token_expires_at && i.token_expires_at.getTime() - now.getTime() > REFRESH_WITHIN_MS) {
    return decrypt(i.access_token_enc, deps.tokenKey);
  }
  const t = await deps.square.refresh(decrypt(i.refresh_token_enc, deps.tokenKey));
  await deps.db.query(
    `UPDATE integrations SET access_token_enc = $2, refresh_token_enc = $3, token_expires_at = $4 WHERE id = $1`,
    [i.id, encrypt(t.accessToken, deps.tokenKey), encrypt(t.refreshToken, deps.tokenKey), t.expiresAt],
  );
  return t.accessToken;
}

export interface SyncResult {
  paymentsSeen: number;
  paymentsWithoutCustomer: number;
  visitsAdded: number;
  visitsUpdated: number;
  visitsRemoved: number;
  customersCreated: number;
  customersLinked: number;
  wins: number;
  complete: boolean; // false when more history remains for the next run
}

/** Amount actually kept by the business, in cents. Zero or less means fully refunded. */
export function netCents(p: SquarePayment): number {
  return (p.amount_money?.amount ?? 0) - (p.refunded_money?.amount ?? 0);
}

interface LocalCustomerInput { sqId: string; name: string; phone: string | null; email: string | null; emailUnsubscribed: boolean }

function toLocal(c: SquareCustomer): LocalCustomerInput {
  const phone = normalizePhone(c.phone_number);
  const email = normalizeEmail(c.email_address);
  return { sqId: c.id, name: squareCustomerName(c) || email || phone || 'Square customer', phone, email, emailUnsubscribed: Boolean(c.preferences?.email_unsubscribed) };
}

/**
 * Link a Square customer to one of ours: same Square id first, then the same phone, email or name
 * (so customers already uploaded from a CSV are merged rather than duplicated).
 * Never sets text permission: Square doesn't share it, so the owner still decides that.
 */
async function upsertSquareCustomer(client: Client, businessId: string, c: LocalCustomerInput, now: Date) {
  const optOut = c.emailUnsubscribed ? now : null;
  const linked = await client.query<{ id: string }>(
    `UPDATE customers SET name = CASE WHEN name = '' THEN $3 ELSE name END, phone = COALESCE(phone, $4), email = COALESCE(email, $5),
            email_opted_out_at = COALESCE(email_opted_out_at, $6)
      WHERE business_id = $1 AND square_customer_id = $2 RETURNING id`,
    [businessId, c.sqId, c.name, c.phone, c.email, optOut],
  );
  if (linked.rows[0]) return { id: linked.rows[0].id, created: false };
  const { rows: [r] } = await client.query<{ id: string; inserted: boolean }>(
    `INSERT INTO customers (business_id, match_key, name, phone, email, square_customer_id, email_opted_out_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (business_id, match_key) DO UPDATE SET
       square_customer_id = COALESCE(customers.square_customer_id, EXCLUDED.square_customer_id),
       phone = COALESCE(customers.phone, EXCLUDED.phone), email = COALESCE(customers.email, EXCLUDED.email),
       email_opted_out_at = COALESCE(customers.email_opted_out_at, EXCLUDED.email_opted_out_at)
     RETURNING id, (xmax = 0) AS inserted`,
    [businessId, matchKey(c), c.name, c.phone, c.email, c.sqId, optOut],
  );
  return { id: r!.id, created: r!.inserted };
}

export async function syncSquare(deps: SquareDeps, businessId: string, now = new Date()): Promise<SyncResult> {
  const { db, square } = deps;
  const i = await getIntegration(db, businessId);
  if (!i || i.status === 'disconnected') throw new SyncError('Square is not connected.');
  const b = (await getBusiness(db, businessId))!;

  try {
    const result = await doSync(deps, i, b, now);
    await db.query(`UPDATE integrations SET status = 'connected', last_error = NULL, last_synced_at = $2 WHERE id = $1`, [i.id, now]);
    return result;
  } catch (err) {
    const authProblem = err instanceof SquareApiError && err.isAuthError;
    const message = authProblem
      ? 'Square access was removed or expired. Reconnect Square to keep syncing.'
      : (err as Error).message.slice(0, 300);
    await db.query(`UPDATE integrations SET status = $2, last_error = $3, last_synced_at = $4 WHERE id = $1`, [i.id, authProblem ? 'needs_reauth' : 'error', message, now]);
    throw err instanceof SyncError ? err : new SyncError(message);
  }

  async function doSync(deps: SquareDeps, i: Integration, b: Business, now: Date): Promise<SyncResult> {
    const token = await freshToken(deps, i, now);
    const firstSync = !i.synced_through;
    const begin = firstSync
      ? new Date(now.getTime() - BACKFILL_DAYS * 864e5)
      : new Date(i.synced_through!.getTime() - OVERLAP_DAYS * 864e5);

    // 1. Payments, oldest first.
    const payments: SquarePayment[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await square.listPayments(token, begin.toISOString(), cursor);
      payments.push(...(page.payments ?? []));
      cursor = page.cursor;
    } while (cursor && ++pages < MAX_PAGES_PER_RUN);
    const complete = !cursor;

    // Refunds made recently on older payments: re-read those payments so the visit amount is corrected.
    if (!firstSync) {
      const seen = new Set(payments.map((p) => p.id));
      const refundedIds = new Set<string>();
      let rc: string | undefined;
      let rpages = 0;
      do {
        const page = await square.listRefunds(token, begin.toISOString(), rc);
        for (const r of page.refunds ?? []) if (!seen.has(r.payment_id)) refundedIds.add(r.payment_id);
        rc = page.cursor;
      } while (rc && ++rpages < MAX_PAGES_PER_RUN);
      const ids = [...refundedIds];
      for (let k = 0; k < ids.length; k += 5) {
        const batch = await Promise.all(ids.slice(k, k + 5).map((id) => square.getPayment(token, id)));
        batch.forEach((p) => p && payments.push(p));
      }
    }

    const relevant = payments.filter((p) => p.customer_id && p.status === 'COMPLETED');
    const withoutCustomer = payments.filter((p) => !p.customer_id && p.status === 'COMPLETED').length;
    const newestSeen = payments.reduce<Date | null>((max, p) => {
      const t = new Date(p.created_at);
      return !max || t > max ? t : max;
    }, null);

    // 2. Square customers we haven't linked yet.
    const sqIds = [...new Set(relevant.map((p) => p.customer_id!))];
    const { rows: known } = await db.query<{ square_customer_id: string }>(
      `SELECT square_customer_id FROM customers WHERE business_id = $1 AND square_customer_id = ANY($2::text[])`, [b.id, sqIds]);
    const knownSet = new Set(known.map((k) => k.square_customer_id));
    const missing = sqIds.filter((id) => !knownSet.has(id));
    const fetched = new Map<string, SquareCustomer>();
    if (firstSync && missing.length > 20) {
      // Cheaper to page through the whole customer list (100 per request) than fetch one by one.
      let cc: string | undefined;
      do {
        const page = await square.listCustomers(token, cc);
        for (const c of page.customers ?? []) fetched.set(c.id, c);
        cc = page.cursor;
      } while (cc);
    }
    const stillMissing = missing.filter((id) => !fetched.has(id));
    for (let k = 0; k < stillMissing.length; k += 5) {
      const batch = await Promise.all(stillMissing.slice(k, k + 5).map((id) => square.getCustomer(token, id)));
      batch.forEach((c) => c && fetched.set(c.id, c));
    }

    // 3. Write everything in one transaction.
    const limit = planLimits(b.plan).maxCustomers;
    const result = await tx(db, async (client) => {
      let customersCreated = 0;
      let customersLinked = 0;
      for (const id of missing) {
        const c = fetched.get(id);
        if (!c) continue; // deleted in Square; their payments are skipped below
        const r = await upsertSquareCustomer(client, b.id, toLocal(c), now);
        if (r.created) customersCreated++;
        else customersLinked++;
      }
      const { rows: [count] } = await client.query<{ n: number }>('SELECT count(*) AS n FROM customers WHERE business_id = $1', [b.id]);
      if (count!.n > limit) {
        throw new SyncError(`Square has more customers than your plan allows (${count!.n} of ${limit}). Upgrade your plan to keep syncing.`);
      }

      const { rows: links } = await client.query<{ id: string; square_customer_id: string }>(
        `SELECT id, square_customer_id FROM customers WHERE business_id = $1 AND square_customer_id = ANY($2::text[])`, [b.id, sqIds]);
      const localId = new Map(links.map((l) => [l.square_customer_id, l.id]));

      const keep = relevant.filter((p) => localId.has(p.customer_id!) && netCents(p) > 0);
      const refunded = relevant.filter((p) => netCents(p) <= 0).map((p) => `sq:${p.id}`);

      let visitsAdded = 0;
      let visitsUpdated = 0;
      if (keep.length) {
        const { rows } = await client.query<{ inserted: boolean }>(
          `INSERT INTO visits (business_id, customer_id, visited_at, amount_cents, source, dedupe_key)
           SELECT $1, * FROM unnest($2::uuid[], $3::date[], $4::int[], $5::text[], $6::text[])
           ON CONFLICT (business_id, dedupe_key) DO UPDATE SET amount_cents = EXCLUDED.amount_cents, visited_at = EXCLUDED.visited_at
             WHERE visits.amount_cents IS DISTINCT FROM EXCLUDED.amount_cents OR visits.visited_at IS DISTINCT FROM EXCLUDED.visited_at
           RETURNING (xmax = 0) AS inserted`,
          [b.id, keep.map((p) => localId.get(p.customer_id!)), keep.map((p) => localDate(new Date(p.created_at), b.timezone)),
            keep.map(netCents), keep.map(() => 'square'), keep.map((p) => `sq:${p.id}`)],
        );
        visitsAdded = rows.filter((r) => r.inserted).length;
        visitsUpdated = rows.length - visitsAdded;
      }
      const removed = refunded.length
        ? (await client.query(`DELETE FROM visits WHERE business_id = $1 AND dedupe_key = ANY($2::text[])`, [b.id, refunded])).rowCount ?? 0
        : 0;

      if (newestSeen && (!i.synced_through || newestSeen > i.synced_through)) {
        await client.query(`UPDATE integrations SET synced_through = $2 WHERE id = $1`, [i.id, newestSeen]);
      } else if (firstSync) {
        // No payments at all in the last year: remember we checked, so we don't backfill again.
        await client.query(`UPDATE integrations SET synced_through = $2 WHERE id = $1`, [i.id, now]);
      }
      if (visitsAdded || customersCreated) {
        await client.query(
          `INSERT INTO imports (business_id, filename, rows_total, visits_added, rows_skipped, customers_created) VALUES ($1, 'Square sync', $2, $3, $4, $5)`,
          [b.id, payments.length, visitsAdded, withoutCustomer, customersCreated],
        );
      }
      return { visitsAdded, visitsUpdated, visitsRemoved: removed, customersCreated, customersLinked };
    });

    const wins = await detectWins(db, b, now);
    return { paymentsSeen: payments.length, paymentsWithoutCustomer: withoutCustomer, ...result, wins, complete };
  }
}

/** Called by the scheduler: sync every connected Square account that's due. */
export async function syncAllSquare(deps: SquareDeps, now = new Date()) {
  const { rows } = await deps.db.query<{ business_id: string }>(
    `SELECT business_id FROM integrations
      WHERE provider = 'square' AND status IN ('connected', 'error')
        AND (last_synced_at IS NULL OR last_synced_at < $1)`,
    [new Date(now.getTime() - SYNC_EVERY_MS)],
  );
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      await syncSquare(deps, r.business_id, now);
      ok++;
    } catch (err) {
      failed++;
      deps.log?.(`square sync failed for ${r.business_id}: ${(err as Error).message}`);
    }
  }
  return { synced: ok, failed };
}
