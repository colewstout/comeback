-- Guided setup checklist on the dashboard.
ALTER TABLE businesses
  ADD COLUMN messages_reviewed_at timestamptz,
  ADD COLUMN setup_dismissed boolean NOT NULL DEFAULT false;
