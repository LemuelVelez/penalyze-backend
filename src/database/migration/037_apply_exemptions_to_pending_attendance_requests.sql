BEGIN;

SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

WITH pending_scope AS (
  SELECT
    ar.id AS request_id,
    COALESCE(NULLIF(TRIM(ar.college), ''), (
      SELECT NULLIF(TRIM(s.college), '')
      FROM public.students s
      WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        AND NULLIF(TRIM(s.college), '') IS NOT NULL
      ORDER BY s.updated_at DESC NULLS LAST
      LIMIT 1
    ), '') AS college,
    COALESCE(NULLIF(TRIM(ar.year_level), ''), (
      SELECT NULLIF(TRIM(s.year_level), '')
      FROM public.students s
      WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        AND NULLIF(TRIM(s.year_level), '') IS NOT NULL
      ORDER BY s.updated_at DESC NULLS LAST
      LIMIT 1
    ), '') AS year_level
  FROM public.attendance_requests ar
  WHERE ar.status = 'pending'
    AND ar.request_type = 'event_review'
), normalized_scope AS (
  SELECT
    p.*,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
      LOWER(REPLACE(p.college, '&', ' and ')),
      '[^a-z0-9]+', ' ', 'g'
    ), '[[:space:]]+', ' ', 'g')), '') AS college_key,
    REGEXP_REPLACE(LOWER(TRIM(COALESCE(p.year_level, ''))), '[^a-z0-9]+', '', 'g') AS year_level_normalized
  FROM pending_scope p
), request_keys AS (
  SELECT n.*,
    CASE
      WHEN n.year_level_normalized IN ('1', '1styear', '1styr', 'firstyear', 'firstyr', 'year1', 'i') THEN '1'
      WHEN n.year_level_normalized IN ('2', '2ndyear', '2ndyr', 'secondyear', 'secondyr', 'year2', 'ii') THEN '2'
      WHEN n.year_level_normalized IN ('3', '3rdyear', '3rdyr', 'thirdyear', 'thirdyr', 'year3', 'iii') THEN '3'
      WHEN n.year_level_normalized IN ('4', '4thyear', '4thyr', 'fourthyear', 'fourthyr', 'year4', 'iv') THEN '4'
      WHEN n.year_level_normalized IN ('5', '5thyear', '5thyr', 'fifthyear', 'fifthyr', 'year5', 'v') THEN '5'
      ELSE NULL
    END AS year_level_key
  FROM normalized_scope n
), exempt_events AS (
  SELECT are.id
  FROM public.attendance_request_events are
  JOIN request_keys r ON r.request_id = are.request_id
  WHERE are.event_id IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM public.attendance_event_college_exemptions e
        WHERE e.event_id = are.event_id AND e.college_key = r.college_key
      )
      OR EXISTS (
        SELECT 1 FROM public.attendance_event_year_level_exemptions e
        WHERE e.event_id = are.event_id
          AND e.year_level_key = r.year_level_key
          AND (e.college_key IS NULL OR e.college_key = r.college_key)
      )
    )
), removed AS (
  DELETE FROM public.attendance_request_events are
  USING exempt_events e
  WHERE are.id = e.id
  RETURNING are.request_id, are.event_name
), removed_groups AS (
  SELECT
    request_id,
    COUNT(*)::integer AS removed_count,
    STRING_AGG(event_name, ', ' ORDER BY event_name) AS removed_names
  FROM removed
  GROUP BY request_id
), affected AS (
  SELECT r.request_id, r.college, r.year_level, g.removed_names,
    (
      SELECT COUNT(*) FROM public.attendance_request_events are
      WHERE are.request_id = r.request_id
    ) = g.removed_count AS all_events_removed
  FROM removed_groups g
  JOIN request_keys r ON r.request_id = g.request_id
)
UPDATE public.attendance_requests ar
SET
  status = CASE WHEN a.all_events_removed THEN 'rejected' ELSE ar.status END,
  reviewed_by = CASE WHEN a.all_events_removed THEN NULL ELSE ar.reviewed_by END,
  reviewed_at = CASE WHEN a.all_events_removed THEN NOW() ELSE ar.reviewed_at END,
  review_note = CASE
    WHEN a.all_events_removed THEN
      'Automatically closed: all requested events (' || a.removed_names ||
      ') are exempted for ' || COALESCE(NULLIF(a.college, ''), 'unknown college') ||
      ' / ' || COALESCE(NULLIF(a.year_level, ''), 'unknown year level') ||
      '. No attendance needs to be credited.'
    ELSE CONCAT_WS(E'\n', NULLIF(ar.review_note, ''),
      'Exempted event(s) removed automatically: ' || a.removed_names || '.')
  END,
  updated_at = NOW()
FROM affected a
WHERE ar.id = a.request_id;

COMMIT;
