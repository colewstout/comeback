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

export interface AppDeps {
  config: Config;
  db: Db;
  providers: Providers;
  now?: () => Date; // overridable in tests
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Required<AppDeps>;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
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
  app.decorate('deps', { now: () => new Date(), ...deps });

  await app.register(cookie, { secret: deps.config.SESSION_SECRET });
  await app.register(formbody);

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return reply.code(401).send({ error: 'Please log in.' });
    const { rows } = await deps.db.query<{ id: string; email: string; name: string }>(
      `SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    );
    if (!rows[0]) return reply.code(401).send({ error: 'Your session has expired. Please log in again.' });
    req.user = rows[0];
    req.business = (await getBusinessForOwner(deps.db, rows[0].id)) ?? undefined;
    if (!req.business) return reply.code(403).send({ error: 'No business on this account.' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.code(400).send({ error: `${first?.path.join('.') || 'input'}: ${first?.message}` });
    }
    if (err instanceof ImportError || err instanceof CsvError || err instanceof BillingError) {
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

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, index: ['index.html'] });
  app.get('/app', (_req, reply) => reply.sendFile('app.html'));

  return app;
}
