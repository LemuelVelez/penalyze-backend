
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.attendance_final_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL,
  import_id UUID REFERENCES public.attendance_imports(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  year_level TEXT,
  college TEXT,
  program TEXT,
  institution TEXT,
  attended_events INTEGER NOT NULL DEFAULT 0,
  total_absences INTEGER NOT NULL DEFAULT 0,
  attendance_status TEXT NOT NULL DEFAULT 'recorded',
  latest_scanned_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_final_results_attended_check CHECK (attended_events >= 0),
  CONSTRAINT attendance_final_results_absences_check CHECK (total_absences >= 0),
  CONSTRAINT attendance_final_results_student_check CHECK (TRIM(student_id) <> ''),
  CONSTRAINT attendance_final_results_name_check CHECK (TRIM(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_final_results_scope_student
  ON public.attendance_final_results (
    school_year_id,
    import_id,
    LOWER(TRIM(student_id))
  );

CREATE INDEX IF NOT EXISTS idx_attendance_final_results_school_year
  ON public.attendance_final_results(school_year_id);

CREATE INDEX IF NOT EXISTS idx_attendance_final_results_student
  ON public.attendance_final_results(LOWER(TRIM(student_id)));

CREATE INDEX IF NOT EXISTS idx_attendance_final_results_college
  ON public.attendance_final_results(LOWER(TRIM(COALESCE(college, ''))));

COMMIT;