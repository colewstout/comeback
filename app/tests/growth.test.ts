import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPool, type Db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { addDays } from '../src/lib/dates.js';
import { twilioSignature } from '../src/lib/security.js';
import { renderMessage, templateProblems } from '../src/lib/templates.js';
import type { Providers } from '../src/providers/index.js';
import { runTick } from '../src/services/sequences.js';
import { runAudit } from '../src/services/audit.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://comeback:comeback@localhost:5432/comeback_test';
const config = loadConfig({
  NODE_ENV: 'test', DATABASE_URL: DB_URL, APP_URL: 'https://app.test', SESSION_SECRET: 'test-secret-test-secret-test-secret',
  TWILIO_AUTH_TOKEN: 'twilio-token', ADMIN_EMAILS: 'founder@onemoretime.test, other@x.test',
});

const sent: { channel: string; to: string; body: string; subject?: string }[] = [];
const providers: Providers = {
  sms: { name: 'fake', async send({ to, body }) { sent.push({ channel: 'sms', to, body }); return { providerId: 's' }; } },
  email: { name: 'fake', async send({ to, text, subject }) { sent.push({ channel: 'email', to, body: text, subject }); return { providerId: 'e' }; } },
};

const START = new Date('2026-11-04T17:00:00Z'); // noon in New York
const TODAY = '2026-11-04';
const d = (n: number) => addDays(TODAY, -n);
const clock = { now: START };
let db: Db;
let app: FastifyInstance;
const deps = () => ({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET });
const flush = () => new Promise((r) => setTimeout(r, 20));

async function signup(email = 'owner@maple.test') {
  const res = await app.inject({ method: 'POST', url: '/api/auth/signup', payload: { email, password: 'a-long-password', businessName: 'Maple & Main', industry: 'salon', timezone: 'America/New_York' } });
  expect(res.statusCode).toBe(201);
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw[0]! : String(raw)).split(';')[0]!;
}
const api = (cookie: string) => ({
  get: (url: string) => app.inject({ method: 'GET', url, headers: { cookie } }),
  post: (url: string, payload: object = {}) => app.inject({ method: 'POST', url, headers: { cookie }, payload }),
  patch: (url: string, payload: object) => app.inject({ method: 'PATCH', url, headers: { cookie }, payload }),
});

const CSV = [
  'name,phone,email,date,amount,text ok',
  // New client, one visit 35 days ago: due a second-visit offer (salon gap is 42 days).
  `Nora New,555-201-1111,nora@x.test,${d(35)},80,yes`,
  // New client, one visit 10 days ago: too early.
  `Fresh Face,,fresh@x.test,${d(10)},70,`,
  // One visit 200 days ago: too late for a thank-you; the regular win-back handles her.
  `Priya Shah,,priya@x.test,${d(200)},120,`,
  // Regular, overdue.
  ...[80, 115, 150].map((n) => `Dana Reyes,555-201-3344,dana@x.test,${d(n)},92,yes`),
].join('\n');

beforeAll(async () => {
  db = createPool(DB_URL);
  app = await buildApp({ config, db, providers, now: () => clock.now });
});
afterAll(async () => { await app.close(); await db.end(); });
beforeEach(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  sent.length = 0;
  clock.now = START;
});

