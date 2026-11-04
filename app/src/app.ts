import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { Providers } from './providers/index.js';
import { getBusinessForOwner, type Business } from './services/businesses.js';
import { sha256 } from './lib/security.js';
import { authRoutes, SESSION_COOKIE } from './routes/auth.js';
import { apiRoutes } from './routes/api.js';
import { webhookRoutes } from './routes/webhooks.js';
import { jobRoutes } from './routes/jobs.js';
import { ImportError } from './services/imports.js';
import { CsvError } from './lib/csv.js';
import { BillingError } from './services/billing.js';
import { SyncError, type SquareDeps } from './services/squareSync.js';
import { squareDepsFromConfig } from './integrations/deps.js';
import { integrationRoutes } from './routes/integrations.js';

export interface AppDeps {
  config: Config;
  db: Db;
  providers: Providers;
  now?: () => Date; // overridable in tests
  fetch?: typeof fetch; // overridable in tests (Square API)
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<AppDeps>;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    loadSession: (req: FastifyRequest) => Promise<'none' | 'expired' | 'no_business' | 'ok'>;
    square: SquareDeps | null; // null when SQUARE_APP_ID / SQUARE_APP_SECRET aren't set
  }
  interface FastifyRequest {
    user?: { id: string; email: string; name: string };
    business?: Business;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.config.NODE_ENV === 'test' ? false : { level: 'info' },
    bodyLimit: 15 * 1024 * 1024, // CSV uploads
    trustProxy: true,
  });
  app.decorate('deps', { now: () => new Date(), fetch: globalThis.fetch, ...deps });
  app.decorate('square', squareDepsFromConfig(deps.config, deps.db, deps.fetch ?? globalThis.fetch));

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(formbody);

  /** Look up the logged-in user and their business from the session cookie. */
  async function loadSession(req: FastifyRequest): Promise<'none' | 'expired' | 'no_business' | 'ok'> {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return 'none';
    const { rows } = await deps.db.query<{ id: string; email: string; name: string }>(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) return 'expired';
    req.user = rows[0];
    req.business = (await getBusinessForOwner(deps.db, rows[0].id)) ?? undefined;
    return req.business ? 'ok' : 'no_business';
  }
  app.decorate('loadSession', loadSession);

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const s = await loadSession(req);
    if (s === 'none') return reply.code(401).send({ error: 'Please log in.' });
    if (s === 'expired') return reply.code(401).send({ error: 'Your session has expired. Please log in again.' });
    if (s === 'no_business') return reply.code(403).send({ error: 'No business on this account.' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first?.path.join('.') || 'input'}: ${first?.message}` });
    }
    if (err instanceof ImportError || err instanceof CsvError || err instanceof BillingError || err instanceof SyncError) {
      return reply.code(400).send({ error: err.message });
    }
    const e = err as { statusCode?: number; message: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong on our side. Please try again.' });
  });

  app.get('/healthz', async () => {
    await deps.db.query('SELECT 1');
    return { ok: true };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(apiRoutes, { prefix: '/api' });
  await app.register(webhookRoutes);
  await app.register(jobRoutes, { prefix: '/jobs' });
  await app.register(integrationRoutes);

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, index: ['index.html'] });
  app.get('/app', (_req, reply) => reply.sendFile('app.html'));

  return app;
}
