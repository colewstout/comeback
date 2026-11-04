import type { FastifyInstance } from 'fastify';
import { randomToken, signToken, verifyToken } from '../lib/security.js';
import { squareAuthorizeUrl, SquareApiError } from '../integrations/square.js';
import { disconnect, getIntegration, publicIntegration, saveConnection, syncSquare } from '../services/squareSync.js';

const STATE_TTL_MS = 15 * 60_000;

export async function integrationRoutes(app: FastifyInstance) {
  const { config } = app.deps;
  const now = () => app.deps.now();
  const sq = app.square;

  // ---- JSON API for the dashboard
  app.register(async (api) => {
    api.addHook('preHandler', app.requireAuth);

    api.get('/api/integrations', async (req) => ({
      square: { available: sq !== null, ...publicIntegration(await getIntegration(app.deps.db, req.business!.id)) },
    }));

    api.post('/api/integrations/square/sync', async (req, reply) => {
      if (!sq) return reply.code(503).send({ error: 'Square isn’t set up on this server.' });
      const result = await syncSquare(sq, req.business!.id, now());
      return { result, square: publicIntegration(await getIntegration(app.deps.db, req.business!.id)) };
    });

    api.post('/api/integrations/square/disconnect', async (req, reply) => {
      if (!sq) return reply.code(503).send({ error: 'Square isn’t set up on this server.' });
      await disconnect(sq, req.business!.id);
      return { ok: true };
    });
  });

  // ---- Browser redirects for Square's OAuth flow
  app.get('/integrations/square/connect', async (req, reply) => {
    if (!sq) return reply.redirect('/app#square-unavailable');
    if ((await app.loadSession(req)) !== 'ok') return reply.redirect('/app#login');
    const state = signToken(`sq:${req.business!.id}:${Date.now() + STATE_TTL_MS}:${randomToken(8)}`, config.SESSION_SECRET);
    return reply.redirect(squareAuthorizeUrl({ appId: config.SQUARE_APP_ID!, appSecret: config.SQUARE_APP_SECRET!, environment: config.SQUARE_ENVIRONMENT }, state));
  });

  app.get('/integrations/square/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    if (!sq) return reply.redirect('/app#square-unavailable');
    if (q.error) return reply.redirect(q.error === 'access_denied' ? '/app#square-cancelled' : '/app#square-error');
    // The state must be ours, recent, and for the business of whoever is logged in now.
    const payload = q.state ? verifyToken(q.state, config.SESSION_SECRET) : null;
    const [tag, businessId, expires] = payload?.split(':') ?? [];
    if (tag !== 'sq' || !businessId || Number(expires) < Date.now() || !q.code) return reply.redirect('/app#square-error');
    if ((await app.loadSession(req)) !== 'ok') return reply.redirect('/app#login');
    if (req.business!.id !== businessId) return reply.redirect('/app#square-error');

    try {
      const tokens = await sq.square.exchangeCode(q.code);
      await saveConnection(sq, businessId, tokens);
    } catch (err) {
      req.log.warn({ err: err instanceof SquareApiError ? err.message : err }, 'square connect failed');
      return reply.redirect('/app#square-error');
    }
    // First sync can take a minute for a big account; run it in the background.
    syncSquare(sq, businessId, now()).catch((err) => req.log.warn({ err: (err as Error).message }, 'initial square sync failed'));
    return reply.redirect('/app#square-connected');
  });
}
