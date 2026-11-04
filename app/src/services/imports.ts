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
  if (mapped.rows.length === 0) throw new ImportError(`No usable rows. First problem: line ${mapped.skipped[0]?.line}: ${mapped.skipped[0]?.reason}`);

  // Group rows into customers and build visit dedupe keys.
  type Cust = { key: string; name: string; phone: string | null; email: string | null; smsConsent: boolean };
  const customers = new Map<string, Cust>();
  const seen = new Map<string, number>();
  const visits: { key: string; date: string; amountCents: number; dedupe: string }[] = [];

  for (const row of mapped.rows) {
    const key = matchKey(row);
    const c = customers.get(key) ?? { key, name: row.name, phone: row.phone, email: row.email, smsConsent: false };
    c.name = c.name || row.name;
    c.phone ??= row.phone;
    c.email ??= row.email;
    if (row.smsConsent === true || (input.smsConsentAll && row.smsConsent !== false)) c.smsConsent = true;
    customers.set(key, c);

    const base = `${key}|${row.date}|${row.amountCents}`;
    const n = (seen.get(base) ?? 0) + 1; // identical purchases on the same day in one file both count
    seen.set(base, n);
    visits.push({ key, date: row.date, amountCents: row.amountCents, dedupe: `${base}|${n}` });
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
    const ins = await client.query(
      `INSERT INTO visits (business_id, customer_id, visited_at, amount_cents, dedupe_key)
       SELECT $1, * FROM unnest($2::uuid[], $3::date[], $4::int[], $5::text[])
       ON CONFLICT (business_id, dedupe_key) DO NOTHING`,
      [business.id, visits.map((v) => idByKey.get(v.key)), visits.map((v) => v.date), visits.map((v) => v.amountCents), visits.map((v) => v.dedupe)],
    );

    const created = up.rows.filter((r) => r.inserted).length;
    const visitsAdded = ins.rowCount ?? 0;
    const { rows: [imp] } = await client.query<{ id: string }>(
      `INSERT INTO imports (business_id, filename, rows_total, visits_added, rows_skipped, customers_created)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [business.id, input.filename.slice(0, 200), mapped.rows.length + mapped.skipped.length, visitsAdded, mapped.skipped.length, created],
    );

    return {
      importId: imp!.id,
      rowsTotal: mapped.rows.length + mapped.skipped.length,
      visitsAdded,
      duplicateRows: visits.length - visitsAdded,
      customersCreated: created,
      customersUpdated: up.rows.length - created,
      skipped: mapped.skipped.slice(0, 50),
      columns: mapped.columns,
    };
  });
}
