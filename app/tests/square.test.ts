import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import type { Providers } from '../src/providers/index.js';
import type { SquareCustomer, SquarePayment } from '../src/integrations/square.js';
import { syncAllSquare, syncSquare } from '../src/services/squareSync.js';
import { runTick } from '../src/services/sequences.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comeback:comeback@localhost:5432/comeback_test';
const base = {
  NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_URL: 'https://app.test', SESSION_SECRET: 'test-secret-test-secret-test-secret',
};
const config = loadConfig({ ...base, SQUARE_APP_ID: 'sq-app', SQUARE_APP_SECRET: 'sq-secret', SQUARE_ENVIRONMENT: 'sandbox' });

const START = new Date('2026-11-04T17:00:00Z');
const clock = { now: START };
const daysAgo = (n: number) => new Date(clock.now.getTime() - n * 864e5).toISOString();

// ---------------- Fake Square API ----------------
const sq = {
  payments: [] as SquarePayment[],
  customers: new Map<string, SquareCustomer>(),
  validTokens: new Set<string>(),
  validRefresh: new Set<string>(),
  revoked: [] as string[],
  refunds: [] as { id: string; payment_id: string; status: string; created_at: string }[],
  calls: [] as string[],
  tokenTtlDays: 30,
  n: 0,
};
const PAGE = 2; // small pages so pagination is exercised

const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  expect(url.origin).toBe('https://connect.squareupsandbox.com');
  const path = url.pathname;
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const headers = (init?.headers ?? {}) as Record<string, string>;
  expect(headers['Square-Version']).toBeTruthy();
  sq.calls.push(`${method} ${path}`);
  const json = (status: number, obj: unknown) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const page = <T>(items: T[]) => {
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const next = start + PAGE < items.length ? String(start + PAGE) : undefined;
    return { items: items.slice(start, start + PAGE), cursor: next };
  };

  if (path === '/oauth2/token') {
    expect(body.client_secret).toBe('sq-secret');
    if (body.grant_type === 'authorization_code' && body.code !== 'good-code') return json(400, { errors: [{ code: 'BAD_REQUEST', detail: 'Invalid code' }] });
    if (body.grant_type === 'refresh_token' && !sq.validRefresh.has(body.refresh_token)) return json(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'Refresh token revoked' }] });
    const t = `tok${++sq.n}`;
    sq.validTokens.add(t);
    sq.validRefresh.add(`ref-${t}`);
    return json(200, { access_token: t, refresh_token: `ref-${t}`, expires_at: new Date(clock.now.getTime() + sq.tokenTtlDays * 864e5).toISOString(), merchant_id: 'MERCHANT1' });
  }
  if (path === '/oauth2/revoke') {
    expect(headers.Authorization).toBe('Client sq-secret');
    sq.revoked.push(body.access_token);
    sq.validTokens.delete(body.access_token);
    return json(200, { success: true });
  }
  const token = String(headers.Authorization ?? '').replace('Bearer ', '');
  if (!sq.validTokens.has(token)) return json(401, { errors: [{ code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }] });
  if (path.startsWith('/v2/merchants/')) return json(200, { merchant: { business_name: 'Maple & Main (Square)' } });
  if (path === '/v2/payments') {
    expect(url.searchParams.get('sort_order')).toBe('ASC');
    const begin = url.searchParams.get('begin_time')!;
    const list = sq.payments.filter((p) => p.created_at >= begin).sort((a, b) => a.created_at.localeCompare(b.created_at));
    const { items, cursor } = page(list);
    return json(200, { payments: items, cursor });
  }
  if (path === '/v2/refunds') {
    const begin = url.searchParams.get('begin_time')!;
    const refunds = sq.refunds.filter((r) => r.created_at >= begin);
    const { items, cursor } = page(refunds);
    return json(200, { refunds: items, cursor });
  }
  if (path.startsWith('/v2/payments/')) {
    const p = sq.payments.find((x) => x.id === decodeURIComponent(path.split('/').pop()!));
    return p ? json(200, { payment: p }) : json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Payment not found' }] });
  }
  if (path === '/v2/customers') {
    const { items, cursor } = page([...sq.customers.values()]);
    return json(200, { customers: items, cursor });
  }
  if (path.startsWith('/v2/customers/')) {
    const c = sq.customers.get(decodeURIComponent(path.split('/').pop()!));
    return c ? json(200, { customer: c }) : json(404, { errors: [{ code: 'NOT_FOUND', detail: 'Customer not found' }] });
  }
  return json(404, { errors: [{ code: 'NOT_FOUND', detail: `no fake for ${path}` }] });
}) as typeof fetch;

