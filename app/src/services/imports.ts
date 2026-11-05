import { tx, type Db } from '../db/pool.js';
import { mapCsv, matchKey, type MappedCsv } from '../lib/csv.js';
import { planLimits } from '../lib/plans.js';

export class ImportError extends Error {}

export interface ImportResult {
  importId: string;
  rowsTotal: number;
  visitsAdded: number;
  duplicateRows: number;
  customersCreated: number;
  customersUpdated: number;
  skipped: MappedCsv['skipped'];
  columns: MappedCsv['columns'];
  format: MappedCsv['format'];
  /** Cancelled, no-show and refunded rows that were left out on purpose. */
  excludedByStatus: number;
}

interface BusinessRef { id: string; plan: string }

/**
 * Import a sales export. Safe to run on the same file twice: each purchase gets a dedupe key,
 * so re-uploading only adds the rows that are new.
 */
export async function importCsv(
  db: Db,
  business: BusinessRef,
  input: { filename: string; csv: string; smsConsentAll?: boolean },
): Promise<ImportResult> {
  const mapped = mapCsv(input.csv);
  if (mapped.rows.length === 0) {
    throw new ImportError(mapped.skipped.length
      ? `No usable rows. First problem: line ${mapped.skipped[0]!.line}: ${mapped.skipped[0]!.reason}`
      : 'Every row was a cancelled, no-show or refunded visit, so there was nothing to import.');
  }

  // Group rows into customers and build visit dedupe keys.
  type Cust = { key: string; name: string; phone: string | null; email: string | null; smsConsent: boolean };
  const customers = new Map<string, Cust>();
  const seen = new Map<string, number>();
  const visits: { key: string; date: string; amountCents: number; dedupe: string; source: string }[] = [];

  for (const row of mapped.rows) {
    const key = matchKey(row);
    const c = customers.get(key) ?? { key, name: row.name, phone: row.phone, email: row.email, smsConsent: false };
    c.name = c.name || row.name;
    c.phone ??= row.phone;
    c.email ??= row.email;
    if (row.smsConsent === true || (input.smsConsentAll && row.smsConsent !== false)) c.smsConsent = true;
    customers.set(key, c);

    if (row.estimated) {
      // Estimated from a customer summary: keyed by position, and replaced on every re-upload.
      visits.push({ key, date: row.date, amountCents: row.amountCents, dedupe: `${key}|est|${row.estimated.index}`, source: 'summary' });
      continue;
    }
    const base = `${key}|${row.date}|${row.amountCents}`;
    const n = (seen.get(base) ?? 0) + 1; // identical purchases on the same day in one file both count
    seen.set(base, n);
    visits.push({ key, date: row.date, amountCents: row.amountCents, dedupe: `${base}|${n}`, source: 'csv' });
  }

  const limit = planLimits(business.plan).maxCustomers;

  return tx(db, async (client) => {
    const list = [...customers.values()];
    const up = await client.query<{ id: string; match_key: string; inserted: boolean }>(
      `INSERT INTO customers (business_id, match_key, name, phone, email, sms_consent)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::boolean[])
       ON CONFLICT (business_id, match_key) DO UPDATE SET
         name = CASE WHEN customers.name = '' THEN EXCLUDED.name ELSE customers.name END,
         phone = COALESCE(customers.phone, EXCLUDED.phone),
         email = COALESCE(customers.email, EXCLUDED.email),
         sms_consent = customers.sms_consent OR EXCLUDED.sms_consent
       RETURNING id, match_key, (xmax = 0) AS inserted`,
      [business.id, list.map((c) => c.key), list.map((c) => c.name), list.map((c) => c.phone), list.map((c) => c.email), list.map((c) => c.smsConsent)],
    );

    const { rows: [count] } = await client.query<{ n: number }>('SELECT count(*) AS n FROM customers WHERE business_id = $1', [business.id]);
    if (count!.n > limit) {
      throw new ImportError(`This would bring you to ${count!.n} customers, over your plan's limit of ${limit}. Upgrade your plan or upload a smaller file.`);
    }

    const idByKey = new Map(up.rows.map((r) => [r.match_key, r.id]));
    // A newer summary replaces the estimated visits from an older one for the same customers.
    const summaryIds = [...new Set(visits.filter((v) => v.source === 'summary').map((v) => idByKey.get(v.key)))];
    const replaced = summaryIds.length
      ? (await client.query(`DELETE FROM visits WHERE business_id = $1 AND source = 'summary' AND customer_id = ANY($2::uuid[])`, [business.id, summaryIds])).rowCount ?? 0
      : 0;
    const ins = await client.query(
      `INSERT INTO visits (business_id, customer_id, visited_at, amount_cents, dedupe_key, source)
       SELECT $1, * FROM unnest($2::uuid[], $3::date[], $4::int[], $5::text[], $6::text[])
       ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [business.id, visits.map((v) => idByKey.get(v.key)), visits.map((v) => v.date), visits.map((v) => v.amountCents), visits.map((v) => v.dedupe), visits.map((v) => v.source)],
    );

    const created = up.rows.filter((r) => r.inserted).length;
    const inserted = ins.rowCount ?? 0;
    // For a summary, re-uploading replaces estimates, so report only the net change.
    const visitsAdded = mapped.format === 'customer_summary' ? Math.max(0, inserted - replaced) : inserted;
    const fileRows = new Set(mapped.rows.map((r) => r.line)).size + mapped.skipped.length + mapped.excludedByStatus;
    const { rows: [imp] } = await client.query<{ id: string }>(
      `INSERT INTO imports (business_id, filename, rows_total, visits_added, rows_skipped, customers_created)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [business.id, input.filename.slice(0, 200), fileRows, visitsAdded, mapped.skipped.length, created],
    );

    return {
      importId: imp!.id,
      rowsTotal: fileRows,
      visitsAdded,
      duplicateRows: mapped.format === 'customer_summary' ? 0 : visits.length - inserted,
      customersCreated: created,
      customersUpdated: up.rows.length - created,
      skipped: mapped.skipped.slice(0, 50),
      columns: mapped.columns,
      format: mapped.format,
      excludedByStatus: mapped.excludedByStatus,
    };
  });
}
