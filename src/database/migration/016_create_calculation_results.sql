BEGIN;

CREATE TABLE IF NOT EXISTS public.calculation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE CASCADE,
  calculation_scope_key TEXT NOT NULL DEFAULT 'all_imports',
  import_ids UUID[] NOT NULL DEFAULT '{}'::UUID[],
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  year_level TEXT,
  college TEXT,
  program TEXT,
  institution TEXT,
  attended_events INTEGER NOT NULL DEFAULT 0,
  imported_absences INTEGER NOT NULL DEFAULT 0,
  manual_absences INTEGER NOT NULL DEFAULT 0,
  total_absences INTEGER NOT NULL DEFAULT 0,
  attendance_status TEXT NOT NULL DEFAULT 'perfect_attendance',
  penalty_id UUID REFERENCES public.penalties(id) ON DELETE SET NULL,
  prescribed_penalty TEXT,
  source_record_count INTEGER NOT NULL DEFAULT 0,
  latest_scanned_at TIMESTAMPTZ,
  source_updated_at TIMESTAMPTZ,
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT calculation_results_student_check CHECK (TRIM(student_id) <> ''),
  CONSTRAINT calculation_results_name_check CHECK (TRIM(name) <> ''),
  CONSTRAINT calculation_results_attended_events_check CHECK (attended_events >= 0),
  CONSTRAINT calculation_results_imported_absences_check CHECK (imported_absences >= 0),
  CONSTRAINT calculation_results_manual_absences_check CHECK (manual_absences >= 0),
  CONSTRAINT calculation_results_total_absences_check CHECK (total_absences >= 0),
  CONSTRAINT calculation_results_source_record_count_check CHECK (source_record_count >= 0),
  CONSTRAINT calculation_results_status_check CHECK (
    attendance_status IN ('perfect_attendance', 'with_absences')
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_calculation_results_scope_student
  ON public.calculation_results (
    school_year_id,
    calculation_scope_key,
    LOWER(TRIM(student_id))
  );

CREATE INDEX IF NOT EXISTS idx_calculation_results_school_year
  ON public.calculation_results(school_year_id);

CREATE INDEX IF NOT EXISTS idx_calculation_results_scope
  ON public.calculation_results(calculation_scope_key);

CREATE INDEX IF NOT EXISTS idx_calculation_results_import_ids
  ON public.calculation_results USING GIN(import_ids);

CREATE INDEX IF NOT EXISTS idx_calculation_results_student
  ON public.calculation_results(LOWER(TRIM(student_id)));

COMMIT;
