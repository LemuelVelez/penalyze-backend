SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

CREATE TEMP TABLE corrected_manual_event_absences ON COMMIT DROP AS
SELECT
  mar.id,
  mar.school_year_id,
  LOWER(TRIM(mar.student_id)) AS normalized_student_id,
  mar.no_of_absences AS previous_no_of_absences
FROM public.manual_attendance_records mar
WHERE mar.event_id IS NOT NULL
  AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
  AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <>
      LOWER('Zero attendance registration from landing page.')
  AND COALESCE(mar.no_of_absences, 0) <> 0;

UPDATE public.manual_attendance_records mar
SET
  no_of_absences = 0,
  updated_at = NOW()
FROM corrected_manual_event_absences corrected
WHERE mar.id = corrected.id;

ALTER TABLE public.manual_attendance_records
  DROP CONSTRAINT IF EXISTS manual_attendance_event_absences_zero_check;

ALTER TABLE public.manual_attendance_records
  ADD CONSTRAINT manual_attendance_event_absences_zero_check CHECK (
    event_id IS NULL
    OR attendance_type = 'zero_attendance'
    OR LOWER(TRIM(COALESCE(remarks, ''))) =
       LOWER('Zero attendance registration from landing page.')
    OR no_of_absences = 0
  );

CREATE TEMP TABLE corrected_attendance_final_results ON COMMIT DROP AS
WITH affected_students AS (
  SELECT DISTINCT
    school_year_id,
    normalized_student_id
  FROM corrected_manual_event_absences
), manual_absence_totals AS (
  SELECT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS normalized_student_id,
    GREATEST(0, SUM(COALESCE(mar.no_of_absences, 0)))::INT AS manual_absences
  FROM public.manual_attendance_records mar
  JOIN affected_students affected
    ON affected.school_year_id IS NOT DISTINCT FROM mar.school_year_id
   AND affected.normalized_student_id = LOWER(TRIM(mar.student_id))
  GROUP BY mar.school_year_id, LOWER(TRIM(mar.student_id))
)
SELECT
  afr.id,
  afr.school_year_id,
  afr.student_id,
  afr.name,
  (
    GREATEST(
      COALESCE(afr.expected_events, 0) - COALESCE(afr.attended_events, 0),
      0
    ) + COALESCE(manual.manual_absences, 0)
  )::INT AS total_absences,
  CASE
    WHEN afr.college_key IS NULL THEN 'unresolved_college'
    WHEN COALESCE(afr.expected_events, 0) > 0
      AND COALESCE(afr.attended_events, 0) >= COALESCE(afr.expected_events, 0)
      AND (
        GREATEST(
          COALESCE(afr.expected_events, 0) - COALESCE(afr.attended_events, 0),
          0
        ) + COALESCE(manual.manual_absences, 0)
      ) <= 0
      THEN 'perfect_attendance'
    ELSE 'with_absences'
  END AS attendance_status,
  CASE
    WHEN afr.college_key IS NULL THEN 'unresolved_college'
    ELSE 'roster'
  END AS absence_calculation_source
FROM public.attendance_final_results afr
JOIN affected_students affected
  ON affected.school_year_id IS NOT DISTINCT FROM afr.school_year_id
 AND affected.normalized_student_id = LOWER(TRIM(afr.student_id))
LEFT JOIN manual_absence_totals manual
  ON manual.school_year_id IS NOT DISTINCT FROM afr.school_year_id
 AND manual.normalized_student_id = LOWER(TRIM(afr.student_id))
WHERE afr.import_id IS NULL
  AND COALESCE(afr.expected_events, 0) > 0;

UPDATE public.attendance_final_results afr
SET
  total_absences = corrected.total_absences,
  attendance_status = corrected.attendance_status,
  absence_calculation_source = corrected.absence_calculation_source,
  source_updated_at = NOW(),
  updated_at = NOW()
FROM corrected_attendance_final_results corrected
WHERE afr.id = corrected.id
  AND (
    afr.total_absences,
    afr.attendance_status,
    afr.absence_calculation_source
  ) IS DISTINCT FROM (
    corrected.total_absences,
    corrected.attendance_status,
    corrected.absence_calculation_source
  );

DELETE FROM public.penalty_results pr
USING corrected_attendance_final_results corrected
WHERE corrected.total_absences <= 0
  AND pr.school_year_id IS NOT DISTINCT FROM corrected.school_year_id
  AND LOWER(TRIM(pr.student_id)) = LOWER(TRIM(corrected.student_id));

INSERT INTO public.penalty_results (
  school_year_id,
  student_id,
  name,
  no_of_absences,
  penalty_id,
  prescribed_penalty,
  status,
  source_table,
  source_record_id
)
SELECT
  corrected.school_year_id,
  corrected.student_id,
  corrected.name,
  corrected.total_absences,
  matched_penalty.id,
  COALESCE(
    matched_penalty.prescribed_penalty,
    'No prescribed penalty configured.'
  ),
  'unpaid',
  'attendance_final_results',
  corrected.id
FROM corrected_attendance_final_results corrected
LEFT JOIN LATERAL (
  SELECT p.id, p.prescribed_penalty
  FROM public.penalties p
  WHERE p.no_of_absences <= corrected.total_absences
  ORDER BY p.no_of_absences DESC, p.id DESC
  LIMIT 1
) matched_penalty ON corrected.total_absences > 0
WHERE corrected.total_absences > 0
ON CONFLICT (school_year_id, (LOWER(TRIM(student_id))))
DO UPDATE SET
  name = EXCLUDED.name,
  no_of_absences = EXCLUDED.no_of_absences,
  penalty_id = EXCLUDED.penalty_id,
  prescribed_penalty = EXCLUDED.prescribed_penalty,
  source_table = EXCLUDED.source_table,
  source_record_id = EXCLUDED.source_record_id,
  updated_at = NOW()
WHERE (
  penalty_results.student_id,
  penalty_results.name,
  penalty_results.no_of_absences,
  penalty_results.penalty_id,
  penalty_results.prescribed_penalty,
  penalty_results.source_table,
  penalty_results.source_record_id
) IS DISTINCT FROM (
  EXCLUDED.student_id,
  EXCLUDED.name,
  EXCLUDED.no_of_absences,
  EXCLUDED.penalty_id,
  EXCLUDED.prescribed_penalty,
  EXCLUDED.source_table,
  EXCLUDED.source_record_id
);
