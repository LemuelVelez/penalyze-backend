BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.attendance_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  year_level TEXT,
  college TEXT,
  program TEXT,
  institution TEXT,
  request_note TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  review_note TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_requests_student_check CHECK (TRIM(student_id) <> ''),
  CONSTRAINT attendance_requests_name_check CHECK (TRIM(name) <> ''),
  CONSTRAINT attendance_requests_status_check CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS public.attendance_request_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES public.attendance_requests(id) ON DELETE CASCADE,
  event_id UUID REFERENCES public.attendance_events(id) ON DELETE SET NULL,
  event_name TEXT NOT NULL,
  evidence_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_request_events_name_check CHECK (TRIM(event_name) <> ''),
  CONSTRAINT attendance_request_events_evidence_check CHECK (TRIM(evidence_url) <> ''),
  CONSTRAINT attendance_request_events_unique_event UNIQUE (request_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_requests_status_created
  ON public.attendance_requests(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_requests_school_year
  ON public.attendance_requests(school_year_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_requests_student
  ON public.attendance_requests(LOWER(TRIM(student_id)), created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_request_events_request
  ON public.attendance_request_events(request_id);

CREATE INDEX IF NOT EXISTS idx_attendance_request_events_event
  ON public.attendance_request_events(event_id);

DROP TRIGGER IF EXISTS trg_attendance_requests_updated_at ON public.attendance_requests;
CREATE TRIGGER trg_attendance_requests_updated_at
BEFORE UPDATE ON public.attendance_requests
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
