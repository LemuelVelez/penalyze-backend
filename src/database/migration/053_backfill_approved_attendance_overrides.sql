SET LOCAL statement_timeout = '0';
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync'));

-- Use the exact attendanceStudentKeySql expression, not the unrestricted
-- masterlist key, for both approved requests and existing override aliases.
-- Select the most recent approval per student/event and preserve a later
-- explicit FALSE correction, including one saved under a normalized alias.
WITH approval_keys AS MATERIALIZED (
  SELECT ar.id, ar.school_year_id, are.event_id, ar.reviewed_by,
    COALESCE(ar.reviewed_at, ar.updated_at) AS reviewed_at,
    CASE
      WHEN public.masterlist_student_number_key(ar.student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
        THEN LOWER(public.masterlist_student_number_key(ar.student_id))
      ELSE LOWER(TRIM(ar.student_id))
    END AS student_key
  FROM public.attendance_requests ar
  JOIN public.attendance_request_events are ON are.request_id = ar.id
  JOIN public.attendance_events ae ON ae.id = are.event_id AND ae.school_year_id = ar.school_year_id
  WHERE ar.status = 'approved' AND ar.request_type = 'event_review'
), latest_approvals AS MATERIALIZED (
  SELECT DISTINCT ON (school_year_id, student_key, event_id)
    school_year_id, student_key, event_id, reviewed_by, reviewed_at
  FROM approval_keys
  WHERE student_key <> ''
  ORDER BY school_year_id, student_key, event_id, reviewed_at DESC, id DESC
), existing_overrides AS MATERIALIZED (
  SELECT o.id, o.school_year_id, o.event_id, o.attended, o.updated_at, o.student_key AS raw_student_key,
    CASE
      WHEN public.masterlist_student_number_key(o.student_key) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
        THEN LOWER(public.masterlist_student_number_key(o.student_key))
      ELSE LOWER(TRIM(o.student_key))
    END AS student_key
  FROM public.attendance_student_event_overrides o
), eligible AS MATERIALIZED (
  SELECT a.*
  FROM latest_approvals a
  WHERE NOT EXISTS (
    SELECT 1 FROM existing_overrides o
    WHERE o.school_year_id = a.school_year_id AND o.student_key = a.student_key
      AND o.event_id = a.event_id AND o.attended = FALSE AND o.updated_at > a.reviewed_at
  )
), updated AS (
  -- Update all normalized aliases together. Stamp the backfill time so the
  -- recovery sweep also refreshes already-present but stale derived results.
  UPDATE public.attendance_student_event_overrides o
  SET attended = TRUE,
      updated_by = CASE WHEN o.attended THEN o.updated_by ELSE a.reviewed_by END,
      updated_at = NOW()
  FROM eligible a
  JOIN existing_overrides old ON old.school_year_id = a.school_year_id
    AND old.student_key = a.student_key AND old.event_id = a.event_id
  WHERE o.id = old.id AND old.raw_student_key <> a.student_key
  RETURNING o.id
)
INSERT INTO public.attendance_student_event_overrides AS existing
  (school_year_id, student_key, event_id, attended, updated_by)
SELECT a.school_year_id, a.student_key, a.event_id, TRUE, a.reviewed_by
FROM eligible a
WHERE TRUE
ON CONFLICT (school_year_id, student_key, event_id) DO UPDATE
SET attended = TRUE,
    updated_by = CASE WHEN existing.attended THEN existing.updated_by ELSE EXCLUDED.updated_by END,
    updated_at = NOW();
