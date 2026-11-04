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
const forgotBody = z.object({ email: z.string().trim().toLowerCase().max(200) });
const resetBody = z.object({ token: z.string().min(20).max(200), password: z.string().min(10, 'must be at least 10 characters').max(200) });

export const RESET_TTL_MINUTES = 60;
/** At most this many reset emails per account per hour, so nobody can flood an inbox. */
export const RESET_MAX_PER_HOUR = 3;
const FORGOT_REPLY = { ok: true, message: 'If there’s an account with that email, we’ve sent a link to reset the password. It works for one hour.' };

// Simple in-memory brute-force guard per email. Fine for a single server instance.
const failures = new Map<string, { n: number; until: number }>();

export async function authRoutes(app: FastifyInstance) {
  const { db, config, providers } = app.deps;
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

  // Same reply whether or not the account exists, so this can't be used to find out who has one.
  app.post('/forgot', async (req) => {
    const { email } = forgotBody.parse(req.body);
    const { rows: [u] } = await db.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE email = $1', [email]);
    if (!u) return FORGOT_REPLY;

    const { rows: [recent] } = await db.query<{ n: number }>(
      `SELECT count(*) AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id]);
    if (recent!.n >= RESET_MAX_PER_HOUR) return FORGOT_REPLY;

    const token = randomToken();
    // A new link replaces any earlier unused ones.
    await db.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
    await db.query(
      `INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`,
      [sha256(token), u.id, RESET_TTL_MINUTES],
    );
    // The token goes after # so it never reaches server logs or other sites' Referer headers.
    const link = `${config.APP_URL.replace(/\/$/, '')}/app#reset=${token}`;
    if (!providers.email) {
      req.log.warn('password reset requested but email is not configured (set RESEND_API_KEY and EMAIL_FROM)');
      return FORGOT_REPLY;
    }
    // Don't wait for the email: a slower reply would reveal that the account exists.
    void providers.email.send({
      to: email, fromName: 'Comeback', subject: 'Reset your Comeback password',
      text: [
        `Hi${u.name ? ` ${u.name.split(' ')[0]}` : ''},`, '',
        'Someone (hopefully you) asked to reset the password for your Comeback account. Use this link to choose a new one:', '',
        link, '',
        `The link works once and expires in ${RESET_TTL_MINUTES} minutes. If you didn't ask for this, you can ignore this email; your password won't change.`,
      ].join('\n'),
    }).catch((err) => req.log.error({ err: (err as Error).message }, 'password reset email failed'));
    return FORGOT_REPLY;
  });

  app.post('/reset', async (req, reply) => {
    const { token, password } = resetBody.parse(req.body);
    const hash = await hashPassword(password);
    const user = await tx(db, async (c) => {
      // Lock the row so the same link can't be used twice at once.
      const { rows: [r] } = await c.query<{ user_id: string; email: string; name: string; expired: boolean; used: boolean }>(
        `SELECT pr.user_id, u.email, u.name, pr.expires_at < now() AS expired, pr.used_at IS NOT NULL AS used
           FROM password_resets pr JOIN users u ON u.id = pr.user_id WHERE pr.token_hash = $1 FOR UPDATE OF pr`,
        [sha256(token)],
      );
      if (!r || r.used || r.expired) return null;
      await c.query(`UPDATE password_resets SET used_at = now() WHERE token_hash = $1`, [sha256(token)]);
      await c.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [r.user_id, hash]);
      // Log out everywhere, in case someone else had the old password.
      await c.query(`DELETE FROM sessions WHERE user_id = $1`, [r.user_id]);
      return r;
    });
    if (!user) return reply.code(400).send({ error: 'This reset link has expired or was already used. Ask for a new one.' });
    failures.delete(user.email);
    await startSession(reply, user.user_id);
    return { user: { id: user.user_id, email: user.email, name: user.name } };
  });

  app.post('/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
