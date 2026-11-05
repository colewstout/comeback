import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidTimeZone, localDate, addDays } from '../lib/dates.js';
import { normalizeEmail, normalizePhone } from '../lib/contact.js';
import { INDUSTRIES, renderMessage, STEP_NAMES, STEP_OFFSETS_DAYS, CODE_VALID_DAYS, baseDiscountCode, PLACEHOLDERS, SEQUENCE_KINDS, templateProblems, type SequenceKind } from '../lib/templates.js';
import { runAudit } from '../services/audit.js';
import { isAdmin } from './growth.js';
import { PLANS, planLimits } from '../lib/plans.js';
import { getBusiness, publicBusiness, type Business } from '../services/businesses.js';
import { loadCustomerStates } from '../services/customers.js';
import { importCsv } from '../services/imports.js';
import { chooseChannel, sendDueSteps, smsAllowedFor, startSequence, stopSequences } from '../services/sequences.js';
import { dashboard, weeklyReport } from '../services/reports.js';
import { createCheckout, createPortal } from '../services/billing.js';

const businessPatch = z.object({
  name: z.string().trim().min(1).max(120),
  industry: z.enum(Object.keys(INDUSTRIES) as [string, ...string[]]),
  discount_pct: z.number().int().min(0).max(50),
  overdue_multiplier: z.number().min(1).max(5),
  timezone: z.string().refine(isValidTimeZone, 'is not a valid time zone'),
  send_window_start: z.number().int().min(0).max(23),
  send_window_end: z.number().int().min(1).max(24),
  autopilot: z.boolean(),
  booking_url: z.string().trim().url().max(300).nullable().or(z.literal('').transform(() => null)),
  reply_to_email: z.string().trim().email().nullable().or(z.literal('').transform(() => null)),
  postal_address: z.string().trim().max(300).nullable(),
  second_visit_enabled: z.boolean(),
  second_visit_discount_pct: z.number().int().min(0).max(50),
  message_templates: z.object({
    winback: z.array(z.string().max(1000).nullable()).length(3),
    second_visit: z.array(z.string().max(1000).nullable()).length(2),
  }).partial(),
}).partial().refine((p) => p.send_window_start === undefined || p.send_window_end === undefined || p.send_window_start < p.send_window_end, {
  message: 'Sending hours must start before they end.', path: ['send_window_end'],
});

const COLUMNS = ['name', 'industry', 'discount_pct', 'overdue_multiplier', 'timezone', 'send_window_start', 'send_window_end', 'autopilot', 'booking_url', 'reply_to_email', 'postal_address', 'second_visit_enabled', 'second_visit_discount_pct', 'message_templates'] as const;

/** Which steps carry the discount code, so the owner's wording must include {code}. */
const CODE_STEPS: Record<SequenceKind, number[]> = { winback: [1, 2], second_visit: [0, 1] };

/** Starting wording owners can edit, written with placeholders. */
export const TEMPLATE_DEFAULTS: Record<SequenceKind, string[]> = {
  winback: [
    "Hi {first_name}, it's {business}. It's been {since} since your last visit. Want us to save you a spot this week? {booking}",
    "Hi {first_name}, we'd love to see you again! Here's {discount} off your next visit before {expires}. Use code {code}. {booking}",
    "Last reminder, {first_name}: your {discount} off code {code} expires {expires}. After this we'll stop the reminders. Hope to see you soon! – {business}",
  ],
  second_visit: [
    "Hi {first_name}, thanks again for choosing {business}! We'd love to see you again: here's {discount} off your next visit before {expires}. Use code {code}. {booking}",
    "Quick reminder, {first_name}: your {discount} off code {code} for {business} expires {expires}. {booking}",
  ],
};

