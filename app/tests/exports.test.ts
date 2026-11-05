import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mapCsv, CsvError } from '../src/lib/csv.js';
import { computeRhythm } from '../src/lib/rhythm.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

describe('reading real-world exports', () => {
  it('reads a Square-style transactions export', () => {
    const m = mapCsv([
      'Date,Time,Time Zone,Gross Sales,Discounts,Net Sales,Tax,Tip,Total Collected,Transaction ID,Customer ID,Customer Name,Customer Reference ID',
      '2026-09-14,10:12:00,Central Time,$90.00,$0.00,$90.00,$7.43,$15.00,$112.43,T1,C1,Dana Reyes,R1',
      '2026-10-20,11:00:00,Central Time,$90.00,$0.00,$90.00,$7.43,$0.00,$97.43,T2,C1,Dana Reyes,R1',
    ].join('\n'));
    expect(m.format).toBe('purchases');
    expect(m.columns).toMatchObject({ date: 'Date', amount: 'Total Collected', name: 'Customer Name' });
    expect(m.rows.map((r) => r.amountCents)).toEqual([11243, 9743]);
  });

  it('reads a groomer appointment export: client not pet, skips cancelled and no-shows', () => {
    const m = mapCsv([
      'Appointment Date,Status,Pet Name,Client Name,Phone,Email,Service,Groomer,Total',
      '09/01/2026,Finished,Biscuit,Ana Lopez,(214) 555-0101,ana@x.test,Full groom,Kim,$95.00',
      '10/13/2026,Canceled,Biscuit,Ana Lopez,(214) 555-0101,ana@x.test,Full groom,Kim,$95.00',
      '10/20/2026,No-show,Biscuit,Ana Lopez,(214) 555-0101,ana@x.test,Full groom,Kim,$95.00',
      '10/27/2026,Finished,Biscuit,Ana Lopez,(214) 555-0101,ana@x.test,Full groom,Kim,$95.00',
    ].join('\n'));
    expect(m.columns).toMatchObject({ date: 'Appointment Date', name: 'Client Name', status: 'Status', amount: 'Total', phone: 'Phone' });
    expect(m.rows).toHaveLength(2);
    expect(m.rows[0]).toMatchObject({ name: 'Ana Lopez', phone: '+12145550101', date: '2026-09-01', amountCents: 9500 });
    expect(m.excludedByStatus).toBe(2);
  });

  it('reads an invoice report: issued date not due date, total not balance, skips drafts and voids', () => {
    const m = mapCsv([
      'Invoice #,Client name,Issued date,Due date,Status,Subject,Total,Balance',
      '1001,Mirror Fan,2026-08-01,2026-08-31,Paid,Full detail,$180.00,$0.00',
      '1002,Mirror Fan,2026-09-15,2026-10-15,Paid,Maintenance wash,$75.00,$0.00',
      '1003,Mirror Fan,2026-10-30,2026-11-29,Draft,Full detail,$180.00,$180.00',
      '1004,Mirror Fan,2026-10-01,2026-10-31,Void,Full detail,$180.00,$0.00',
    ].join('\n'));
    expect(m.columns).toMatchObject({ date: 'Issued date', amount: 'Total', name: 'Client name', status: 'Status' });
    expect(m.rows.map((r) => [r.date, r.amountCents])).toEqual([['2026-08-01', 18000], ['2026-09-15', 7500]]);
  });

  it('reads tab-separated and semicolon files', () => {
    const tab = mapCsv('Customer\tDate\tAmount\nAna\t2026-01-05\t40\n');
    const semi = mapCsv('Customer;Date;Amount\nAna;2026-01-05;40\n');
    for (const m of [tab, semi]) expect(m.rows[0]).toMatchObject({ name: 'Ana', date: '2026-01-05', amountCents: 4000 });
  });

  it('leaves out refund rows with negative amounts', () => {
    const m = mapCsv('name,date,amount\nAna,2026-01-05,40\nAna,2026-01-06,-40\nAna,2026-01-07,($20.00)\n');
    expect(m.rows).toHaveLength(1);
    expect(m.excludedByStatus).toBe(2);
  });

  it('estimates visits from a customer-summary export, without mistaking email status for text consent', () => {
    const m = mapCsv([
      'First Name,Last Name,Phone Number,Email Address,First Visit,Last Visit,Transaction Count,Total Spend,Email Subscription Status',
      'Dana,Reyes,214-555-0199,dana@x.test,2026-01-05,2026-07-05,5,$450.00,subscribed',
      'Solo,Visit,,solo@x.test,,2026-06-01,1,$60.00,subscribed',
    ].join('\n'));
    expect(m.format).toBe('customer_summary');
    expect(m.columns).toMatchObject({ lastVisit: 'Last Visit', firstVisit: 'First Visit', visitCount: 'Transaction Count', totalSpend: 'Total Spend', consent: undefined });
    const dana = m.rows.filter((r) => r.name === 'Dana Reyes');
    expect(dana.map((r) => r.date)).toEqual(['2026-01-05', '2026-02-19', '2026-04-06', '2026-05-21', '2026-07-05']);
    expect(dana.every((r) => r.amountCents === 9000 && r.smsConsent === null)).toBe(true);
    const r = computeRhythm(dana.map((v) => ({ date: v.date, amountCents: v.amountCents })), '2026-11-05', { defaultIntervalDays: 42, overdueMultiplier: 1.5 })!;
    expect(r.intervalDays).toBe(45);
    expect(r.status).toBe('overdue'); // 123 days since July 5 is 2.7x her 45-day rhythm
    expect(m.rows.filter((x) => x.name === 'Solo Visit')).toHaveLength(1);
  });

  it('explains Excel files and missing columns', () => {
    expect(() => mapCsv('PK\u0003\u0004binary...')).toThrow(/Excel file/);
    expect(() => mapCsv('Pet Name,Date\nBiscuit,2026-01-01')).toThrow(CsvError);
    expect(() => mapCsv('Customer,Amount\nAna,40')).toThrow(/date column/);
  });
});

