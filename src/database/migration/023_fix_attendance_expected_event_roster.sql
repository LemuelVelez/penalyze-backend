BEGIN;

ALTER TABLE public.attendance_final_results
  ADD COLUMN IF NOT EXISTS college_key TEXT,
  ADD COLUMN IF NOT EXISTS expected_events INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS absence_calculation_source TEXT NOT NULL DEFAULT 'roster';

ALTER TABLE public.calculation_results
  ADD COLUMN IF NOT EXISTS college_key TEXT,
  ADD COLUMN IF NOT EXISTS expected_events INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS absence_calculation_source TEXT NOT NULL DEFAULT 'roster';

ALTER TABLE public.attendance_final_results
  DROP CONSTRAINT IF EXISTS attendance_final_results_expected_events_check,
  DROP CONSTRAINT IF EXISTS attendance_final_results_absence_source_check;

ALTER TABLE public.attendance_final_results
  ADD CONSTRAINT attendance_final_results_expected_events_check CHECK (expected_events >= 0),
  ADD CONSTRAINT attendance_final_results_absence_source_check CHECK (
    absence_calculation_source IN ('roster', 'imported_fallback', 'unresolved_college')
  );

ALTER TABLE public.calculation_results
  DROP CONSTRAINT IF EXISTS calculation_results_status_check,
  DROP CONSTRAINT IF EXISTS calculation_results_expected_events_check,
  DROP CONSTRAINT IF EXISTS calculation_results_absence_source_check;

ALTER TABLE public.calculation_results
  ADD CONSTRAINT calculation_results_status_check CHECK (
    attendance_status IN ('perfect_attendance', 'with_absences', 'unresolved_college')
  ),
  ADD CONSTRAINT calculation_results_expected_events_check CHECK (expected_events >= 0),
  ADD CONSTRAINT calculation_results_absence_source_check CHECK (
    absence_calculation_source IN ('roster', 'imported_fallback', 'unresolved_college')
  );

CREATE INDEX IF NOT EXISTS idx_attendance_final_results_college_key
  ON public.attendance_final_results(school_year_id, college_key);

CREATE INDEX IF NOT EXISTS idx_calculation_results_college_key
  ON public.calculation_results(school_year_id, college_key);

