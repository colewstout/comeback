import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { providersFromConfig } from '../providers/index.js';
import { runTick } from '../services/sequences.js';
import { sendWeeklyReports } from '../services/reports.js';
import { syncAllSquare } from '../services/squareSync.js';
import { squareDepsFromConfig } from '../integrations/deps.js';

// Usage: npm run job:tick   |   npm run job:weekly-report
const job = process.argv[2];
const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);
const providers = providersFromConfig(config);

try {
  if (job === 'tick' || job === 'daily') {
    const square = squareDepsFromConfig(config, db, fetch, console.warn);
    if (square) console.log('square', await syncAllSquare(square));
    console.log(await runTick({ db, providers, appUrl: config.APP_URL, secret: config.SESSION_SECRET, log: console.warn }));
  } else if (job === 'weekly-report') {
    console.log(await sendWeeklyReports(db, providers, config.APP_URL, new Date(), console.warn));
  } else {
    console.error(`Unknown job "${job}". Use "tick" or "weekly-report".`);
    process.exitCode = 1;
  }
} finally {
  await db.end();
}
