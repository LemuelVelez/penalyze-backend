
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.penalty_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL,
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  no_of_absences INTEGER NOT NULL DEFAULT 0,
  penalty_id UUID REFERENCES public.penalties(id) ON DELETE SET NULL,
  prescribed_penalty TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unpaid',
  source_table TEXT,
  source_record_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT penalty_results_absences_check CHECK (no_of_absences >= 0),
  CONSTRAINT penalty_results_status_check CHECK (status IN ('unpaid', 'paid', 'waived')),
  CONSTRAINT penalty_results_student_check CHECK (TRIM(student_id) <> ''),
  CONSTRAINT penalty_results_name_check CHECK (TRIM(name) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_penalty_results_school_year_student
  ON public.penalty_results (
    school_year_id,
    LOWER(TRIM(student_id))
  );

CREATE INDEX IF NOT EXISTS idx_penalty_results_school_year
  ON public.penalty_results(school_year_id);

CREATE INDEX IF NOT EXISTS idx_penalty_results_status
  ON public.penalty_results(status);

CREATE INDEX IF NOT EXISTS idx_penalty_results_student
  ON public.penalty_results(LOWER(TRIM(student_id)));

COMMIT;