WITH event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    COALESCE(ar.event_id, ai.event_id) AS event_id,
    NULLIF(
      TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')), '&', ' and ')),
        '[^a-z0-9]+', ' ', 'g'
      ), '[[:space:]]+', ' ', 'g')),
      ''
    ) AS college_key
  FROM attendance_records ar
  LEFT JOIN attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE ar.deleted_at IS NULL
    AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL

  UNION

  SELECT DISTINCT
    mar.school_year_id,
    mar.event_id,
    NULLIF(
      TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')), '&', ' and ')),
        '[^a-z0-9]+', ' ', 'g'
      ), '[[:space:]]+', ' ', 'g')),
      ''
    ) AS college_key
  FROM manual_attendance_records mar
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), student_college_candidates AS (
  SELECT DISTINCT
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS normalized_student_id,
    NULLIF(
      TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REPLACE(NULLIF(TRIM(ar.college), ''), '&', ' and ')),
        '[^a-z0-9]+', ' ', 'g'
      ), '[[:space:]]+', ' ', 'g')),
      ''
    ) AS college_key
  FROM attendance_records ar
  WHERE ar.deleted_at IS NULL

  UNION

  SELECT DISTINCT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS normalized_student_id,
    NULLIF(
      TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REPLACE(NULLIF(TRIM(mar.college), ''), '&', ' and ')),
        '[^a-z0-9]+', ' ', 'g'
      ), '[[:space:]]+', ' ', 'g')),
      ''
    ) AS college_key
  FROM manual_attendance_records mar
), student_college_totals AS (
  SELECT
    school_year_id,
    normalized_student_id,
    COUNT(DISTINCT college_key) FILTER (WHERE college_key IS NOT NULL)::INT AS college_key_count,
    MAX(college_key) FILTER (WHERE college_key IS NOT NULL) AS college_key
  FROM student_college_candidates
  GROUP BY school_year_id, normalized_student_id
), final_scope AS (
  SELECT
    afr.id,
    afr.school_year_id,
    LOWER(TRIM(afr.student_id)) AS normalized_student_id,
    CASE
      WHEN NULLIF(TRIM(s.college), '') IS NOT NULL THEN
        NULLIF(
          TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
            LOWER(REPLACE(NULLIF(TRIM(s.college), ''), '&', ' and ')),
            '[^a-z0-9]+', ' ', 'g'
          ), '[[:space:]]+', ' ', 'g')),
          ''
        )
      WHEN COALESCE(sct.college_key_count, 0) = 1 THEN sct.college_key
      ELSE NULL
    END AS college_key
  FROM attendance_final_results afr
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(afr.student_id))
  LEFT JOIN student_college_totals sct
    ON sct.school_year_id IS NOT DISTINCT FROM afr.school_year_id
   AND sct.normalized_student_id = LOWER(TRIM(afr.student_id))
), expected AS (
  SELECT school_year_id, college_key, COUNT(DISTINCT event_id)::INT AS expected_events
  FROM event_roster_scope
  WHERE college_key IS NOT NULL
  GROUP BY school_year_id, college_key
), participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS normalized_student_id,
    COALESCE(ar.event_id, ai.event_id) AS event_id
  FROM attendance_records ar
  LEFT JOIN attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  WHERE ar.deleted_at IS NULL
    AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL

  UNION

  SELECT DISTINCT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS normalized_student_id,
    mar.event_id
  FROM manual_attendance_records mar
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), attended AS (
  SELECT
    fs.id,
    COUNT(DISTINCT p.event_id)::INT AS attended_events
  FROM final_scope fs
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM fs.school_year_id
   AND roster.college_key = fs.college_key
  LEFT JOIN participation p
    ON p.school_year_id IS NOT DISTINCT FROM fs.school_year_id
   AND p.normalized_student_id = fs.normalized_student_id
   AND p.event_id = roster.event_id
  GROUP BY fs.id
), imported_absences AS (
  SELECT
    school_year_id,
    LOWER(TRIM(student_id)) AS normalized_student_id,
    GREATEST(0, MAX(COALESCE(no_of_absences, 0)))::INT AS imported_absences
  FROM attendance_records
  WHERE deleted_at IS NULL
  GROUP BY school_year_id, LOWER(TRIM(student_id))
), manual_absences AS (
  SELECT
    school_year_id,
    LOWER(TRIM(student_id)) AS normalized_student_id,
    GREATEST(0, SUM(COALESCE(no_of_absences, 0)))::INT AS manual_absences
  FROM manual_attendance_records
  GROUP BY school_year_id, LOWER(TRIM(student_id))
), derived AS (
  SELECT
    fs.id,
    fs.college_key,
    COALESCE(e.expected_events, 0)::INT AS expected_events,
    COALESCE(a.attended_events, 0)::INT AS attended_events,
    COALESCE(ia.imported_absences, 0)::INT AS imported_absences,
    COALESCE(ma.manual_absences, 0)::INT AS manual_absences
  FROM final_scope fs
  LEFT JOIN expected e
    ON e.school_year_id IS NOT DISTINCT FROM fs.school_year_id
   AND e.college_key = fs.college_key
  LEFT JOIN attended a ON a.id = fs.id
  LEFT JOIN imported_absences ia
    ON ia.school_year_id IS NOT DISTINCT FROM fs.school_year_id
   AND ia.normalized_student_id = fs.normalized_student_id
  LEFT JOIN manual_absences ma
    ON ma.school_year_id IS NOT DISTINCT FROM fs.school_year_id
   AND ma.normalized_student_id = fs.normalized_student_id
)
UPDATE attendance_final_results afr
SET
  college_key = d.college_key,
  expected_events = d.expected_events,
  attended_events = d.attended_events,
  total_absences = (
    CASE
      WHEN d.expected_events > 0 THEN GREATEST(d.expected_events - d.attended_events, 0)
      ELSE d.imported_absences
    END + d.manual_absences
  )::INT,
  absence_calculation_source = CASE
    WHEN d.college_key IS NULL THEN 'unresolved_college'
    WHEN d.expected_events > 0 THEN 'roster'
    ELSE 'imported_fallback'
  END,
  attendance_status = CASE
    WHEN d.college_key IS NULL THEN 'unresolved_college'
    WHEN d.expected_events > 0
      AND d.attended_events >= d.expected_events
      AND (GREATEST(d.expected_events - d.attended_events, 0) + d.manual_absences) <= 0
      THEN 'perfect_attendance'
    ELSE 'with_absences'
  END,
  updated_at = NOW()
FROM derived d
WHERE afr.id = d.id;

