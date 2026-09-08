-- Phase 5 read-only acceptance checks.
-- Run after migration 019 against the target PostgreSQL database.

WITH event_participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
), raw_event_rows AS (
  SELECT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    COUNT(*)::INT AS raw_rows,
    COUNT(DISTINCT ar.import_id)::INT AS import_count
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
  GROUP BY ar.school_year_id, ar.event_id, LOWER(TRIM(ar.student_id))
), multi_file_events AS (
  SELECT
    ar.school_year_id,
    ar.event_id,
    COUNT(DISTINCT ar.import_id)::INT AS import_count,
    COUNT(*)::INT AS raw_rows,
    COUNT(DISTINCT LOWER(TRIM(ar.student_id)))::INT AS union_attendees
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND ar.import_id IS NOT NULL
  GROUP BY ar.school_year_id, ar.event_id
  HAVING COUNT(DISTINCT ar.import_id) >= 2
), triple_file_students AS (
  SELECT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    COUNT(DISTINCT ar.import_id)::INT AS import_count,
    COUNT(*)::INT AS raw_rows
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND ar.import_id IS NOT NULL
  GROUP BY ar.school_year_id, ar.event_id, LOWER(TRIM(ar.student_id))
  HAVING COUNT(DISTINCT ar.import_id) >= 3
), year_level_variants AS (
  SELECT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    COUNT(DISTINCT COALESCE(NULLIF(TRIM(ar.year_level), ''), '<blank>'))::INT AS year_level_variants,
    COUNT(DISTINCT ar.no_of_absences)::INT AS absence_variants
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
  GROUP BY ar.school_year_id, ar.event_id, LOWER(TRIM(ar.student_id))
  HAVING COUNT(DISTINCT COALESCE(NULLIF(TRIM(ar.year_level), ''), '<blank>')) >= 2
)
SELECT 'multi_file_events' AS metric, COUNT(*)::BIGINT AS value FROM multi_file_events
UNION ALL
SELECT 'multi_file_union_attendees', COALESCE(SUM(union_attendees), 0)::BIGINT FROM multi_file_events
UNION ALL
SELECT 'multi_file_raw_rows', COALESCE(SUM(raw_rows), 0)::BIGINT FROM multi_file_events
UNION ALL
SELECT 'triple_file_student_event_candidates', COUNT(*)::BIGINT FROM triple_file_students
UNION ALL
SELECT 'triple_file_participation_rows', COUNT(*)::BIGINT
FROM triple_file_students triple
JOIN event_participation ep
  ON ep.school_year_id IS NOT DISTINCT FROM triple.school_year_id
 AND ep.event_id = triple.event_id
 AND ep.student_key = triple.student_key
UNION ALL
SELECT 'year_level_variant_candidates', COUNT(*)::BIGINT FROM year_level_variants
UNION ALL
SELECT 'year_level_variant_absence_mismatches', COUNT(*)::BIGINT
FROM year_level_variants
WHERE absence_variants <> 1
UNION ALL
SELECT 'duplicate_participation_keys', COUNT(*)::BIGINT
FROM (
  SELECT school_year_id, event_id, student_key, COUNT(*)
  FROM event_participation
  GROUP BY school_year_id, event_id, student_key
  HAVING COUNT(*) <> 1
) duplicates;

-- Detailed multi-file event numbers. attendees_count must equal union_attendees, not raw_rows.
SELECT
  ae.id AS event_id,
  ae.name AS event_name,
  mfe.school_year_id,
  mfe.import_count,
  mfe.raw_rows,
  mfe.union_attendees AS attendees_count
FROM (
  SELECT
    ar.school_year_id,
    ar.event_id,
    COUNT(DISTINCT ar.import_id)::INT AS import_count,
    COUNT(*)::INT AS raw_rows,
    COUNT(DISTINCT LOWER(TRIM(ar.student_id)))::INT AS union_attendees
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND ar.import_id IS NOT NULL
  GROUP BY ar.school_year_id, ar.event_id
  HAVING COUNT(DISTINCT ar.import_id) >= 2
) mfe
JOIN public.attendance_events ae ON ae.id = mfe.event_id
ORDER BY mfe.import_count DESC, ae.name, ae.id;

-- A student present in three or more imports for one event must still have one participation key.
SELECT
  ae.name AS event_name,
  triple.student_key,
  triple.import_count,
  triple.raw_rows,
  1::INT AS deduplicated_participation_count
FROM (
  SELECT
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    COUNT(DISTINCT ar.import_id)::INT AS import_count,
    COUNT(*)::INT AS raw_rows
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND ar.import_id IS NOT NULL
  GROUP BY ar.event_id, LOWER(TRIM(ar.student_id))
  HAVING COUNT(DISTINCT ar.import_id) >= 3
) triple
JOIN public.attendance_events ae ON ae.id = triple.event_id
ORDER BY triple.import_count DESC, ae.name, triple.student_key;

