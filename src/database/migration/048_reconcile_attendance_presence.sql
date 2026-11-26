-- Rebuild the masterlist semester in the migration runner's transaction.
SET LOCAL statement_timeout = '0';
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync'));

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS masterlist_original jsonb,
  ADD COLUMN IF NOT EXISTS masterlist_status text;
ALTER TABLE public.manual_attendance_records
  ADD COLUMN IF NOT EXISTS masterlist_original jsonb,
  ADD COLUMN IF NOT EXISTS masterlist_status text;

-- Match masterlist-normalize.ts. Never truncate a nonzero six-digit serial:
-- the original ID and name are required to resolve that case safely.
CREATE OR REPLACE FUNCTION public.masterlist_student_number_key(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cleaned TEXT := REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(value, ''), '–—', '--')), '[[:space:]]', '', 'g');
  parts TEXT[];
  serial TEXT;
BEGIN
  parts := REGEXP_MATCH(cleaned, '^(?:TC-?)?([0-9O]{2})-?([A-Z])-?([0-9O]+)$');
  IF parts IS NOT NULL AND cleaned !~ '^[0-9O]+$' THEN
    serial := COALESCE(NULLIF(LTRIM(TRANSLATE(parts[3], 'O', '0'), '0'), ''), '0');
    IF LENGTH(serial) <= 5 THEN
      RETURN 'TC-' || TRANSLATE(parts[1], 'O', '0') || '-' || parts[2] || '-' || LPAD(serial, 5, '0');
    END IF;
  END IF;
  RETURN REGEXP_REPLACE(cleaned, '[^A-Z0-9-]', '', 'g');
END;
$$;

-- Expression indexes must not retain values produced by the old function.
REINDEX INDEX public.idx_attendance_records_masterlist_key;
REINDEX INDEX public.idx_manual_attendance_records_masterlist_key;
REINDEX INDEX public.idx_attendance_requests_masterlist_key;
REINDEX INDEX public.idx_attendance_final_results_masterlist_key;
REINDEX INDEX public.idx_calculation_results_masterlist_key;
REINDEX INDEX public.idx_penalty_results_masterlist_key;
REINDEX INDEX public.idx_fines_masterlist_key;
REINDEX INDEX public.idx_attendance_student_event_overrides_masterlist_key;
REINDEX INDEX public.idx_attendance_records_comparison_key;
REINDEX INDEX public.idx_manual_attendance_records_comparison_key;
REINDEX INDEX public.idx_attendance_overrides_comparison_key;
REINDEX INDEX public.idx_students_comparison_key;

-- The runner calls the TypeScript resolver before recording this migration.
