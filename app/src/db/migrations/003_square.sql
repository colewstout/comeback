-- Connections to outside systems (Square for now). Tokens are encrypted by the app before storage.
CREATE TABLE integrations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider          text NOT NULL CHECK (provider IN ('square')),
  status            text NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','error','needs_reauth','disconnected')),
  external_account  text,               -- Square merchant id
  account_name      text,               -- Square business name, for display
  access_token_enc  text,
  refresh_token_enc text,
  token_expires_at  timestamptz,
  synced_through    timestamptz,        -- newest payment time seen
  last_synced_at    timestamptz,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);

ALTER TABLE customers ADD COLUMN square_customer_id text;
CREATE UNIQUE INDEX customers_square_idx ON customers(business_id, square_customer_id) WHERE square_customer_id IS NOT NULL;
