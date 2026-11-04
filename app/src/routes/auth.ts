import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { tx } from '../db/pool.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/security.js';
import { INDUSTRIES } from '../lib/templates.js';
import { isValidTimeZone } from '../lib/dates.js';
import { publicBusiness } from '../services/businesses.js';

export const SESSION_COOKIE = 'cb_session';
const SESSION_DAYS = 30;

const signupBody = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, 'must be at least 10 characters').max(200),
  name: z.string().trim().max(100).default(''),
  businessName: z.string().trim().min(1, 'is required').max(120),
  industry: z.enum(Object.keys(INDUSTRIES) as [string, ...string[]]).default('salon'),
  timezone: z.string().refine(isValidTimeZone, 'is not a valid time zone').default('America/New_York'),
});

const loginBody = z.object({ email: z.string().trim().toLowerCase(), password: z.string() });

// Simple in-memory brute-force guard per email. Fine for a single server instance.
const failures = new Map<string, { n: number; until: number }>();

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;
  const secure = config.NODE_ENV === 'production';

  async function startSession(reply: FastifyReply, userId: string) {
    const token = randomToken();
    await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`, [sha256(token), userId, SESSION_DAYS]);
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: SESSION_DAYS * 86400 });
  }

  app.post('/signup', async (req, reply) => {
    const body = signupBody.parse(req.body);
    const exists = await db.query('SELECT 1 FROM users WHERE email = $1', [body.email]);
    if (exists.rowCount) return reply.code(409).send({ error: 'An account with that email already exists. Try logging in.' });
    const hash = await hashPassword(body.password);
    const { user, business } = await tx(db, async (c) => {
      const { rows: [user] } = await c.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id`, [body.email, hash, body.name]);
      const { rows: [business] } = await c.query(
        `INSERT INTO businesses (owner_id, name, industry, timezone, reply_to_email) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [user!.id, body.businessName, body.industry, body.timezone, body.email],
      );
      return { user: user!, business: business! };
    });
    await startSession(reply, user.id);
    return reply.code(201).send({ user: { id: user.id, email: body.email, name: body.name }, business: publicBusiness(business) });
  });

  app.post('/login', async (req, reply) => {
    const { email, password } = loginBody.parse(req.body);
    const f = failures.get(email);
    if (f && f.until > Date.now()) return reply.code(429).send({ error: 'Too many attempts. Try again in a few minutes.' });
    const { rows: [u] } = await db.query<{ id: string; password_hash: string; name: string }>('SELECT id, password_hash, name FROM users WHERE email = $1', [email]);
    if (!u || !(await verifyPassword(password, u.password_hash))) {
      const n = (f?.n ?? 0) + 1;
      failures.set(email, { n, until: n >= 5 ? Date.now() + 10 * 60_000 : 0 });
      return reply.code(401).send({ error: 'That email and password don’t match.' });
    }
    failures.delete(email);
    await startSession(reply, u.id);
    return { user: { id: u.id, email, name: u.name } };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
