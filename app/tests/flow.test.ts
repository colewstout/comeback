import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { addDays } from '../src/lib/dates.js';
import { twilioSignature } from '../src/lib/security.js';
import type { EmailProvider, Providers, SmsProvider } from '../src/providers/index.js';
import { runTick } from '../src/services/sequences.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comeback:comeback@localhost:5432/comeback_test';
const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_URL: 'https://app.test', SESSION_SECRET: 'test-secret-test-secret-test-secret',
  CRON_SECRET: 'cron-secret', TWILIO_AUTH_TOKEN: 'twilio-token', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_PRICE_GROWTH: 'price_growth',
});

const sent: { channel: 'sms' | 'email'; to: string; body: string; subject?: string }[] = [];
let failNextSms = false;
const sms: SmsProvider = {
  name: 'fake-sms',
  async send({ to, body }) {
    if (failNextSms) { failNextSms = false; throw new Error('carrier rejected'); }
    sent.push({ channel: 'sms', to, body }); return { providerId: `sms${sent.length}` };
  },
};
const email: EmailProvider = { name: 'fake-email', async send({ to, text, subject }) { sent.push({ channel: 'email', to, body: text, subject }); return { providerId: `em${sent.length}` }; } };
const providers: Providers = { sms, email };

// Noon in New York on Nov 4, 2026.
const START = new Date('2026-11-04T17:00:00Z');
const clock = { now: START };
const TODAY = '2026-11-04';
const d = (daysAgo: number) => addDays(TODAY, -daysAgo);

let db: Db;
let app: FastifyInstance;

async function resetDb() {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
}

function cookieFrom(res: { headers: Record<string, unknown> }) {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : String(raw);
  return first.split(';')[0]!;
}

async function signup(emailAddr = 'owner@maple.test', industry = 'salon') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: emailAddr, password: 'a-long-password', name: 'Owner', businessName: 'Maple & Main', industry, timezone: 'America/New_York' } });
  expect(res.statusCode).toBe(201);
  return cookieFrom(res);
}

const api = (cookie: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
  post: (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload: payload ?? {} }),
  patch: (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: { cookie }, payload }),
});

const CSV = [
  'Customer,Phone,Email,Date,Amount,SMS Opt In',
  // Dana: every 35 days, last seen 80 days ago -> overdue. Has text consent.
  ...[80, 115, 150, 185].map((n) => `Dana Reyes,555-201-3344,dana@x.test,${d(n)},92.00,yes`),
  // Marcus: every 30 days, last seen 10 days ago -> on track. Email only.
  ...[10, 40, 70].map((n) => `Marcus Bell,,marcus@x.test,${d(n)},60`),
  // Priya: one visit 200 days ago -> lapsed (uses the 42-day salon default). Phone, no consent, plus email.
  `Priya Shah,555-201-9999,priya@x.test,${d(200)},120`,
  // Ollie: last seen 900 days ago -> too stale to contact.
  ...[900, 930].map((n) => `Ollie Old,,ollie@x.test,${d(n)},50`),
  'Broken Row,,,not-a-date,10',
].join('\n');

beforeAll(async () => {
  db = createPool(DB_URL);
  app = await buildApp({ config, db, providers, now: () => clock.now });
});
afterAll(async () => { await app.close(); await db.end(); });
beforeEach(async () => { await resetDb(); sent.length = 0; clock.now = START; failNextSms = false; });

describe('accounts', () => {
  it('requires login and keeps businesses apart', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    const a = await signup('a@test.dev');
    const b = await signup('b@test.dev');
    await api(a).post('/api/imports', { filename: 'a.csv', csv: CSV });
    const { customers } = (await api(a).get('/api/customers')).json();
    expect((await api(b).get(`/api/customers/${customers[0].id}`)).statusCode).toBe(404);
    expect((await api(b).get('/api/customers')).json().total).toBe(0);
  });

  it('rejects duplicate signups and bad passwords, and logs out', async () => {
    const c = await signup();
    const dup = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email: 'owner@maple.test', password: 'a-long-password', businessName: 'X' } });
    expect(dup.statusCode).toBe(409);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@maple.test', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'OWNER@maple.test', password: 'a-long-password' } });
    expect(good.statusCode).toBe(200);
    await api(c).post('/api/auth/logout');
    expect((await api(c).get('/api/me')).statusCode).toBe(401);
  });
});