let pid = 0;
function pay(customerId: string | undefined, ago: number, dollars: number, extra: Partial<SquarePayment> = {}): SquarePayment {
  const p: SquarePayment = { id: `PAY${++pid}`, created_at: daysAgo(ago), status: 'COMPLETED', amount_money: { amount: dollars * 100, currency: 'USD' }, customer_id: customerId, ...extra };
  sq.payments.push(p);
  return p;
}

// ---------------- App + helpers ----------------
const sent: { channel: string; to: string; body: string }[] = [];
const providers: Providers = {
  sms: { name: 'fake', async send({ to, body }) { sent.push({ channel: 'sms', to, body }); return { providerId: 'x' }; } },
  email: { name: 'fake', async send({ to, text }) { sent.push({ channel: 'email', to, body: text }); return { providerId: 'y' }; } },
};
let db: Db;
let app: FastifyInstance;

async function signup(email = 'owner@maple.test') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'a-long-password', businessName: 'Maple & Main', timezone: 'America/New_York' } });
  expect(res.statusCode).toBe(201);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}
const get = (cookie: string, url: string) => app.inject({ method: 'GET', url, headers: { cookie } });
const post = (cookie: string, url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload });

/** Run the full browser OAuth dance against the fake Square. */
async function connect(cookie: string) {
  const start = await get(cookie, '/integrations/square/connect');
  expect(start.statusCode).toBe(302);
  const authorize = new URL(start.headers.location as string);
  expect(authorize.origin + authorize.pathname).toBe('https://connect.squareupsandbox.com/oauth2/authorize');
  expect(authorize.searchParams.get('scope')).toBe('CUSTOMERS_READ PAYMENTS_READ MERCHANT_PROFILE_READ');
  const state = authorize.searchParams.get('state')!;
  const cb = await get(cookie, `/integrations/square/callback?code=good-code&state=${encodeURIComponent(state)}`);
  expect(cb.headers.location).toBe('/app#square-connected');
  // The first sync runs in the background; wait for it.
  for (let i = 0; i < 50; i++) {
    const { rows } = await db.query(`SELECT last_synced_at FROM integrations`);
    if (rows[0]?.last_synced_at) return state;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error('initial sync never finished');
}

const deps = () => app.square!;
const businessId = async () => (await db.query<{ id: string }>('SELECT id FROM businesses LIMIT 1')).rows[0]!.id;

beforeAll(async () => {
  db = createPool(DB_URL);
  app = await buildApp({ config, db, providers, now: () => clock.now, fetch: fakeFetch });
});
afterAll(async () => { await app.close(); await db.end(); });
beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  Object.assign(sq, { payments: [], customers: new Map(), validTokens: new Set(), validRefresh: new Set(), revoked: [], refunds: [], calls: [], tokenTtlDays: 30 });
  sent.length = 0;
  clock.now = START;
});

