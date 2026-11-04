import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { providersFromConfig } from './providers/index.js';
import { startScheduler } from './jobs/scheduler.js';

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db, (m) => console.log(`[migrate] ${m}`));
const providers = providersFromConfig(config);
const app = await buildApp({ config, db, providers });

app.log.info(`texting: ${providers.sms?.name ?? 'off'}, email: ${providers.email?.name ?? 'off'}, billing: ${config.STRIPE_SECRET_KEY ? 'stripe' : 'off'}, square: ${app.square ? config.SQUARE_ENVIRONMENT : 'off'}`);

// Built-in scheduler: sends due messages every 15 minutes and the Monday report.
// Turn it off (RUN_SCHEDULER=0) if you trigger /jobs/tick from an external cron instead.
const stopScheduler = process.env.RUN_SCHEDULER === '0'
  ? () => {}
  : startScheduler({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET, square: app.square, log: (m, extra) => app.log.info(extra ?? {}, m) });

const close = async () => {
  stopScheduler();
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', close);
process.on('SIGINT', close);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
