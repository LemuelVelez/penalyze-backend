BEGIN;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS request_type TEXT;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS current_name TEXT;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS current_year_level TEXT;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS current_college TEXT;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS current_program TEXT;

ALTER TABLE public.attendance_requests
  ADD COLUMN IF NOT EXISTS evidence_url TEXT;

UPDATE public.attendance_requests
SET request_type = 'event_review'
WHERE request_type IS NULL OR TRIM(request_type) = '';

ALTER TABLE public.attendance_requests
  ALTER COLUMN request_type SET DEFAULT 'event_review',
  ALTER COLUMN request_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'attendance_requests_request_type_check'
      AND conrelid = 'public.attendance_requests'::regclass
  ) THEN
    ALTER TABLE public.attendance_requests
      ADD CONSTRAINT attendance_requests_request_type_check
      CHECK (request_type IN ('event_review', 'details_correction'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_requests_type_status_created
  ON public.attendance_requests(request_type, status, created_at DESC);

COMMIT;
