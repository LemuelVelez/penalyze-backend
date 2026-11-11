BEGIN;

CREATE TABLE IF NOT EXISTS public.attendance_event_college_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.attendance_events(id) ON DELETE CASCADE,
  college_key TEXT NOT NULL,
  college_label TEXT NOT NULL,
  note TEXT NULL,
  verified_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_event_college_verifications_event_college_unique UNIQUE (event_id, college_key)
);

CREATE INDEX IF NOT EXISTS idx_attendance_event_college_verifications_school_year_college
  ON public.attendance_event_college_verifications (school_year_id, college_key);

DROP TRIGGER IF EXISTS trg_attendance_event_college_verifications_updated_at
  ON public.attendance_event_college_verifications;
CREATE TRIGGER trg_attendance_event_college_verifications_updated_at
BEFORE UPDATE ON public.attendance_event_college_verifications
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
