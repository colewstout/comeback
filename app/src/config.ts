import { z } from 'zod';

const optional = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://comeback:comeback@localhost:5432/comeback'),
  APP_URL: z.string().default('http://localhost:3000'),
  SESSION_SECRET: z.string().default('dev-only-secret-change-me'),
  CRON_SECRET: optional,

  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_FROM_NUMBER: optional,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,

  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  STRIPE_PRICE_STARTER: optional,
  STRIPE_PRICE_GROWTH: optional,
  STRIPE_PRICE_MULTI: optional,
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production') {
    if (config.SESSION_SECRET.startsWith('dev-') || config.SESSION_SECRET.length < 32) {
      throw new Error('Set SESSION_SECRET to a random string of at least 32 characters in production.');
    }
    if (!config.CRON_SECRET) throw new Error('Set CRON_SECRET in production so scheduled jobs are protected.');
  }
  return config;
}

export const isProd = (c: Config) => c.NODE_ENV === 'production';