describe('Square connection', () => {
  it('connects with OAuth, stores tokens encrypted, and backfills a year of payments', async () => {
    const cookie = await signup();
    sq.customers.set('C_DANA', { id: 'C_DANA', given_name: 'Dana', family_name: 'Reyes', phone_number: '+1 555-201-3344', email_address: 'dana@x.test' });
    sq.customers.set('C_MO', { id: 'C_MO', given_name: 'Mo', family_name: 'Ali', email_address: 'mo@x.test', preferences: { email_unsubscribed: true } });
    [80, 115, 150, 185].forEach((n) => pay('C_DANA', n, 92));
    pay('C_MO', 20, 40);
    pay(undefined, 5, 15); // walk-in, no customer attached
    pay('C_DANA', 400, 92); // older than the one-year backfill
    pay('C_DANA', 30, 50, { status: 'FAILED' });

    expect((await get(cookie, '/api/integrations')).json().square).toMatchObject({ available: true, connected: false });
    await connect(cookie);

    const { rows: [i] } = await db.query(`SELECT * FROM integrations`);
    expect(i.status).toBe('connected');
    expect(i.account_name).toBe('Maple & Main (Square)');
    expect(i.access_token_enc).not.toContain('tok'); // encrypted at rest
    expect(i.refresh_token_enc).not.toContain('ref-');

    const status = (await get(cookie, '/api/integrations')).json().square;
    expect(status).toMatchObject({ connected: true, status: 'connected', accountName: 'Maple & Main (Square)', lastError: null });

    const { customers } = (await get(cookie, '/api/customers?status=all')).json();
    const dana = customers.find((c: any) => c.name === 'Dana Reyes');
    expect(dana.rhythm).toMatchObject({ visitCount: 4, intervalDays: 35, avgCents: 9200 });
    expect(dana.display).toBe('overdue');
    expect(dana.sms_consent).toBe(false); // Square doesn't share text permission
    const mo = customers.find((c: any) => c.name === 'Mo Ali');
    expect(mo.email_opted_out).toBe(true);
    expect(customers).toHaveLength(2);

    const imports = (await get(cookie, '/api/imports')).json().imports;
    expect(imports[0]).toMatchObject({ filename: 'Square sync', visits_added: 5, customers_created: 2, rows_skipped: 1 });
  });

  it('merges Square customers into customers already uploaded from a CSV', async () => {
    const cookie = await signup();
    await post(cookie, '/api/imports', { csv: 'name,phone,date,amount,text ok\nDana Reyes,555-201-3344,2026-01-10,90,yes', smsConsentAll: false });
    sq.customers.set('C_DANA', { id: 'C_DANA', given_name: 'Dana', family_name: 'R.', phone_number: '5552013344' });
    pay('C_DANA', 60, 95);
    await connect(cookie);
    const { customers } = (await get(cookie, '/api/customers?status=all')).json();
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ name: 'Dana Reyes', sms_consent: true }); // CSV name and consent kept
    expect(customers[0].rhythm.visitCount).toBe(2);
  });

  it('syncs incrementally without duplicates and handles refunds', async () => {
    const cookie = await signup();
    sq.customers.set('C1', { id: 'C1', given_name: 'Ava', family_name: 'Mitchell', email_address: 'ava@x.test' });
    const p1 = pay('C1', 50, 80);
    const p2 = pay('C1', 20, 100);
    await connect(cookie);
    const bid = await businessId();

    // Nothing new: no duplicates.
    clock.now = new Date(START.getTime() + 2 * 3600e3);
    let r = await syncSquare(deps(), bid, clock.now);
    expect(r).toMatchObject({ visitsAdded: 0, visitsUpdated: 0 });

    // A new sale, a partial refund on a recent one, a full refund on another.
    pay('C1', 0, 70);
    p2.refunded_money = { amount: 2500, currency: 'USD' };
    const p3 = pay('C1', 1, 60);
    p3.refunded_money = { amount: 6000, currency: 'USD' };
    r = await syncSquare(deps(), bid, clock.now);
    expect(r).toMatchObject({ visitsAdded: 1, visitsUpdated: 1, visitsRemoved: 0 });

    // p1 is outside the overlap window, so the incremental sync didn't re-read it.
    const { rows } = await db.query(`SELECT dedupe_key, amount_cents FROM visits ORDER BY visited_at`);
    expect(rows).toEqual([
      { dedupe_key: `sq:${p1.id}`, amount_cents: 8000 },
      { dedupe_key: `sq:${p2.id}`, amount_cents: 7500 },
      { dedupe_key: expect.stringMatching(/^sq:PAY/), amount_cents: 7000 },
    ]);

    // A full refund weeks later on an older payment (outside the 3-day re-read) is found
    // through the Refunds API and removes the visit.
    p2.refunded_money = { amount: 10000, currency: 'USD' };
    sq.refunds.push({ id: 'R1', payment_id: p2.id, status: 'COMPLETED', created_at: clock.now.toISOString() });
    clock.now = new Date(START.getTime() + 2 * 864e5);
    r = await syncSquare(deps(), bid, clock.now);
    expect(r.visitsRemoved).toBe(1);
  });

  it('counts a Square sale as a win for a running win-back', async () => {
    const cookie = await signup();
    sq.customers.set('C_DANA', { id: 'C_DANA', given_name: 'Dana', family_name: 'Reyes', email_address: 'dana@x.test' });
    [80, 115, 150].forEach((n) => pay('C_DANA', n, 92));
    await connect(cookie);
    const dana = (await get(cookie, '/api/customers')).json().customers[0];
    expect((await post(cookie, `/api/customers/${dana.id}/winback`)).statusCode).toBe(201);
    expect(sent).toHaveLength(1);

    // Two days later Dana pays in Square. The scheduler syncs, then the tick runs.
    clock.now = new Date(START.getTime() + 2 * 864e5);
    pay('C_DANA', 0, 110);
    expect(await syncAllSquare(deps(), clock.now)).toEqual({ synced: 1, failed: 0 });
    const detail = (await get(cookie, `/api/customers/${dana.id}`)).json();
    expect(detail.customer.display).toBe('won');
    expect(detail.sequences[0]).toMatchObject({ status: 'won', recovered_cents: 11000 });

    // No more messages to someone who came back.
    await runTick({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET }, new Date(START.getTime() + 8 * 864e5));
    expect(sent).toHaveLength(1);
  });

  it('syncs about hourly, refreshes expiring tokens, and flags revoked access', async () => {
    sq.tokenTtlDays = 5; // already inside the refresh window
    const cookie = await signup();
    await connect(cookie);
    const bid = await businessId();
    expect(sq.calls.filter((c) => c === 'POST /oauth2/token')).toHaveLength(2); // code exchange + refresh

    expect((await syncAllSquare(deps(), new Date(clock.now.getTime() + 10 * 60_000))).synced).toBe(0); // too soon
    sq.tokenTtlDays = 30;

    // The merchant removes access in their Square dashboard.
    sq.validTokens.clear();
    sq.validRefresh.clear();
    clock.now = new Date(START.getTime() + 2 * 3600e3);
    const res = await post(cookie, '/api/integrations/square/sync');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Reconnect Square/);
    expect((await get(cookie, '/api/integrations')).json().square).toMatchObject({ status: 'needs_reauth' });
    // Accounts that need reconnecting are skipped by the scheduler.
    expect(await syncAllSquare(deps(), new Date(clock.now.getTime() + 2 * 3600e3))).toEqual({ synced: 0, failed: 0 });

    // Reconnecting fixes it.
    await db.query(`UPDATE integrations SET last_synced_at = NULL`);
    await connect(cookie);
    expect((await get(cookie, '/api/integrations')).json().square.status).toBe('connected');
    void bid;
  });

  it('disconnects: revokes the token and forgets it, but keeps the data', async () => {
    const cookie = await signup();
    sq.customers.set('C1', { id: 'C1', given_name: 'Ava', email_address: 'ava@x.test' });
    pay('C1', 10, 50);
    await connect(cookie);
    expect((await post(cookie, '/api/integrations/square/disconnect')).statusCode).toBe(200);
    expect(sq.revoked).toHaveLength(1);
    const { rows: [i] } = await db.query(`SELECT status, access_token_enc, refresh_token_enc FROM integrations`);
    expect(i).toEqual({ status: 'disconnected', access_token_enc: null, refresh_token_enc: null });
    expect((await get(cookie, '/api/integrations')).json().square.connected).toBe(false);
    expect((await get(cookie, '/api/customers?status=all')).json().total).toBe(1);
  });
});

