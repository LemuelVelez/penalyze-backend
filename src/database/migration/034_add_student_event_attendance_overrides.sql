BEGIN;

-- Participant-specific corrections retain the original uploaded/manual source rows.
-- A FALSE correction hides an original check-in; TRUE adds a check-in for this student.
CREATE TABLE IF NOT EXISTS public.attendance_student_event_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  student_key TEXT NOT NULL CHECK (student_key <> '' AND student_key = LOWER(TRIM(student_key))),
  event_id UUID NOT NULL REFERENCES public.attendance_events(id) ON DELETE CASCADE,
  attended BOOLEAN NOT NULL,
  updated_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_student_event_overrides_unique UNIQUE (school_year_id, student_key, event_id)
);

CREATE INDEX IF NOT EXISTS idx_attendance_student_event_overrides_event
  ON public.attendance_student_event_overrides (event_id, school_year_id);

-- Treat a correction as a change to the roster-wide calculation dependency.
-- That way filtered Calculate scopes also know the previously saved totals are stale.
CREATE OR REPLACE FUNCTION public.track_attendance_student_event_override_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.mark_calculation_input_change(OLD.school_year_id, 'events', NULL);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.mark_calculation_input_change(NEW.school_year_id, 'events', NULL);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_attendance_student_event_override_change
  ON public.attendance_student_event_overrides;
CREATE TRIGGER trg_attendance_student_event_override_change
AFTER INSERT OR UPDATE OR DELETE ON public.attendance_student_event_overrides
FOR EACH ROW EXECUTE FUNCTION public.track_attendance_student_event_override_change();

COMMIT;
