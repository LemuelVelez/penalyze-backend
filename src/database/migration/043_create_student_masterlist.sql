BEGIN;
CREATE TABLE IF NOT EXISTS public.student_masterlist_imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  file_name TEXT, rows_total INT, rows_valid INT, rows_invalid INT,
  summary JSONB, created_by UUID NULL, created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS public.student_masterlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  import_id UUID REFERENCES public.student_masterlist_imports(id) ON DELETE SET NULL,
  student_number TEXT NOT NULL, student_number_key TEXT NOT NULL,
  last_name TEXT NOT NULL, given_name TEXT NOT NULL, middle_initial TEXT,
  full_name TEXT NOT NULL, name_key TEXT NOT NULL, program TEXT, year_level TEXT,
  year_level_key TEXT, college TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE (school_year_id, student_number_key)
);
CREATE INDEX IF NOT EXISTS idx_masterlist_name ON public.student_masterlist(school_year_id, name_key);
CREATE INDEX IF NOT EXISTS idx_masterlist_college ON public.student_masterlist(school_year_id, college);
-- Keep masterlist-only student changes from marking other semesters stale.
CREATE OR REPLACE FUNCTION public.track_masterlist_scoped_student_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE term_id UUID := NULLIF(current_setting('penalyze.masterlist_school_year', true), '')::UUID;
BEGIN
  IF term_id IS NULL THEN
    PERFORM public.mark_all_calculation_input_changes('students');
  ELSE
    PERFORM public.mark_calculation_input_change(term_id, 'students', NULL);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_calculation_input_students ON public.students;
CREATE TRIGGER trg_calculation_input_students AFTER INSERT OR UPDATE OR DELETE ON public.students
FOR EACH ROW EXECUTE FUNCTION public.track_masterlist_scoped_student_change();
COMMIT;