describe('import and rhythm', () => {
  it('imports a CSV, groups customers, and is safe to re-upload', async () => {
    const c = await signup();
    const r1 = (await api(c).post('/api/imports', { filename: 'sales.csv', csv: CSV })).json();
    expect(r1).toMatchObject({ customersCreated: 4, visitsAdded: 10, duplicateRows: 0 });
    expect(r1.skipped).toHaveLength(1);
    const r2 = (await api(c).post('/api/imports', { filename: 'sales.csv', csv: CSV })).json();
    expect(r2).toMatchObject({ customersCreated: 0, visitsAdded: 0, duplicateRows: 10 });

    const { customers, counts } = (await api(c).get('/api/customers')).json();
    const by = Object.fromEntries(customers.map((x: any) => [x.name, x]));
    expect(by['Dana Reyes'].display).toBe('overdue');
    expect(by['Dana Reyes'].rhythm.intervalDays).toBe(35);
    expect(by['Dana Reyes'].channel).toBe('sms');
    expect(by['Marcus Bell'].display).toBe('ok');
    expect(by['Priya Shah'].display).toBe('lapsed');
    expect(by['Priya Shah'].channel).toBe('email'); // phone but no text consent
    expect(counts).toMatchObject({ overdue: 1, lapsed: 2, ok: 1 });

    const dash = (await api(c).get('/api/dashboard')).json().dashboard;
    expect(dash.customers).toBe(4);
    expect(dash.slippingMonthlyCents).toBeGreaterThan(0);
  });

  it('enforces plan customer limits', async () => {
    const c = await signup();
    await db.query(`UPDATE businesses SET plan = 'starter', plan_status = 'active'`);
    const rows = Array.from({ length: 501 }, (_, i) => `Person ${i},p${i}@x.test,${d(30)},10`);
    const res = await api(c).post('/api/imports', { csv: ['name,email,date,amount', ...rows].join('\n') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/limit of 500/);
    expect((await api(c).get('/api/customers')).json().total).toBe(0); // rolled back
  });

  it('reports CSV problems clearly', async () => {
    const c = await signup();
    const res = await api(c).post('/api/imports', { csv: 'name,amount\nA,1' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/date column/);
  });
});

describe('win-back sequences', () => {
  it('runs a manual win-back end to end and counts the return visit', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const dana = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Dana Reyes');

    const preview = (await api(c).get(`/api/customers/${dana.id}`)).json().preview;
    expect(preview).toHaveLength(3);
    expect(preview[1].body).toMatch(/DANA15/);

    const start = await api(c).post(`/api/customers/${dana.id}/winback`);
    expect(start.statusCode).toBe(201);
    expect(start.json().firstMessage).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'sms', to: '+15552013344' });
    expect(sent[0]!.body).toMatch(/^Hi Dana, it's Maple & Main\. It's been about 3 months/);
    expect((await api(c).post(`/api/customers/${dana.id}/winback`)).statusCode).toBe(409);

    const deps = { db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET };
    // Nothing more until day 7.
    clock.now = new Date(START.getTime() + 3 * 864e5);
    await runTick(deps, clock.now);
    expect(sent).toHaveLength(1);
    clock.now = new Date(START.getTime() + 7 * 864e5);
    await runTick(deps, clock.now);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toMatch(/15% off your next appointment before Dec 2\. Use code DANA15/);

    // Dana books. The next upload includes her visit; the next run records the win.
    clock.now = new Date(START.getTime() + 10 * 864e5);
    await api(c).post('/api/imports', { csv: `name,phone,date,amount\nDana Reyes,5552013344,${addDays(TODAY, 9)},105.50` });
    const tick = await runTick(deps, clock.now);
    expect(tick.wins).toBe(1);

    const detail = (await api(c).get(`/api/customers/${dana.id}`)).json();
    expect(detail.customer.display).toBe('won');
    expect(detail.sequences[0]).toMatchObject({ status: 'won', recovered_cents: 10550, steps_sent: 2 });
    const dash = (await api(c).get('/api/dashboard')).json().dashboard;
    expect(dash.last30).toMatchObject({ wins: 1, recoveredCents: 10550, messagesSent: 2 });

    const report = (await api(c).get('/api/report/weekly')).json();
    expect(report.subject).toMatch(/1 customer came back this week: \$106 recovered/);
    expect(report.text).toMatch(/Dana Reyes: \$106/);

    // Day 21 passes: no "last call" to someone who already came back.
    clock.now = new Date(START.getTime() + 22 * 864e5);
    await runTick(deps, clock.now);
    expect(sent).toHaveLength(2);
  });

  it('autopilot starts eligible customers, respects sending hours, and finishes after 3 messages', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const deps = { db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET };

    // Autopilot off: nothing happens.
    expect((await runTick(deps, START)).started).toBe(0);
    await api(c).patch('/api/business', { autopilot: true });

    // 11pm New York: sequences start but nothing is sent until morning.
    const night = new Date('2026-11-05T04:00:00Z');
    const t1 = await runTick(deps, night);
    expect(t1.started).toBe(2); // Dana and Priya; Marcus is on track and Ollie is too stale
    expect(sent).toHaveLength(0);

    const morning = new Date('2026-11-05T14:00:00Z'); // 9am
    expect((await runTick(deps, morning)).sent).toBe(2);
    expect(sent.map((m) => m.channel).sort()).toEqual(['email', 'sms']);
    const priyaEmail = sent.find((m) => m.channel === 'email')!;
    expect(priyaEmail.to).toBe('priya@x.test');
    expect(priyaEmail.body).toMatch(/Thanks again for coming in 7 months ago/);
    expect(priyaEmail.body).toMatch(/Unsubscribe: https:\/\/app\.test\/u\//);

    // Running again the same hour doesn't double-send.
    expect((await runTick(deps, morning)).sent).toBe(0);

    for (const day of [8, 22]) await runTick(deps, new Date(morning.getTime() + day * 864e5));
    expect(sent).toHaveLength(6);
    const { rows } = await db.query(`SELECT status, steps_sent FROM sequences`);
    expect(rows.every((r) => r.status === 'completed' && r.steps_sent === 3)).toBe(true);

    // 90-day cooldown: no new win-back the next day.
    expect((await runTick(deps, new Date(morning.getTime() + 23 * 864e5))).started).toBe(0);
  });

  it('retries failed sends and stops after three failures', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const dana = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Dana Reyes');
    failNextSms = true;
    const res = await api(c).post(`/api/customers/${dana.id}/winback`);
    expect(res.json().firstMessage).toBe('failed');
    const deps = { db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET };
    await runTick(deps, new Date(START.getTime() + 3600e3));
    expect(sent).toHaveLength(1); // retried and succeeded
    const { rows } = await db.query(`SELECT status FROM messages ORDER BY created_at`);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'sent']);
  });

  it('does not run for businesses whose trial has ended', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    await api(c).patch('/api/business', { autopilot: true });
    await db.query(`UPDATE businesses SET trial_ends_at = $1`, [new Date(START.getTime() - 864e5)]);
    const t = await runTick({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET }, START);
    expect(t).toMatchObject({ businesses: 0, started: 0 });
  });
});

