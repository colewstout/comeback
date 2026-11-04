CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE businesses (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  industry               text NOT NULL DEFAULT 'salon',
  discount_pct           integer NOT NULL DEFAULT 15 CHECK (discount_pct BETWEEN 0 AND 50),
  overdue_multiplier     numeric(4,2) NOT NULL DEFAULT 1.5 CHECK (overdue_multiplier BETWEEN 1 AND 5),
  timezone               text NOT NULL DEFAULT 'America/New_York',
  send_window_start      smallint NOT NULL DEFAULT 9  CHECK (send_window_start BETWEEN 0 AND 23),
  send_window_end        smallint NOT NULL DEFAULT 20 CHECK (send_window_end BETWEEN 1 AND 24),
  autopilot              boolean NOT NULL DEFAULT false,
  booking_url            text,
  reply_to_email         text,
  postal_address         text,
  sms_from               text,
  plan                   text NOT NULL DEFAULT 'trial' CHECK (plan IN ('trial','starter','growth','multi')),
  plan_status            text NOT NULL DEFAULT 'trialing' CHECK (plan_status IN ('trialing','active','past_due','canceled')),
  trial_ends_at          timestamptz NOT NULL DEFAULT now() + interval '30 days',
  stripe_customer_id     text,
  stripe_subscription_id text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX businesses_owner_idx ON businesses(owner_id);
CREATE UNIQUE INDEX businesses_sms_from_idx ON businesses(sms_from) WHERE sms_from IS NOT NULL;

CREATE TABLE customers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  match_key          text NOT NULL,
  name               text NOT NULL,
  phone              text,
  email              text,
  sms_consent        boolean NOT NULL DEFAULT false,
  sms_opted_out_at   timestamptz,
  email_opted_out_at timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, match_key)
);
CREATE INDEX customers_phone_idx ON customers(business_id, phone);

CREATE TABLE visits (
  id           bigserial PRIMARY KEY,
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  visited_at   date NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  source       text NOT NULL DEFAULT 'csv',
  dedupe_key   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, dedupe_key)
);
CREATE INDEX visits_customer_idx ON visits(customer_id, visited_at);

CREATE TABLE imports (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  filename          text NOT NULL,
  rows_total        integer NOT NULL,
  visits_added      integer NOT NULL,
  rows_skipped      integer NOT NULL,
  customers_created integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sequences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id    uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','won','completed','stopped')),
  stop_reason    text,
  steps_sent     smallint NOT NULL DEFAULT 0,
  started_at     timestamptz NOT NULL DEFAULT now(),
  next_step_at   timestamptz,
  ended_at       timestamptz,
  discount_code  text NOT NULL,
  discount_pct   integer NOT NULL,
  won_visit_id   bigint REFERENCES visits(id) ON DELETE SET NULL,
  recovered_cents integer NOT NULL DEFAULT 0,
  UNIQUE (business_id, discount_code)
);
CREATE UNIQUE INDEX sequences_one_active_idx ON sequences(customer_id) WHERE status = 'active';
CREATE INDEX sequences_due_idx ON sequences(business_id, status, next_step_at);

CREATE TABLE messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_id  uuid REFERENCES customers(id) ON DELETE CASCADE,
  sequence_id  uuid REFERENCES sequences(id) ON DELETE CASCADE,
  step         smallint,
  direction    text NOT NULL DEFAULT 'out' CHECK (direction IN ('out','in')),
  channel      text NOT NULL CHECK (channel IN ('sms','email')),
  to_address   text NOT NULL,
  subject      text,
  body         text NOT NULL,
  status       text NOT NULL CHECK (status IN ('sending','sent','failed','received')),
  provider     text,
  provider_id  text,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- A step can only be sent once, even if two job runs overlap.
CREATE UNIQUE INDEX messages_step_once_idx ON messages(sequence_id, step) WHERE status IN ('sending','sent');
CREATE INDEX messages_business_idx ON messages(business_id, created_at DESC);

CREATE TABLE webhook_events (
  id          text PRIMARY KEY,
  source      text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