describe('second-visit offers', () => {
  it('thanks first-time customers with an offer before they drift away', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    await api(c).patch('/api/business', { autopilot: true });

    const t = await runTick(deps(), START);
    expect(t.started).toBe(3); // Nora (second visit), Priya and Dana (win-back)
    const { rows } = await db.query(`SELECT c.name, s.kind, s.discount_code, s.discount_pct FROM sequences s JOIN customers c ON c.id = s.customer_id ORDER BY c.name`);
    expect(rows).toEqual([
      { name: 'Dana Reyes', kind: 'winback', discount_code: 'DANA15', discount_pct: 15 },
      { name: 'Nora New', kind: 'second_visit', discount_code: 'NORA10', discount_pct: 10 },
      { name: 'Priya Shah', kind: 'winback', discount_code: 'PRIYA15', discount_pct: 15 },
    ]);
    const nora = sent.find((m) => m.to === '+15552011111')!;
    expect(nora.body).toMatch(/^Hi Nora, thanks again for choosing Maple & Main! .*10% off your next appointment before Nov 25\. Use code NORA10\..* Reply STOP to opt out\.$/);

    // Reminder on day 10, then done.
    await runTick(deps(), new Date(START.getTime() + 10 * 864e5));
    const reminders = sent.filter((m) => m.to === '+15552011111');
    expect(reminders).toHaveLength(2);
    expect(reminders[1]!.body).toMatch(/your 10% off code NORA10 for Maple & Main expires Nov 25/);
    const { rows: [s] } = await db.query(`SELECT status, steps_sent FROM sequences WHERE kind = 'second_visit'`);
    expect(s).toEqual({ status: 'completed', steps_sent: 2 });
  });

  it('can be switched off, and validates the discount', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    expect((await api(c).patch('/api/business', { second_visit_discount_pct: 80 })).statusCode).toBe(400);
    await api(c).patch('/api/business', { autopilot: true, second_visit_enabled: false });
    await runTick(deps(), START);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM sequences WHERE kind = 'second_visit'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('owner message wording', () => {
  it('checks wording for unknown words, a missing code, and opt-out text', () => {
    expect(templateProblems('Hi {first_name}! Code {code}', { needsCode: true })).toEqual([]);
    expect(templateProblems('Hi {name}', { needsCode: false })[0]).toMatch(/\{name\} isn't a word we can fill in/);
    expect(templateProblems('Come back soon', { needsCode: true })[0]).toMatch(/Include \{code\}/);
    expect(templateProblems('Hi! Reply STOP to quit', { needsCode: false })[0]).toMatch(/Leave out opt-out wording/);
    expect(templateProblems('x'.repeat(500), { needsCode: false })[0]).toMatch(/under 480/);
  });

  it('uses the owner’s wording but always adds the opt-out', () => {
    const m = renderMessage({
      step: 1, kind: 'winback', channel: 'sms', templates: { winback: [null, 'Hey {first_name}! {discount} off at {business} with {code} until {expires}.', null] },
      businessName: 'Maple & Main', industryKey: 'salon', customerName: 'Dana Reyes', daysSince: 70, learned: true, discountPct: 15, code: 'DANA15', expires: '2026-12-02',
    });
    expect(m.body).toBe('Hey Dana! 15% off at Maple & Main with DANA15 until Dec 2. Reply STOP to opt out.');
  });

  it('saves, previews and sends custom wording', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });

    const bad = await api(c).patch('/api/business', { message_templates: { winback: ['Hi {nickname}', null, null] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/Win-back message 1: \{nickname\}/);
    expect((await api(c).patch('/api/business', { message_templates: { winback: [null, 'Come back soon!', null] } })).json().error).toMatch(/Include \{code\}/);

    const preview = (await api(c).post('/api/templates/preview', { kind: 'winback', step: 0, text: 'Hi {first_name}, {business} misses you! It has been {since}.' })).json();
    expect(preview.body).toBe('Hi Dana, Maple & Main misses you! It has been about 7 weeks. Reply STOP to opt out.');
    expect(preview.problems).toEqual([]);

    const ok = await api(c).patch('/api/business', { message_templates: { winback: ['Hi {first_name}, {business} misses you! It has been {since}.', null, null] } });
    expect(ok.statusCode).toBe(200);
    // Saving second-visit wording later keeps the win-back wording.
    await api(c).patch('/api/business', { message_templates: { second_visit: ['Thanks {first_name}! {discount} off with {code} before {expires}.', null] } });
    const me = (await api(c).get('/api/me')).json();
    expect(me.business.message_templates.winback[0]).toMatch(/misses you/);
    expect(me.templates.defaults.winback).toHaveLength(3);

    const dana = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Dana Reyes');
    await api(c).post(`/api/customers/${dana.id}/winback`);
    expect(sent.at(-1)!.body).toBe('Hi Dana, Maple & Main misses you! It has been about 3 months. Reply STOP to opt out.');
  });
});

describe('reply alerts', () => {
  it('pauses the win-back and emails the owner when a customer replies', async () => {
    const c = await signup();
    await api(c).post('/api/imports', { csv: CSV });
    const dana = (await api(c).get('/api/customers')).json().customers.find((x: any) => x.name === 'Dana Reyes');
    await api(c).post(`/api/customers/${dana.id}/winback`);

    const params = { From: '+15552013344', To: '+15550000000', Body: 'Yes! Can I come Thursday at 3?', MessageSid: 'SM9' };
    const sig = twilioSignature('twilio-token', 'https://app.test/webhooks/twilio/sms', params);
    const res = await app.inject({ method: 'POST', url: '/webhooks/twilio/sms', payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
    expect(res.statusCode).toBe(200);
    await flush();

    const detail = (await api(c).get(`/api/customers/${dana.id}`)).json();
    expect(detail.sequences[0]).toMatchObject({ status: 'stopped', stop_reason: 'replied' });
    expect(detail.customer.sms_opted_out).toBe(false);
    const alert = sent.find((m) => m.subject === 'Dana Reyes replied to your text')!;
    expect(alert.to).toBe('owner@maple.test');
    expect(alert.body).toMatch(/"Yes! Can I come Thursday at 3\?"/);
    expect(alert.body).toMatch(/https:\/\/app\.test\/app#messages/);
  });
});

describe('waitlist and admin', () => {
  const join = (payload: object, ip = '10.0.0.1') => app.inject({ method: 'POST', url: '/api/waitlist', payload, remoteAddress: ip });

  it('saves sign-ups, merges repeats, and ignores bots', async () => {
    expect((await join({ email: 'Kim@Kibble.test', name: 'Kim', businessName: 'Kibble', businessType: 'Dog groomer', phone: '469-687-0770' })).statusCode).toBe(201);
    expect((await join({ email: 'kim@kibble.test', message: 'Call me after 3' })).statusCode).toBe(201);
    expect((await join({ email: 'bot@spam.test', website: 'http://spam' })).statusCode).toBe(200);
    expect((await join({ email: 'not-an-email' })).statusCode).toBe(400);
    const { rows } = await db.query(`SELECT email, name, business_name, phone, message FROM waitlist`);
    expect(rows).toEqual([{ email: 'kim@kibble.test', name: 'Kim', business_name: 'Kibble', phone: '+14696870770', message: 'Call me after 3' }]);
  });

  it('limits sign-ups per address', async () => {
    for (let i = 0; i < 5; i++) expect((await join({ email: `p${i}@x.test` }, '10.0.0.9')).statusCode).toBe(201);
    expect((await join({ email: 'p6@x.test' }, '10.0.0.9')).statusCode).toBe(429);
  });

  it('shows the overview only to admins', async () => {
    await join({ email: 'lead@x.test', businessName: 'Sudsy Paws' }, '10.0.0.2');
    const owner = await signup();
    expect((await api(owner).get('/api/admin/overview')).statusCode).toBe(403);
    expect((await api(owner).get('/api/me')).json().isAdmin).toBe(false);
    const founder = await signup('Founder@onemoretime.test');
    expect((await api(founder).get('/api/me')).json().isAdmin).toBe(true);
    const o = (await api(founder).get('/api/admin/overview')).json();
    expect(o.totals).toMatchObject({ waitlist: 1, businesses: 2, paying: 0, mrr: 0 });
    expect(o.waitlist[0].business_name).toBe('Sudsy Paws');
    expect((await app.inject({ method: 'GET', url: '/api/admin/overview' })).statusCode).toBe(401);
  });
});

describe('lost-customer audit', () => {
  it('summarizes overdue customers and first-timer return rate without full names', () => {
    const r = runAudit({ csv: CSV, industryKey: 'salon', today: TODAY });
    expect(r).toMatchObject({ customers: 4, visits: 6, byStatus: { ok: 2, due: 0, overdue: 1, lapsed: 1 } });
    // First-timers: anyone whose first visit was 42+ days ago. Dana returned; Priya didn't.
    expect(r.firstTimers).toEqual({ total: 2, cameBack: 1, rate: 0.5 });
    expect(r.topOverdue.map((o) => o.name).sort()).toEqual(['Dana R.', 'Priya S.']);
    expect(r.slippingMonthlyCents).toBeGreaterThan(0);
    expect(r.recover10MonthlyCents).toBe(Math.round(r.slippingMonthlyCents * 0.1));
    expect(r.reachable).toEqual({ phone: 2, email: 2, none: 0 });
  });

  it('runs from the dashboard and saves nothing', async () => {
    const c = await signup();
    const res = await api(c).post('/api/audit', { csv: CSV, industry: 'salon', businessName: 'Kibble Pet Grooming' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ businessName: 'Kibble Pet Grooming', industryLabel: 'Hair salon or barber', customers: 4 });
    expect((await api(c).get('/api/customers')).json().total).toBe(0);
    expect((await app.inject({ method: 'POST', url: '/api/audit', payload: { csv: CSV } })).statusCode).toBe(401);
  });
});