describe('importing a customer summary twice', () => {
  const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comeback:comeback@localhost:5432/comeback_test';
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_URL: 'https://app.test', SESSION_SECRET: 'test-secret-test-secret-test-secret' });
  let db: Db;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = createPool(DB_URL);
    app = await buildApp({ config, db, providers: { sms: null, email: null }, now: () => new Date('2026-11-05T17:00:00Z') });
  });
  afterAll(async () => { await app.close(); await db.end(); });
  beforeEach(async () => { await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await migrate(db); });

  it('replaces estimates instead of piling them up, and keeps real visits', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'o@x.test', password: 'a-long-password', businessName: 'Sudsy Paws', industry: 'groomer' } });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    const post = (csv: string) => app.inject({ method: 'POST', url: '/api/imports', headers: { cookie }, payload: { csv } });
    const head = 'Client Name,Email,First Visit,Last Visit,Total Visits,Lifetime Spend';

    const a = (await post(`${head}\nDana Reyes,dana@x.test,2026-01-05,2026-07-05,5,450\n`)).json();
    expect(a).toMatchObject({ format: 'customer_summary', visitsAdded: 5, customersCreated: 1, rowsTotal: 1 });

    // A month later the same client list has one more visit.
    const b = (await post(`${head}\nDana Reyes,dana@x.test,2026-01-05,2026-08-10,6,540\n`)).json();
    expect(b).toMatchObject({ visitsAdded: 1, customersCreated: 0 });
    // A real purchase upload adds alongside.
    await post('name,email,date,amount\nDana Reyes,dana@x.test,2026-10-01,95\n');

    const { rows } = await db.query(`SELECT source, count(*)::int AS n FROM visits GROUP BY source ORDER BY source`);
    expect(rows).toEqual([{ source: 'csv', n: 1 }, { source: 'summary', n: 6 }]);
    const list = (await app.inject({ method: 'GET', url: '/api/customers?status=all', headers: { cookie } })).json();
    expect(list.customers[0].rhythm.visitCount).toBe(7);
  });
});
