import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { computeRhythm } from '../src/lib/rhythm.js';
import { mapCsv, matchKey, parseCsv } from '../src/lib/csv.js';
import { addDays, inSendWindow, localDate, parseLooseDate } from '../src/lib/dates.js';
import { normalizePhone } from '../src/lib/contact.js';
import { baseDiscountCode, renderMessage } from '../src/lib/templates.js';
import { hashPassword, signToken, twilioSignature, verifyPassword, verifyStripeSignature, verifyToken } from '../src/lib/security.js';
import { canSend } from '../src/lib/plans.js';
import { chooseChannel } from '../src/services/sequences.js';

const opts = { defaultIntervalDays: 42, overdueMultiplier: 1.5 };
const visitsEvery = (days: number, count: number, last: string) =>
  Array.from({ length: count }, (_, i) => ({ date: addDays(last, -days * (count - 1 - i)), amountCents: 8000 }));

describe('rhythm', () => {
  it('learns the usual gap from the median', () => {
    const v = [...visitsEvery(35, 5, '2026-09-01'), { date: '2025-01-01', amountCents: 8000 }]; // one long early gap
    const r = computeRhythm(v, '2026-09-10', opts)!;
    expect(r.intervalDays).toBe(35);
    expect(r.learned).toBe(true);
    expect(r.status).toBe('ok');
    expect(r.nextExpected).toBe('2026-10-06');
  });

  it('classifies due, overdue and lapsed by multiples of the usual gap', () => {
    const v = visitsEvery(30, 4, '2026-06-01');
    expect(computeRhythm(v, addDays('2026-06-01', 31), opts)!.status).toBe('due');
    expect(computeRhythm(v, addDays('2026-06-01', 45), opts)!.status).toBe('overdue');
    expect(computeRhythm(v, addDays('2026-06-01', 90), opts)!.status).toBe('lapsed');
  });

  it('uses the industry default for single-visit customers', () => {
    const r = computeRhythm([{ date: '2026-08-01', amountCents: 5000 }], '2026-10-01', opts)!;
    expect(r.learned).toBe(false);
    expect(r.intervalDays).toBe(42);
    expect(r.status).toBe('due'); // 61 days / 42 = 1.45
  });

  it('treats same-day visits as one date but counts spend', () => {
    const r = computeRhythm([{ date: '2026-08-01', amountCents: 5000 }, { date: '2026-08-01', amountCents: 3000 }, { date: '2026-08-29', amountCents: 4000 }], '2026-09-01', opts)!;
    expect(r.intervalDays).toBe(28);
    expect(r.avgCents).toBe(4000);
  });

  it('ignores future-dated rows', () => {
    expect(computeRhythm([{ date: '2027-01-01', amountCents: 1 }], '2026-10-01', opts)).toBeNull();
  });
});