WITH event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    COALESCE(ar.event_id, ai.event_id) AS event_id,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
      LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')), '&', ' and ')),
      '[^a-z0-9]+', ' ', 'g'
    ), '[[:space:]]+', ' ', 'g')), '') AS college_key
  FROM attendance_records ar
  LEFT JOIN attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE ar.deleted_at IS NULL
    AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL

  UNION

  SELECT DISTINCT
    mar.school_year_id,
    mar.event_id,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
      LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')), '&', ' and ')),
      '[^a-z0-9]+', ' ', 'g'
    ), '[[:space:]]+', ' ', 'g')), '') AS college_key
  FROM manual_attendance_records mar
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), expected AS (
  SELECT school_year_id, college_key, COUNT(DISTINCT event_id)::INT AS expected_events
  FROM event_roster_scope
  WHERE college_key IS NOT NULL
  GROUP BY school_year_id, college_key
), participation AS (
  SELECT DISTINCT ar.school_year_id, LOWER(TRIM(ar.student_id)) AS normalized_student_id,
    COALESCE(ar.event_id, ai.event_id) AS event_id
  FROM attendance_records ar
  LEFT JOIN attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  WHERE ar.deleted_at IS NULL AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL
  UNION
  SELECT DISTINCT mar.school_year_id, LOWER(TRIM(mar.student_id)), mar.event_id
  FROM manual_attendance_records mar
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), imported_absences AS (
  SELECT school_year_id, LOWER(TRIM(student_id)) AS normalized_student_id,
    GREATEST(0, MAX(COALESCE(no_of_absences, 0)))::INT AS imported_absences
  FROM attendance_records
  WHERE deleted_at IS NULL
  GROUP BY school_year_id, LOWER(TRIM(student_id))
), manual_absences AS (
  SELECT school_year_id, LOWER(TRIM(student_id)) AS normalized_student_id,
    GREATEST(0, SUM(COALESCE(no_of_absences, 0)))::INT AS manual_absences
  FROM manual_attendance_records
  GROUP BY school_year_id, LOWER(TRIM(student_id))
), calc_scope AS (
  SELECT
    cr.id,
    cr.school_year_id,
    LOWER(TRIM(cr.student_id)) AS normalized_student_id,
    CASE
      WHEN NULLIF(TRIM(s.college), '') IS NOT NULL THEN
        NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
          LOWER(REPLACE(NULLIF(TRIM(s.college), ''), '&', ' and ')),
          '[^a-z0-9]+', ' ', 'g'
        ), '[[:space:]]+', ' ', 'g')), '')
      ELSE NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
        LOWER(REPLACE(NULLIF(TRIM(cr.college), ''), '&', ' and ')),
        '[^a-z0-9]+', ' ', 'g'
      ), '[[:space:]]+', ' ', 'g')), '')
    END AS college_key
  FROM calculation_results cr
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(cr.student_id))
), attended AS (
  SELECT cs.id, COUNT(DISTINCT p.event_id)::INT AS attended_events
  FROM calc_scope cs
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM cs.school_year_id
   AND roster.college_key = cs.college_key
  LEFT JOIN participation p
    ON p.school_year_id IS NOT DISTINCT FROM cs.school_year_id
   AND p.normalized_student_id = cs.normalized_student_id
   AND p.event_id = roster.event_id
  GROUP BY cs.id
), derived AS (
  SELECT
    cs.id,
    cs.college_key,
    COALESCE(e.expected_events, 0)::INT AS expected_events,
    COALESCE(a.attended_events, 0)::INT AS attended_events,
    COALESCE(ia.imported_absences, 0)::INT AS imported_absences,
    COALESCE(ma.manual_absences, 0)::INT AS manual_absences
  FROM calc_scope cs
  LEFT JOIN expected e
    ON e.school_year_id IS NOT DISTINCT FROM cs.school_year_id
   AND e.college_key = cs.college_key
  LEFT JOIN attended a ON a.id = cs.id
  LEFT JOIN imported_absences ia
    ON ia.school_year_id IS NOT DISTINCT FROM cs.school_year_id
   AND ia.normalized_student_id = cs.normalized_student_id
  LEFT JOIN manual_absences ma
    ON ma.school_year_id IS NOT DISTINCT FROM cs.school_year_id
   AND ma.normalized_student_id = cs.normalized_student_id
)
UPDATE calculation_results cr
SET
  college_key = d.college_key,
  expected_events = d.expected_events,
  attended_events = d.attended_events,
  imported_absences = CASE
    WHEN d.expected_events > 0 THEN GREATEST(d.expected_events - d.attended_events, 0)
    ELSE d.imported_absences
  END,
  manual_absences = d.manual_absences,
  total_absences = (
    CASE
      WHEN d.expected_events > 0 THEN GREATEST(d.expected_events - d.attended_events, 0)
      ELSE d.imported_absences
    END + d.manual_absences
  )::INT,
  absence_calculation_source = CASE
    WHEN d.college_key IS NULL THEN 'unresolved_college'
    WHEN d.expected_events > 0 THEN 'roster'
    ELSE 'imported_fallback'
  END,
  attendance_status = CASE
    WHEN d.college_key IS NULL THEN 'unresolved_college'
    WHEN d.expected_events > 0
      AND d.attended_events >= d.expected_events
      AND (GREATEST(d.expected_events - d.attended_events, 0) + d.manual_absences) <= 0
      THEN 'perfect_attendance'
    ELSE 'with_absences'
  END,
  updated_at = NOW()
FROM derived d
WHERE cr.id = d.id;

COMMIT;
