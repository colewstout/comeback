import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../lib/security.js';
import { runTick } from '../services/sequences.js';
import { sendWeeklyReports } from '../services/reports.js';
import { syncAllSquare } from '../services/squareSync.js';

/**
 * HTTP triggers for hosted cron services (Render Cron, GitHub Actions, cron-job.org…).
 * Call with: Authorization: Bearer $CRON_SECRET
 */
export async function jobRoutes(app: FastifyInstance) {
  const { db, providers, config } = app.deps;

  app.addHook('onRequest', async (req, reply) => {
    const secret = config.CRON_SECRET;
    const got = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!secret || !safeEqual(got, secret)) return reply.code(401).send({ error: 'Unauthorized' });
  });

  app.post('/tick', async (req) => {
    const square = app.square ? await syncAllSquare({ ...app.square, log: (m) => req.log.warn(m) }, app.deps.now()) : null;
    const tick = await runTick({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET, log: (m) => req.log.warn(m) }, app.deps.now());
    return { ...tick, square };
  });

  app.post('/weekly-report', async (req) =>
    sendWeeklyReports(db, providers, config.APP_URL, app.deps.now(), (m) => req.log.warn(m)));
}
