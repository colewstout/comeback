import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import { normalizePhone } from '../lib/contact.js';

export function isAdmin(config: Config, email: string): boolean {
  const list = (config.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

const waitlistBody = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().max(100).default(''),
  businessName: z.string().trim().max(120).default(''),
  businessType: z.string().trim().max(60).default(''),
  phone: z.string().trim().max(40).default(''),
  message: z.string().trim().max(1000).default(''),
  website: z.string().max(200).default(''), // honeypot: real people leave this empty
});

// Per-address limit on sign-ups. In memory is fine for a single server.
const recent = new Map<string, number[]>();
const WAITLIST_PER_HOUR = 5;

export async function growthRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;

  // Public: "Become a founding member" form on the website.
  app.post('/api/waitlist', async (req, reply) => {
    const body = waitlistBody.parse(req.body);
    if (body.website) return { ok: true }; // a bot filled the hidden field; pretend it worked
    const ip = req.ip;
    const times = (recent.get(ip) ?? []).filter((t) => t > Date.now() - 3600_000);
    if (times.length >= WAITLIST_PER_HOUR) return reply.code(429).send({ error: 'Too many sign-ups from here. Please try again later.' });
    recent.set(ip, [...times, Date.now()]);
    await db.query(
      `INSERT INTO waitlist (email, name, business_name, business_type, phone, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET
         name = COALESCE(NULLIF(EXCLUDED.name, ''), waitlist.name),
         business_name = COALESCE(NULLIF(EXCLUDED.business_name, ''), waitlist.business_name),
         business_type = COALESCE(NULLIF(EXCLUDED.business_type, ''), waitlist.business_type),
         phone = COALESCE(EXCLUDED.phone, waitlist.phone),
         message = CASE WHEN EXCLUDED.message = '' THEN waitlist.message ELSE EXCLUDED.message END,
         updated_at = now()`,
      [body.email, body.name, body.businessName, body.businessType, normalizePhone(body.phone) ?? (body.phone || null), body.message],
    );
    return reply.code(201).send({ ok: true });
  });

  // Founder-only overview: sign-ups and every business on the platform.
  app.register(async (admin) => {
    admin.addHook('preHandler', app.requireAuth);
    admin.addHook('preHandler', async (req, reply) => {
      if (!isAdmin(config, req.user!.email)) return reply.code(403).send({ error: 'This page is only for the One More Time team.' });
    });
    admin.get('/api/admin/overview', async () => {
      const [{ rows: waitlist }, { rows: businesses }] = await Promise.all([
        db.query(`SELECT email, name, business_name, business_type, phone, message, created_at FROM waitlist ORDER BY created_at DESC LIMIT 500`),
        db.query(
          `SELECT b.id, b.name, b.industry, b.plan, b.plan_status, b.trial_ends_at, b.autopilot, b.created_at, u.email AS owner_email,
                  (SELECT count(*) FROM customers c WHERE c.business_id = b.id) AS customers,
                  (SELECT count(*) FROM messages m WHERE m.business_id = b.id AND m.direction = 'out' AND m.status = 'sent' AND m.created_at > now() - interval '30 days') AS messages_30d,
                  (SELECT count(*) FROM sequences s WHERE s.business_id = b.id AND s.status = 'won' AND s.ended_at > now() - interval '30 days') AS wins_30d,
                  (SELECT coalesce(sum(recovered_cents), 0) FROM sequences s WHERE s.business_id = b.id AND s.status = 'won' AND s.ended_at > now() - interval '30 days') AS recovered_30d,
                  (SELECT status FROM integrations i WHERE i.business_id = b.id AND i.provider = 'square') AS square
             FROM businesses b JOIN users u ON u.id = b.owner_id ORDER BY b.created_at DESC LIMIT 500`),
      ]);
      const mrr = businesses.filter((b) => b.plan_status === 'active').reduce((s, b) => s + (({ starter: 49, growth: 99, multi: 199 } as Record<string, number>)[b.plan] ?? 0), 0);
      return { waitlist, businesses, totals: { waitlist: waitlist.length, businesses: businesses.length, paying: businesses.filter((b) => b.plan_status === 'active').length, mrr } };
    });
  });
}
