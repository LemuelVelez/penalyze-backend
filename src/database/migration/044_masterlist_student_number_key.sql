BEGIN;

-- Keep SQL joins consistent with the TypeScript masterlist resolver.
CREATE OR REPLACE FUNCTION public.masterlist_student_number_key(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cleaned TEXT := REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(value, ''), '–—', '--')), '[[:space:]]', '', 'g');
  parts TEXT[];
BEGIN
  parts := REGEXP_MATCH(cleaned, '^TC-?([0-9]{2})-?([A-Z])-?([0-9]{1,5})$');
  IF parts IS NOT NULL THEN
    RETURN 'TC-' || parts[1] || '-' || parts[2] || '-' || LPAD(parts[3], 5, '0');
  END IF;
  RETURN REGEXP_REPLACE(cleaned, '[^A-Z0-9-]', '', 'g');
END;
$$;

CREATE OR REPLACE FUNCTION public.is_masterlist_school_year(term UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.school_years sy
    WHERE sy.id = term AND sy.semester = 'first_semester'
      AND (sy.name ~ '2026[[:space:]]*[-–—/][[:space:]]*2027'
        OR (EXTRACT(YEAR FROM sy.starts_at) = 2026 AND EXTRACT(YEAR FROM sy.ends_at) = 2027))
  );
$$;

CREATE INDEX IF NOT EXISTS idx_attendance_records_masterlist_key
  ON public.attendance_records(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_masterlist_key
  ON public.manual_attendance_records(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_attendance_requests_masterlist_key
  ON public.attendance_requests(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_attendance_final_results_masterlist_key
  ON public.attendance_final_results(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_calculation_results_masterlist_key
  ON public.calculation_results(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_penalty_results_masterlist_key
  ON public.penalty_results(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_fines_masterlist_key
  ON public.fines(public.masterlist_student_number_key(student_id), school_year_id);
CREATE INDEX IF NOT EXISTS idx_attendance_student_event_overrides_masterlist_key
  ON public.attendance_student_event_overrides(public.masterlist_student_number_key(student_key), school_year_id);

COMMIT;
