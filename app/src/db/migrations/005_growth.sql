-- Second-visit offers, owner-edited message wording, waitlist sign-ups.
ALTER TABLE sequences ADD COLUMN kind text NOT NULL DEFAULT 'winback' CHECK (kind IN ('winback','second_visit'));

ALTER TABLE businesses
  ADD COLUMN second_visit_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN second_visit_discount_pct integer NOT NULL DEFAULT 10 CHECK (second_visit_discount_pct BETWEEN 0 AND 50),
  ADD COLUMN message_templates jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE waitlist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  business_name text NOT NULL DEFAULT '',
  business_type text NOT NULL DEFAULT '',
  phone         text,
  message       text NOT NULL DEFAULT '',
  source        text NOT NULL DEFAULT 'website',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
