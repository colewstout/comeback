// Creates a demo account with a year of made-up salon sales so you can click around.
// Usage: npm run seed   (login: demo@onemoretime.test / demo-password-123)
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../lib/security.js';
import { importCsv } from '../services/imports.js';
import { addDays, localDate } from '../lib/dates.js';

const EMAIL = 'demo@onemoretime.test';
const PASSWORD = 'demo-password-123';
const NAMES = ['Dana Reyes', 'Marcus Bell', 'Priya Shah', 'Tom Whitaker', 'Aisha Grant', 'Lena Novak', 'Chris Ortiz', 'Jordan Lee', 'Hannah Cole', 'Diego Ramos', 'Mei Chen', 'Sam Patel', 'Olivia Brooks', 'Noah Kim', 'Grace Turner', 'Ethan Moore', 'Sofia Alvarez', 'Liam Foster', 'Zoe Hughes', 'Ben Carter', 'Ruby Walsh', 'Kai Nguyen', 'Ava Mitchell', 'Omar Haddad', 'Isla Pearson', 'Leo Fischer', 'Maya Robinson', 'Jack Sullivan', 'Nina Petrova', 'Ryan Doyle', 'Elena Rossi', 'Tyler Grant', 'Chloe Martin', 'Victor Lane', 'Amara Okafor', 'Felix Wagner', 'Tess Morgan', 'Andre Silva', 'Julia Park', 'Owen Price'];

function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const config = loadConfig();
const db = createPool(config.DATABASE_URL);
await migrate(db);

await db.query('DELETE FROM users WHERE email = $1', [EMAIL]);
const { rows: [u] } = await db.query<{ id: string }>(`INSERT INTO users (email, password_hash, name) VALUES ($1, $2, 'Demo Owner') RETURNING id`, [EMAIL, await hashPassword(PASSWORD)]);
const { rows: [b] } = await db.query(
  `INSERT INTO businesses (owner_id, name, industry, timezone, reply_to_email, postal_address) VALUES ($1, 'Maple & Main Salon', 'salon', 'America/New_York', $2, '12 Main St, Springfield, IL 62701') RETURNING *`,
  [u!.id, EMAIL],
);

const r = rng(42);
const today = localDate(new Date(), 'America/New_York');
const lines = ['name,phone,email,date,amount,text opt in'];
NAMES.forEach((name, i) => {
  const interval = 42 * (0.65 + r() * 0.8);
  const roll = r();
  const ratio = roll < 0.45 ? 0.15 + r() * 0.8 : roll < 0.62 ? 1 + r() * 0.45 : roll < 0.84 ? 1.55 + r() * 1.4 : 3.1 + r() * 3;
  const n = i % 9 === 4 ? 1 : 2 + Math.floor(r() * 8);
  let daysAgo = interval * ratio;
  const first = name.split(' ')[0]!.toLowerCase();
  const phone = `555-01${String(10 + i).padStart(2, '0')}`;
  for (let k = 0; k < n; k++) {
    const amount = Math.max(5, Math.round((85 * (0.7 + r() * 0.7)) / 5) * 5);
    lines.push(`${name},${i % 3 === 0 ? '' : '312' + phone},${first}@example.com,${addDays(today, -Math.round(daysAgo))},${amount},${i % 2 ? 'yes' : 'no'}`);
    daysAgo += interval * (0.85 + r() * 0.3);
  }
});

const result = await importCsv(db, b, { filename: 'demo-sales.csv', csv: lines.join('\n') });
console.log(`Demo account ready: ${EMAIL} / ${PASSWORD} (${result.customersCreated} customers, ${result.visitsAdded} visits)`);
await db.end();
