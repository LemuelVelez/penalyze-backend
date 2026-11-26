-- Keep ordinary reads available during index creation; never wait indefinitely
-- for the attendance rebuild's write locks.
SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '180000ms';

CREATE INDEX IF NOT EXISTS idx_attendance_records_institution_lookup
  ON public.attendance_records (LOWER(TRIM(student_id)), updated_at DESC)
  WHERE deleted_at IS NULL AND NULLIF(TRIM(institution), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_manual_attendance_institution_lookup
  ON public.manual_attendance_records (LOWER(TRIM(student_id)), updated_at DESC)
  WHERE NULLIF(TRIM(institution), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_final_attendance_institution_lookup
  ON public.attendance_final_results (LOWER(TRIM(student_id)), updated_at DESC)
  WHERE NULLIF(TRIM(institution), '') IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_calculation_institution_lookup
  ON public.calculation_results (LOWER(TRIM(student_id)), updated_at DESC)
  WHERE NULLIF(TRIM(institution), '') IS NOT NULL;