function checkTemplates(t: Record<string, (string | null)[] | undefined>, pct: { winback: number; second_visit: number }): string | null {
  for (const kind of ['winback', 'second_visit'] as SequenceKind[]) {
    const steps = t[kind];
    if (!steps) continue;
    for (const [i, text] of steps.entries()) {
      if (text == null || text === '') continue;
      const p = templateProblems(text, { needsCode: pct[kind] > 0 && CODE_STEPS[kind].includes(i) });
      if (p.length) return `${kind === 'winback' ? 'Win-back' : 'Second-visit'} message ${i + 1}: ${p[0]}`;
    }
  }
  return null;
}

const customerPatch = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  sms_consent: z.boolean(),
}).partial();

export async function apiRoutes(app: FastifyInstance) {
  const { db, config, providers } = app.deps;
  const now = () => app.deps.now();
  app.addHook('preHandler', app.requireAuth);

  app.get('/me', async (req) => ({
    user: req.user,
    business: publicBusiness(req.business!),
    plan: planLimits(req.business!.plan),
    plans: PLANS,
    industries: Object.fromEntries(Object.entries(INDUSTRIES).map(([k, v]) => [k, v.label])),
    capabilities: { sms: smsAllowedFor(req.business!, providers), email: providers.email !== null, billing: Boolean(config.STRIPE_SECRET_KEY), square: app.square !== null },
    isAdmin: isAdmin(config, req.user!.email),
    templates: { defaults: TEMPLATE_DEFAULTS, placeholders: PLACEHOLDERS, steps: Object.fromEntries(Object.entries(SEQUENCE_KINDS).map(([k, v]) => [k, v.names.map((n, i) => ({ name: n, day: v.offsets[i] }))])) },
  }));

  app.patch('/business', async (req) => {
    const patch = businessPatch.parse(req.body);
    const b = req.business!;
    const merged = { ...b, ...patch };
    if (merged.send_window_start >= merged.send_window_end) {
      throw Object.assign(new Error('Sending hours must start before they end.'), { statusCode: 400 });
    }
    if (patch.message_templates) {
      const problem = checkTemplates(patch.message_templates, { winback: merged.discount_pct, second_visit: merged.second_visit_discount_pct });
      if (problem) throw Object.assign(new Error(problem), { statusCode: 400 });
      patch.message_templates = { ...(b.message_templates ?? {}), ...patch.message_templates } as typeof patch.message_templates;
    }
    const keys = COLUMNS.filter((k) => k in patch);
    if (keys.length) {
      await db.query(
        `UPDATE businesses SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [b.id, ...keys.map((k) => (patch as Record<string, unknown>)[k])],
      );
    }
    return { business: publicBusiness((await getBusiness(db, b.id))!) };
  });

  app.get('/dashboard', async (req) => {
    const b = req.business!;
    const states = await loadCustomerStates(db, b, now());
    return { dashboard: await dashboard(db, b, now(), states) };
  });

  app.get('/report/weekly', async (req) => weeklyReport(db, req.business!, now(), config.APP_URL));

  // ---- imports
  app.post('/imports', async (req, reply) => {
    const body = z.object({ filename: z.string().max(200).default('upload.csv'), csv: z.string().min(1), smsConsentAll: z.boolean().default(false) }).parse(req.body);
    const result = await importCsv(db, req.business!, body);
    return reply.code(201).send(result);
  });

  app.get('/imports', async (req) => {
    const { rows } = await db.query('SELECT * FROM imports WHERE business_id = $1 ORDER BY created_at DESC LIMIT 20', [req.business!.id]);
    return { imports: rows };
  });

  // ---- customers
  app.get('/customers', async (req) => {
    const q = z.object({ status: z.enum(['all', 'attention', 'due', 'overdue', 'lapsed', 'in_progress', 'won', 'ok']).default('all') }).parse(req.query);
    const b = req.business!;
    const smsOk = smsAllowedFor(b, providers);
    const states = await loadCustomerStates(db, b, now());
    const order = { lapsed: 1, overdue: 0, due: 2, in_progress: 3, won: 4, ok: 5 } as const;
    const list = states
      .filter((c) => q.status === 'all' || c.display === q.status || (q.status === 'attention' && ['due', 'overdue', 'lapsed'].includes(c.display)))
      .sort((a, b2) => order[a.display] - order[b2.display] || (b2.rhythm?.monthlyValueCents ?? 0) * (b2.rhythm?.ratio ?? 0) - (a.rhythm?.monthlyValueCents ?? 0) * (a.rhythm?.ratio ?? 0))
      .map((c) => ({ ...c, channel: chooseChannel(c, smsOk) }));
    const counts = states.reduce<Record<string, number>>((acc, c) => ((acc[c.display] = (acc[c.display] ?? 0) + 1), acc), {});
    return { customers: list, counts, total: states.length, today: localDate(now(), b.timezone) };
  });

  app.get('/customers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = req.business!;
    const [c] = await loadCustomerStates(db, b, now(), id);
    if (!c) return reply.code(404).send({ error: 'Customer not found.' });
    const [{ rows: visits }, { rows: sequences }, { rows: messages }] = await Promise.all([
      db.query('SELECT id, visited_at, amount_cents, source FROM visits WHERE customer_id = $1 ORDER BY visited_at DESC LIMIT 100', [id]),
      db.query('SELECT * FROM sequences WHERE customer_id = $1 ORDER BY started_at DESC', [id]),
      db.query('SELECT id, sequence_id, step, direction, channel, to_address, subject, body, status, error, created_at FROM messages WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    ]);
    const channel = chooseChannel(c, smsAllowedFor(b, providers));
    // Preview of what the win-back would say if started today.
    const today = localDate(now(), b.timezone);
    const preview = channel
      ? STEP_OFFSETS_DAYS.map((offset, step) => ({
          step, name: STEP_NAMES[step], day: offset,
          ...renderMessage({
            step, channel, templates: b.message_templates, businessName: b.name, industryKey: b.industry, customerName: c.name,
            daysSince: (c.rhythm?.daysSince ?? 0) + offset, learned: c.rhythm?.learned ?? false, discountPct: b.discount_pct,
            code: baseDiscountCode(c.name, b.discount_pct), expires: addDays(today, CODE_VALID_DAYS),
            bookingUrl: b.booking_url, postalAddress: b.postal_address, unsubscribeUrl: `${config.APP_URL}/u/…`,
          }),
        }))
      : [];
    return { customer: { ...c, channel }, visits, sequences, messages, preview };
  });

  app.patch('/customers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const p = customerPatch.parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [id, req.business!.id];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (p.name !== undefined) add('name', p.name);
    if (p.phone !== undefined) {
      const phone = p.phone ? normalizePhone(p.phone) : null;
      if (p.phone && !phone) return reply.code(400).send({ error: 'That phone number doesn’t look right. Include the area code.' });
      add('phone', phone);
    }
    if (p.email !== undefined) {
      const email = p.email ? normalizeEmail(p.email) : null;
      if (p.email && !email) return reply.code(400).send({ error: 'That email address doesn’t look right.' });
      add('email', email);
    }
    if (p.sms_consent !== undefined) add('sms_consent', p.sms_consent);
    if (!sets.length) return { ok: true };
    const { rowCount } = await db.query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $1 AND business_id = $2`, vals);
    if (!rowCount) return reply.code(404).send({ error: 'Customer not found.' });
    return { ok: true };
  });

  app.post('/customers/:id/winback', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = req.business!;
    const [c] = await loadCustomerStates(db, b, now(), id);
    if (!c) return reply.code(404).send({ error: 'Customer not found.' });
    if (!chooseChannel(c, smsAllowedFor(b, providers))) {
      return reply.code(400).send({ error: 'We can’t reach this customer. Add an email, or a phone number with text consent.' });
    }
    const seq = await startSequence(db, b, c, now());
    if (!seq) return reply.code(409).send({ error: 'A win-back is already running for this customer.' });
    const owner = { ...b, owner_email: req.user!.email } as Business & { owner_email: string };
    const sent = await sendDueSteps({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET }, owner, now());
    return reply.code(201).send({
      sequence: seq,
      firstMessage: sent.outsideWindow ? 'scheduled' : sent.sent ? 'sent' : sent.failed ? 'failed' : 'scheduled',
    });
  });

  app.post('/customers/:id/stop', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query(
      `UPDATE sequences SET status = 'stopped', stop_reason = 'owner', ended_at = $3, next_step_at = NULL
        WHERE customer_id = $1 AND business_id = $2 AND status = 'active'`,
      [id, req.business!.id, now()],
    );
    return { ok: true };
  });

  // Preview an owner's wording with a sample customer, before saving.
  app.post('/templates/preview', async (req) => {
    const body = z.object({ kind: z.enum(['winback', 'second_visit']), step: z.number().int().min(0).max(2), text: z.string().max(1000), channel: z.enum(['sms', 'email']).default('sms') }).parse(req.body);
    const b = req.business!;
    const pct = body.kind === 'second_visit' ? b.second_visit_discount_pct : b.discount_pct;
    const plan = SEQUENCE_KINDS[body.kind];
    if (body.step >= plan.offsets.length) throw Object.assign(new Error('That step doesn’t exist.'), { statusCode: 400 });
    const problems = body.text.trim() ? templateProblems(body.text, { needsCode: pct > 0 && CODE_STEPS[body.kind].includes(body.step) }) : [];
    const today = localDate(now(), b.timezone);
    const msg = renderMessage({
      kind: body.kind, step: body.step, channel: body.channel, templates: { [body.kind]: Object.assign([], { [body.step]: body.text }) },
      businessName: b.name, industryKey: b.industry, customerName: 'Dana Reyes', daysSince: 49, learned: body.kind === 'winback',
      discountPct: pct, code: baseDiscountCode('Dana', pct), expires: addDays(today, plan.codeValidDays),
      bookingUrl: b.booking_url, postalAddress: b.postal_address, unsubscribeUrl: `${config.APP_URL}/u/…`,
    });
    return { ...msg, problems };
  });

  // Lost-customer audit for a prospect's sales export. Nothing is saved.
  app.post('/audit', async (req) => {
    const body = z.object({ csv: z.string().min(1), industry: z.enum(Object.keys(INDUSTRIES) as [string, ...string[]]).default('salon'), businessName: z.string().trim().max(120).default('') }).parse(req.body);
    const result = runAudit({ csv: body.csv, industryKey: body.industry, today: localDate(now(), req.business!.timezone) });
    return { businessName: body.businessName, industry: body.industry, industryLabel: INDUSTRIES[body.industry]!.label, preparedBy: req.user!.name || req.user!.email, generatedAt: now(), ...result };
  });

  app.get('/messages', async (req) => {
    const { rows } = await db.query(
      `SELECT m.id, m.step, m.direction, m.channel, m.to_address, m.subject, m.body, m.status, m.error, m.created_at, c.name AS customer_name, c.id AS customer_id
         FROM messages m LEFT JOIN customers c ON c.id = m.customer_id
        WHERE m.business_id = $1 ORDER BY m.created_at DESC LIMIT 100`,
      [req.business!.id],
    );
    return { messages: rows };
  });

  // ---- billing
  app.post('/billing/checkout', async (req) => {
    const { plan } = z.object({ plan: z.enum(['starter', 'growth', 'multi']) }).parse(req.body);
    return { url: await createCheckout(config, req.business!, req.user!.email, plan) };
  });
  app.post('/billing/portal', async (req) => ({ url: await createPortal(config, req.business!) }));

  // Stop-sequences helper used by the UI when a customer asks not to be contacted.
  app.post('/customers/:id/opt-out', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db.query(`UPDATE customers SET sms_opted_out_at = $3, email_opted_out_at = $3 WHERE id = $1 AND business_id = $2`, [id, req.business!.id, now()]);
    await stopSequences(db, id, 'opted_out', now());
    return { ok: true };
  });
}