-- Year-level differences must not create multiple absence totals for the same student/event.
SELECT
  ae.name AS event_name,
  variant.student_key,
  variant.year_levels,
  variant.absence_totals,
  CARDINALITY(variant.absence_totals) AS distinct_absence_totals
FROM (
  SELECT
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    ARRAY_AGG(DISTINCT COALESCE(NULLIF(TRIM(ar.year_level), ''), '<blank>')) AS year_levels,
    ARRAY_AGG(DISTINCT ar.no_of_absences ORDER BY ar.no_of_absences) AS absence_totals
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
  GROUP BY ar.event_id, LOWER(TRIM(ar.student_id))
  HAVING COUNT(DISTINCT COALESCE(NULLIF(TRIM(ar.year_level), ''), '<blank>')) >= 2
) variant
JOIN public.attendance_events ae ON ae.id = variant.event_id
ORDER BY ae.name, variant.student_key;

-- Cross-page equality for the saved school-year calculation scope.
-- A returned row is a discrepancy and must be investigated.
WITH attendance_page AS (
  SELECT
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    MAX(ar.no_of_absences)::INT AS total_absences
  FROM public.attendance_records ar
  GROUP BY ar.school_year_id, LOWER(TRIM(ar.student_id))
), calculate_page AS (
  SELECT
    cr.school_year_id,
    LOWER(TRIM(cr.student_id)) AS student_key,
    cr.total_absences::INT
  FROM public.calculation_results cr
  WHERE cr.calculation_scope_key = 'school_year'
), final_page AS (
  SELECT
    afr.school_year_id,
    LOWER(TRIM(afr.student_id)) AS student_key,
    afr.total_absences::INT
  FROM public.attendance_final_results afr
), fines_page AS (
  SELECT
    f.school_year_id,
    LOWER(TRIM(f.student_id)) AS student_key,
    MAX(COALESCE(ar.no_of_absences, 0))::INT AS total_absences
  FROM public.fines f
  LEFT JOIN public.attendance_records ar ON ar.id = f.attendance_record_id
  GROUP BY f.school_year_id, LOWER(TRIM(f.student_id))
), keys AS (
  SELECT school_year_id, student_key FROM attendance_page
  UNION
  SELECT school_year_id, student_key FROM calculate_page
  UNION
  SELECT school_year_id, student_key FROM final_page
)
SELECT
  keys.school_year_id,
  keys.student_key,
  attendance.total_absences AS attendance_page_absences,
  calculation.total_absences AS calculate_page_absences,
  final.total_absences AS final_results_absences,
  fines.total_absences AS fines_page_absences
FROM keys
LEFT JOIN attendance_page attendance
  ON attendance.school_year_id IS NOT DISTINCT FROM keys.school_year_id
 AND attendance.student_key = keys.student_key
LEFT JOIN calculate_page calculation
  ON calculation.school_year_id IS NOT DISTINCT FROM keys.school_year_id
 AND calculation.student_key = keys.student_key
LEFT JOIN final_page final
  ON final.school_year_id IS NOT DISTINCT FROM keys.school_year_id
 AND final.student_key = keys.student_key
LEFT JOIN fines_page fines
  ON fines.school_year_id IS NOT DISTINCT FROM keys.school_year_id
 AND fines.student_key = keys.student_key
WHERE calculation.total_absences IS NOT NULL
  AND (
    attendance.total_absences IS DISTINCT FROM calculation.total_absences
    OR final.total_absences IS DISTINCT FROM calculation.total_absences
    OR (
      calculation.total_absences > 0
      AND fines.total_absences IS DISTINCT FROM calculation.total_absences
    )
  )
ORDER BY keys.school_year_id, keys.student_key;

-- Bounds check for imported attendance rows under the event-roster college rule.
-- A returned row violates the requested 0 <= absences <= expected events invariant.
WITH event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(s.college), '')
        FROM public.students s
        WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(ar.college), ''),
      ''
    ))) AS college_key
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
), record_expected AS (
  SELECT
    ar.id,
    ar.student_id,
    ar.no_of_absences,
    COUNT(DISTINCT roster.event_id)::INT AS expected_events
  FROM public.attendance_records ar
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM ar.school_year_id
   AND roster.college_key = LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(s.college), '')
        FROM public.students s
        WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(ar.college), ''),
      ''
    )))
  GROUP BY ar.id, ar.student_id, ar.no_of_absences
)
SELECT *
FROM record_expected
WHERE no_of_absences < 0
   OR no_of_absences > expected_events
ORDER BY student_id, id;
