BEGIN;

-- Hash login identifiers in application code; never store submitted passwords or
-- raw attempted email addresses in this rate-limiting table.
CREATE TABLE IF NOT EXISTS public.auth_login_throttles (
  key_hash TEXT PRIMARY KEY,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_login_throttles_updated_at
  ON public.auth_login_throttles (updated_at);

COMMIT;
