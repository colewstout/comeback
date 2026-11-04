import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { encryptionKey } from '../lib/security.js';
import type { SquareDeps } from '../services/squareSync.js';
import { squareClient } from './square.js';

export function squareDepsFromConfig(c: Config, db: Db, fetchImpl: typeof fetch = fetch, log?: (m: string) => void): SquareDeps | null {
  if (!c.SQUARE_APP_ID || !c.SQUARE_APP_SECRET) return null;
  return {
    db,
    square: squareClient({ appId: c.SQUARE_APP_ID, appSecret: c.SQUARE_APP_SECRET, environment: c.SQUARE_ENVIRONMENT }, fetchImpl),
    tokenKey: encryptionKey(c.TOKEN_ENCRYPTION_KEY ?? c.SESSION_SECRET),
    log,
  };
}