describe('opt-outs and webhooks', () => {
  it('handles STOP texts from Twilio with a valid signature', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const dana = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Dana Reyes');
    await api(c).post(`/api/customers/${dana.id}/winback`);

    const params = { From: '+15552013344', To: '+15550000000', Body: 'Stop', MessageSid: 'SM1' };
    const url = '/webhooks/twilio/sms';
    const bad = await app.inject({ method: 'POST', url, payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' } });
    expect(bad.statusCode).toBe(403);

    const sig = twilioSignature('twilio-token', `https://app.test${url}`, params);
    const ok = await app.inject({ method: 'POST', url, payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
    expect(ok.statusCode).toBe(200);

    const detail = (await api(c).get(`/api/customers/${dana.id}`)).json();
    expect(detail.customer.sms_opted_out).toBe(true);
    expect(detail.sequences[0]).toMatchObject({ status: 'stopped', stop_reason: 'opted_out' });
    expect(detail.messages.some((m: any) => m.direction === 'in' && m.body === 'Stop')).toBe(true);
    // Dana still has an email, so a future win-back would use email, never text.
    expect(detail.customer.channel).toBe('email');
  });

  it('unsubscribes from email only after the confirm button', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const priya = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Priya Shah');
    await api(c).post(`/api/customers/${priya.id}/winback`);
    const link = /https:\/\/app\.test(\/u\/[^\s]+)/.exec(sent[0]!.body)![1]!;

    expect((await app.inject({ method: 'GET', url: link })).statusCode).toBe(200);
    expect((await api(c).get(`/api/customers/${priya.id}`)).json().customer.email_opted_out).toBe(false);

    const post = await app.inject({ method: 'POST', url: link });
    expect(post.body).toMatch(/You're unsubscribed/);
    const detail = (await api(c).get(`/api/customers/${priya.id}`)).json();
    expect(detail.customer.email_opted_out).toBe(true);
    expect(detail.sequences[0].status).toBe('stopped');
    expect((await app.inject({ method: 'POST', url: '/u/forged.token' })).statusCode).toBe(400);
  });

  it('activates a subscription from a signed Stripe webhook, once', async () => {
    const c = await signup();
    const me = (await api(c).get('/api/me')).json();
    const event = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { client_reference_id: me.business.id, customer: 'cus_1', subscription: 'sub_1', metadata: { plan: 'growth' } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${event}`).digest('hex');
    const send = (s: string) => app.inject({ method: 'POST', url: '/webhooks/stripe', payload: event, headers: { 'content-type': 'application/json', 'stripe-signature': s } });

    expect((await send(`t=${t},v1=bad`)).statusCode).toBe(400);
    expect((await send(`t=${t},v1=${sig}`)).json().result).toBe('activated');
    expect((await send(`t=${t},v1=${sig}`)).json().result).toBe('duplicate');
    const after = (await api(c).get('/api/me')).json().business;
    expect(after).toMatchObject({ plan: 'growth', plan_status: 'active', has_billing: true });

    const cancel = JSON.stringify({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', status: 'canceled', metadata: {} } } });
    const sig2 = createHmac('sha256', 'whsec_test').update(`${t}.${cancel}`).digest('hex');
    await app.inject({ method: 'POST', url: '/webhooks/stripe', payload: cancel, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig2}` } });
    expect((await api(c).get('/api/me')).json().business.plan_status).toBe('canceled');
  });

  it('protects job endpoints with the cron secret', async () => {
    expect((await app.inject({ method: 'POST', url: '/jobs/tick' })).statusCode).toBe(401);
    const ok = await app.inject({ method: 'POST', url: '/jobs/tick', headers: { authorization: 'Bearer cron-secret' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ businesses: 0 });
  });
});

describe('settings', () => {
  it('validates settings', async () => {
    const c = await signup();
    expect((await api(c).patch('/api/business', { discount_pct: 80 })).statusCode).toBe(400);
    expect((await api(c).patch('/api/business', { timezone: 'Mars/Base' })).statusCode).toBe(400);
    expect((await api(c).patch('/api/business', { send_window_start: 21 })).statusCode).toBe(400); // end is 20
    const ok = await api(c).patch('/api/business', { discount_pct: 20, booking_url: 'https://book.example.com/maple', postal_address: '12 Main St, Springfield' });
    expect(ok.json().business).toMatchObject({ discount_pct: 20, booking_url: 'https://book.example.com/maple' });
  });
});

describe('scheduler', () => {
  it('sends the Monday report once per week, only on Monday mornings UTC', async () => {
    const { maybeSendWeeklyReport } = await import('../src/jobs/scheduler.js');
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const o = { db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET, log: () => {} };
    expect(await maybeSendWeeklyReport(o, new Date('2026-11-09T09:00:00Z'))).toBe(false); // Monday, too early
    expect(await maybeSendWeeklyReport(o, new Date('2026-11-10T13:00:00Z'))).toBe(false); // Tuesday
    expect(await maybeSendWeeklyReport(o, new Date('2026-11-09T12:15:00Z'))).toBe(true);
    expect(await maybeSendWeeklyReport(o, new Date('2026-11-09T12:30:00Z'))).toBe(false); // already sent
    const reports = sent.filter((m) => m.to === 'owner@maple.test');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.subject).toMatch(/Your week with One More Time/);
  });
});

describe('password reset', () => {
  const resetLink = () => {
    const mail = sent.filter((m) => m.subject === 'Reset your One More Time password').at(-1);
    return mail ? /https:\/\/app\.test\/app#reset=([A-Za-z0-9_-]+)/.exec(mail.body)?.[1] : undefined;
  };
  const forgot = (email: string) => app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email } });
  const reset = (token: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password } });
  const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'owner@maple.test', password } });
  const flush = () => new Promise((r) => setTimeout(r, 20)); // the email is sent without blocking the reply

  it('gives the same answer for unknown emails and sends nothing', async () => {
    await signup();
    const unknown = await forgot('nobody@x.test');
    const known = await forgot('OWNER@maple.test');
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    await flush();
    expect(sent.filter((m) => m.subject === 'Reset your One More Time password').map((m) => m.to)).toEqual(['owner@maple.test']);
  });

  it('resets the password once, logs out other sessions, and logs you in', async () => {
    const oldSession = await signup();
    await forgot('owner@maple.test');
    await flush();
    const token = resetLink()!;
    expect(token).toBeTruthy();
    // Only a hash is stored.
    const { rows } = await db.query('SELECT token_hash FROM password_resets');
    expect(rows[0].token_hash).not.toBe(token);

    expect((await reset(token, 'short')).statusCode).toBe(400);
    const ok = await reset(token, 'a-brand-new-password');
    expect(ok.statusCode).toBe(200);
    const newSession = cookieFrom(ok);
    expect((await api(newSession).get('/api/me')).statusCode).toBe(200);
    expect((await api(oldSession).get('/api/me')).statusCode).toBe(401);

    expect((await login('a-long-password')).statusCode).toBe(401);
    expect((await login('a-brand-new-password')).statusCode).toBe(200);

    const again = await reset(token, 'another-new-password');
    expect(again.statusCode).toBe(400);
    expect(again.json().error).toMatch(/expired or was already used/);
  });

  it('rejects expired links and replaces older links with the newest', async () => {
    await signup();
    await forgot('owner@maple.test');
    await flush();
    const first = resetLink()!;
    await forgot('owner@maple.test');
    await flush();
    const second = resetLink()!;
    expect(second).not.toBe(first);
    expect((await reset(first, 'a-brand-new-password')).statusCode).toBe(400);

    await db.query(`UPDATE password_resets SET expires_at = now() - interval '1 minute'`);
    expect((await reset(second, 'a-brand-new-password')).statusCode).toBe(400);
    expect((await reset('x'.repeat(43), 'a-brand-new-password')).statusCode).toBe(400);
  });

  it('sends at most 3 reset emails an hour per account', async () => {
    await signup();
    for (let i = 0; i < 5; i++) expect((await forgot('owner@maple.test')).statusCode).toBe(200);
    await flush();
    expect(sent.filter((m) => m.subject === 'Reset your One More Time password')).toHaveLength(3);
  });

  it('unlocks an account that was locked by failed logins', async () => {
    await signup();
    for (let i = 0; i < 5; i++) await login('wrong-password');
    expect((await login('a-long-password')).statusCode).toBe(429);
    await forgot('owner@maple.test');
    await flush();
    expect((await reset(resetLink()!, 'a-brand-new-password')).statusCode).toBe(200);
    expect((await login('a-brand-new-password')).statusCode).toBe(200);
  });
});
