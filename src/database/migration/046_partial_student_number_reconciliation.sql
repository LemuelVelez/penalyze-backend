BEGIN;

SET LOCAL statement_timeout = '180000ms';
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync'));

CREATE OR REPLACE FUNCTION public.masterlist_student_number_key(value TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  cleaned TEXT := REGEXP_REPLACE(UPPER(TRANSLATE(COALESCE(value, ''), '–—', '--')), '[[:space:]]', '', 'g');
  parts TEXT[];
BEGIN
  parts := REGEXP_MATCH(cleaned, '^(?:TC-?)?([0-9O]{2})-?([A-Z])-?([0-9O]{1,5})$');
  IF parts IS NOT NULL AND cleaned !~ '^[0-9O]{1,5}$' THEN
    RETURN 'TC-' || TRANSLATE(parts[1], 'O', '0') || '-' || parts[2] || '-' || LPAD(TRANSLATE(parts[3], 'O', '0'), 5, '0');
  END IF;
  RETURN REGEXP_REPLACE(cleaned, '[^A-Z0-9-]', '', 'g');
END;
$$;

-- Existing expression-index entries were computed with the previous function.
-- Rebuild them before any backfill statements can consult those entries.
REINDEX INDEX public.idx_attendance_records_masterlist_key;
REINDEX INDEX public.idx_manual_attendance_records_masterlist_key;
REINDEX INDEX public.idx_attendance_requests_masterlist_key;
REINDEX INDEX public.idx_attendance_final_results_masterlist_key;
REINDEX INDEX public.idx_calculation_results_masterlist_key;
REINDEX INDEX public.idx_penalty_results_masterlist_key;
REINDEX INDEX public.idx_fines_masterlist_key;
REINDEX INDEX public.idx_attendance_student_event_overrides_masterlist_key;

-- The existing masterlist key was already validated as a full canonical ID.
-- Keep its displayed ID canonical too, so later reconciliation cannot undo this backfill.
UPDATE public.student_masterlist
SET student_number = student_number_key
WHERE student_number_key ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
  AND student_number IS DISTINCT FROM student_number_key;

-- Preserve original source rows. Only derived duplicates are removed, using
-- their actual unique scopes and the reconciliation service's keep ranking.
DO $$
DECLARE
  table_name TEXT;
  extra_scope TEXT;
  paid_rank TEXT;
  ranking TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['attendance_final_results', 'calculation_results', 'penalty_results'] LOOP
    extra_scope := CASE table_name
      WHEN 'attendance_final_results' THEN ', t.import_id'
      WHEN 'calculation_results' THEN ', t.calculation_scope_key'
      ELSE '' END;
    paid_rank := CASE WHEN table_name = 'penalty_results'
      THEN 'CASE t.status WHEN ''paid'' THEN 0 WHEN ''waived'' THEN 1 ELSE 2 END, '
      ELSE '' END;
    ranking := FORMAT($rank$
      WITH ranked AS (
        SELECT t.id, t.school_year_id, FIRST_VALUE(t.id) OVER w AS keep_id, ROW_NUMBER() OVER w AS rn
        FROM public.%I t
        WHERE public.masterlist_student_number_key(t.student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
        WINDOW w AS (PARTITION BY t.school_year_id, public.masterlist_student_number_key(t.student_id)%s
                     ORDER BY %s t.updated_at DESC, t.id DESC)
      )
    $rank$, table_name, extra_scope, paid_rank);
    IF table_name <> 'penalty_results' THEN
      EXECUTE ranking || FORMAT('UPDATE public.penalty_results p SET source_record_id=r.keep_id FROM ranked r WHERE r.rn>1 AND p.school_year_id IS NOT DISTINCT FROM r.school_year_id AND p.source_table=%L AND p.source_record_id=r.id', table_name);
    END IF;
    EXECUTE ranking || FORMAT('DELETE FROM public.%I t USING ranked r WHERE r.rn>1 AND t.id=r.id', table_name);
  END LOOP;

  FOREACH table_name IN ARRAY ARRAY['attendance_records', 'manual_attendance_records', 'attendance_requests', 'attendance_final_results', 'calculation_results', 'penalty_results', 'fines'] LOOP
    EXECUTE FORMAT($update$
      UPDATE public.%I
      SET student_id = public.masterlist_student_number_key(student_id)
      WHERE public.masterlist_student_number_key(student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
        AND student_id IS DISTINCT FROM public.masterlist_student_number_key(student_id)
    $update$, table_name);
  END LOOP;
END;
$$;

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY school_year_id, LOWER(public.masterlist_student_number_key(student_key)), event_id
    ORDER BY updated_at DESC, id DESC
  ) AS rn
  FROM public.attendance_student_event_overrides
  WHERE public.masterlist_student_number_key(student_key) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
)
DELETE FROM public.attendance_student_event_overrides o USING ranked r WHERE r.rn > 1 AND o.id = r.id;

UPDATE public.attendance_student_event_overrides
SET student_key = LOWER(public.masterlist_student_number_key(student_key))
WHERE public.masterlist_student_number_key(student_key) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
  AND student_key IS DISTINCT FROM LOWER(public.masterlist_student_number_key(student_key));

COMMIT;