describe('Square OAuth safety', () => {
  it('rejects forged, expired, or someone else’s state, and needs a login', async () => {
    const a = await signup('a@test.dev');
    const b = await signup('b@test.dev');
    const startA = await get(a, '/integrations/square/connect');
    const stateA = new URL(startA.headers.location as string).searchParams.get('state')!;

    // Business B can't complete A's connection.
    expect((await get(b, `/integrations/square/callback?code=good-code&state=${encodeURIComponent(stateA)}`)).headers.location).toBe('/app#square-error');
    // Forged state.
    expect((await get(a, `/integrations/square/callback?code=good-code&state=abc.def`)).headers.location).toBe('/app#square-error');
    // Merchant pressed "Deny".
    expect((await get(a, `/integrations/square/callback?error=access_denied&state=${encodeURIComponent(stateA)}`)).headers.location).toBe('/app#square-cancelled');
    // Bad code from Square.
    expect((await get(a, `/integrations/square/callback?code=bad&state=${encodeURIComponent(stateA)}`)).headers.location).toBe('/app#square-error');
    // Logged out.
    expect((await app.inject({ method: 'GET', url: '/integrations/square/connect' })).headers.location).toBe('/app#login');
    expect((await db.query(`SELECT count(*)::int AS n FROM integrations`)).rows[0].n).toBe(0);
  });

  it('reports Square as unavailable when the server has no Square keys', async () => {
    const plain = await buildApp({ config: loadConfig(base), db, providers, now: () => clock.now });
    const res = await plain.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'x@test.dev', password: 'a-long-password', businessName: 'X' } });
    const cookie = String(res.headers['set-cookie']).split(';')[0]!;
    expect((await plain.inject({ method: 'GET', url: '/api/integrations', headers: { cookie } })).json().square).toMatchObject({ available: false, connected: false });
    expect((await plain.inject({ method: 'GET', url: '/integrations/square/connect', headers: { cookie } })).headers.location).toBe('/app#square-unavailable');
    await plain.close();
  });
});
