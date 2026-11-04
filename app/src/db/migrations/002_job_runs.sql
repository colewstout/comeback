-- Claims for scheduled jobs that must run once per period (e.g. the Monday report).
CREATE TABLE job_runs (
  id     text PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now()
);
