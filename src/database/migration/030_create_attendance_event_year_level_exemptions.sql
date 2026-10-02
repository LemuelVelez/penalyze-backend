BEGIN;

CREATE TABLE IF NOT EXISTS public.attendance_event_year_level_exemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.attendance_events(id) ON DELETE CASCADE,
  year_level_key TEXT NOT NULL,
  year_level_label TEXT NOT NULL,
  college_key TEXT NULL,
  college_label TEXT NULL,
  reason TEXT NULL,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_event_year_level_exemptions_year_level_key_check
    CHECK (year_level_key IN ('1', '2', '3', '4', '5'))
);

CREATE UNIQUE INDEX IF NOT EXISTS attendance_event_year_level_exemptions_event_year_college_unique
  ON public.attendance_event_year_level_exemptions(event_id, year_level_key, COALESCE(college_key, ''));

CREATE INDEX IF NOT EXISTS idx_attendance_event_year_level_exemptions_school_year_year_level
  ON public.attendance_event_year_level_exemptions(school_year_id, year_level_key);

CREATE INDEX IF NOT EXISTS idx_attendance_event_year_level_exemptions_event
  ON public.attendance_event_year_level_exemptions(event_id);

DROP TRIGGER IF EXISTS trg_attendance_event_year_level_exemptions_updated_at
  ON public.attendance_event_year_level_exemptions;
CREATE TRIGGER trg_attendance_event_year_level_exemptions_updated_at
BEFORE UPDATE ON public.attendance_event_year_level_exemptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