describe('csv', () => {
  it('parses quotes, commas and CRLF', () => {
    expect(parseCsv('a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
  });

  it('maps common export headers', () => {
    const m = mapCsv('Customer Name,Phone,Email,Visit Date,Total,SMS Opt-In\nDana Reyes,(555) 201-3344,DANA@x.com,3/14/2026,$92.50,yes\nBad,,,,\n');
    expect(m.columns).toMatchObject({ name: 'Customer Name', phone: 'Phone', email: 'Email', date: 'Visit Date', amount: 'Total', consent: 'SMS Opt-In' });
    expect(m.rows[0]).toMatchObject({ name: 'Dana Reyes', phone: '+15552013344', email: 'dana@x.com', date: '2026-03-14', amountCents: 9250, smsConsent: true });
    expect(m.skipped).toHaveLength(1);
  });

  it('joins first and last name columns', () => {
    const m = mapCsv('First Name,Last Name,Date\nAva,Mitchell,2026-01-02\n');
    expect(m.rows[0]!.name).toBe('Ava Mitchell');
  });

  it('rejects files without a date column', () => {
    expect(() => mapCsv('name,amount\nA,1\n')).toThrow(/date column/);
  });

  it('groups by phone, then email, then name', () => {
    expect(matchKey({ name: 'A', phone: '+15550001111', email: 'a@x.com' })).toBe('p:+15550001111');
    expect(matchKey({ name: 'A', phone: null, email: 'a@x.com' })).toBe('e:a@x.com');
    expect(matchKey({ name: ' Ann  Lee ', phone: null, email: null })).toBe('n:ann lee');
  });
});

describe('dates and contacts', () => {
  it('parses loose dates', () => {
    expect(parseLooseDate('2026-03-04T10:00:00Z')).toBe('2026-03-04');
    expect(parseLooseDate('3/4/26')).toBe('2026-03-04');
    expect(parseLooseDate('02/30/2026')).toBeNull();
    expect(parseLooseDate('nope')).toBeNull();
  });
  it('uses the business time zone', () => {
    const t = new Date('2026-11-05T05:30:00Z');
    expect(localDate(t, 'America/Los_Angeles')).toBe('2026-11-04');
    expect(inSendWindow(t, 'America/Los_Angeles', 9, 20)).toBe(false);
    expect(inSendWindow(new Date('2026-11-04T18:00:00Z'), 'America/Los_Angeles', 9, 20)).toBe(true);
  });
  it('normalizes phone numbers', () => {
    expect(normalizePhone('555.201.3344')).toBe('+15552013344');
    expect(normalizePhone('1 (555) 201-3344')).toBe('+15552013344');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12345')).toBeNull();
  });
});

describe('messages', () => {
  const base = { channel: 'sms' as const, businessName: 'Maple & Main', industryKey: 'salon', customerName: 'Dana Reyes', daysSince: 70, learned: true, discountPct: 15, code: 'DANA15', expires: '2026-12-02' };
  it('has no discount in the first message and always includes opt-out for texts', () => {
    const m0 = renderMessage({ ...base, step: 0 });
    expect(m0.body).not.toMatch(/%/);
    expect(m0.body).toMatch(/about 2 months since your last appointment/);
    expect(m0.body).toMatch(/Reply STOP to opt out\.$/);
    expect(renderMessage({ ...base, step: 1 }).body).toMatch(/15% off .* Dec 2\. Use code DANA15/);
    expect(renderMessage({ ...base, step: 2 }).body).toMatch(/Last reminder, Dana/);
  });
  it('adds an unsubscribe link and address to emails', () => {
    const m = renderMessage({ ...base, step: 1, channel: 'email', unsubscribeUrl: 'https://x/u/abc', postalAddress: '1 Main St' });
    expect(m.body).toMatch(/1 Main St/);
    expect(m.body).toMatch(/Unsubscribe: https:\/\/x\/u\/abc/);
    expect(m.body).not.toMatch(/STOP/);
  });
  it('builds discount codes', () => {
    expect(baseDiscountCode('José García', 15)).toBe('JOSE15');
    expect(baseDiscountCode('dana@x.com', 10)).toBe('WELCOME10');
  });
  it('picks text only with consent and no opt-out', () => {
    const c = { phone: '+15550001111', email: 'a@x.com', sms_consent: true, sms_opted_out: false, email_opted_out: false };
    expect(chooseChannel(c, true)).toBe('sms');
    expect(chooseChannel({ ...c, sms_consent: false }, true)).toBe('email');
    expect(chooseChannel(c, false)).toBe('email');
    expect(chooseChannel({ ...c, sms_opted_out: true, email_opted_out: true }, true)).toBeNull();
  });
});

describe('security', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('signs tokens', () => {
    const t = signToken('unsub:123', 's');
    expect(verifyToken(t, 's')).toBe('unsub:123');
    expect(verifyToken(t, 'other')).toBeNull();
    expect(verifyToken(t.slice(0, -1) + 'x', 's')).toBeNull();
  });
  it('verifies Stripe signatures with a time tolerance', () => {
    const payload = '{"id":"evt_1"}';
    const t = 1_800_000_000;
    const sig = createHmac('sha256', 'whsec').update(`${t}.${payload}`).digest('hex');
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec', 300, t + 10)).toBe(true);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, 'whsec', 300, t + 1000)).toBe(false);
    expect(verifyStripeSignature(payload + ' ', `t=${t},v1=${sig}`, 'whsec', 300, t)).toBe(false);
  });
  it("matches Twilio's documented signature example", () => {
    // Example from https://www.twilio.com/docs/usage/security
    const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', {
      CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212',
    });
    expect(sig).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
  it('blocks sending after a trial ends or a subscription is canceled', () => {
    const now = new Date('2026-11-04');
    expect(canSend({ plan: 'trial', plan_status: 'trialing', trial_ends_at: '2026-12-01' }, now)).toBe(true);
    expect(canSend({ plan: 'trial', plan_status: 'trialing', trial_ends_at: '2026-11-01' }, now)).toBe(false);
    expect(canSend({ plan: 'growth', plan_status: 'canceled', trial_ends_at: '2026-12-01' }, now)).toBe(false);
  });
});
