BEGIN;

SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

CREATE OR REPLACE FUNCTION pg_temp.phase019_college_key(
  p_student_id TEXT,
  p_record_college TEXT
)
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $$
  SELECT LOWER(TRIM(COALESCE(
    (
      SELECT NULLIF(TRIM(s.college), '')
      FROM public.students s
      WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(p_student_id))
      LIMIT 1
    ),
    NULLIF(TRIM(p_record_college), ''),
    ''
  )));
$$;

CREATE OR REPLACE FUNCTION pg_temp.phase019_event_key(
  p_event_id UUID,
  p_event_name TEXT
)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT COALESCE(
    p_event_id::TEXT,
    NULLIF(
      LOWER(
        REGEXP_REPLACE(
          TRIM(p_event_name),
          '[[:space:]]+',
          ' ',
          'g'
        )
      ),
      ''
    )
  );
$$;

DROP TABLE IF EXISTS pg_temp.phase019_absence_targets;
CREATE TEMP TABLE phase019_absence_targets ON COMMIT DROP AS
WITH event_participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS normalized_student_id
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND NULLIF(TRIM(ar.student_id), '') IS NOT NULL
),
event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
),
student_scope AS (
  SELECT DISTINCT
    LOWER(TRIM(ar.student_id)) AS student_key,
    ar.school_year_id,
    pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key
  FROM public.attendance_records ar
  WHERE NULLIF(TRIM(ar.student_id), '') IS NOT NULL
),
student_absences AS (
  SELECT
    ss.student_key,
    ss.college_key,
    ss.school_year_id,
    COUNT(DISTINCT roster.event_id)::INT AS expected_events,
    COUNT(DISTINCT attended.event_id)::INT AS attended_events,
    GREATEST(
      COUNT(DISTINCT roster.event_id)::INT -
        COUNT(DISTINCT attended.event_id)::INT,
      0
    ) AS no_of_absences
  FROM student_scope ss
  LEFT JOIN event_roster_scope roster
    ON roster.college_key = ss.college_key
   AND roster.school_year_id IS NOT DISTINCT FROM ss.school_year_id
  LEFT JOIN event_participation attended
    ON attended.normalized_student_id = ss.student_key
   AND attended.event_id = roster.event_id
   AND attended.school_year_id IS NOT DISTINCT FROM ss.school_year_id
  GROUP BY ss.student_key, ss.college_key, ss.school_year_id
)
SELECT
  ar.id,
  ar.school_year_id,
  ar.student_id,
  ar.name,
  pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key,
  COALESCE(ar.no_of_absences, 0)::INT AS old_no_of_absences,
  sa.no_of_absences::INT AS new_no_of_absences,
  sa.expected_events::INT,
  sa.attended_events::INT
FROM public.attendance_records ar
JOIN student_absences sa
  ON LOWER(TRIM(ar.student_id)) = sa.student_key
 AND pg_temp.phase019_college_key(ar.student_id, ar.college) = sa.college_key
 AND ar.school_year_id IS NOT DISTINCT FROM sa.school_year_id;

UPDATE public.attendance_records ar
SET no_of_absences = target.new_no_of_absences,
    updated_at = CASE
      WHEN ar.no_of_absences IS DISTINCT FROM target.new_no_of_absences THEN NOW()
      ELSE ar.updated_at
    END
FROM pg_temp.phase019_absence_targets target
WHERE ar.id = target.id;

DO $$
DECLARE
  changed_count INTEGER;
  changed_more_than_one_count INTEGER;
  changed_row RECORD;
BEGIN
  SELECT COUNT(*)::INT
  INTO changed_count
  FROM pg_temp.phase019_absence_targets
  WHERE old_no_of_absences IS DISTINCT FROM new_no_of_absences;

  SELECT COUNT(*)::INT
  INTO changed_more_than_one_count
  FROM pg_temp.phase019_absence_targets
  WHERE ABS(old_no_of_absences - new_no_of_absences) > 1;

  RAISE NOTICE 'Phase 019 recomputed attendance_records: % changed row(s), % changed by more than one absence.',
    changed_count,
    changed_more_than_one_count;

  FOR changed_row IN
    SELECT
      id,
      student_id,
      school_year_id,
      college_key,
      old_no_of_absences,
      new_no_of_absences,
      expected_events,
      attended_events
    FROM pg_temp.phase019_absence_targets
    WHERE ABS(old_no_of_absences - new_no_of_absences) > 1
    ORDER BY student_id, school_year_id, id
  LOOP
    RAISE NOTICE 'Phase 019 >1 change: record_id=%, student_id=%, school_year_id=%, college=%, old=%, new=%, expected=%, attended=%',
      changed_row.id,
      changed_row.student_id,
      changed_row.school_year_id,
      changed_row.college_key,
      changed_row.old_no_of_absences,
      changed_row.new_no_of_absences,
      changed_row.expected_events,
      changed_row.attended_events;
  END LOOP;
END $$;

-- Preserve the most recently updated fine status per regular event-roster scope.
DROP TABLE IF EXISTS pg_temp.phase019_regular_fine_status;
CREATE TEMP TABLE phase019_regular_fine_status ON COMMIT DROP AS
SELECT DISTINCT ON (
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)),
  pg_temp.phase019_college_key(ar.student_id, ar.college)
)
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)) AS student_key,
  pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key,
  f.status,
  f.created_at
FROM public.fines f
JOIN public.attendance_records ar ON ar.id = f.attendance_record_id
WHERE ar.event_id IS NOT NULL
ORDER BY
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)),
  pg_temp.phase019_college_key(ar.student_id, ar.college),
  f.updated_at DESC,
  f.created_at DESC,
  f.id DESC;

DELETE FROM public.fines f
USING public.attendance_records ar
WHERE ar.id = f.attendance_record_id
  AND ar.event_id IS NOT NULL;

WITH ranked_regular_records AS (
  SELECT
    ar.*,
    pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key,
    ROW_NUMBER() OVER (
      PARTITION BY
        ar.school_year_id,
        LOWER(TRIM(ar.student_id)),
        pg_temp.phase019_college_key(ar.student_id, ar.college)
      ORDER BY
        COALESCE(ar.scanned_at, ar.created_at) DESC,
        ar.created_at DESC,
        ar.id DESC
    ) AS anchor_rank
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND COALESCE(ar.no_of_absences, 0) > 0
), regular_anchors AS (
  SELECT *
  FROM ranked_regular_records
  WHERE anchor_rank = 1
), matched AS (
  SELECT
    anchor.*,
    penalty.id AS penalty_id,
    COALESCE(
      penalty.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty,
    COALESCE(status.status, 'unpaid') AS status,
    status.created_at AS preserved_created_at
  FROM regular_anchors anchor
  LEFT JOIN LATERAL (
    SELECT p.id, p.prescribed_penalty
    FROM public.penalties p
    WHERE p.no_of_absences <= anchor.no_of_absences
    ORDER BY p.no_of_absences DESC
    LIMIT 1
  ) penalty ON TRUE
  LEFT JOIN pg_temp.phase019_regular_fine_status status
    ON status.school_year_id IS NOT DISTINCT FROM anchor.school_year_id
   AND status.student_key = LOWER(TRIM(anchor.student_id))
   AND status.college_key = anchor.college_key
)
INSERT INTO public.fines (
  school_year_id,
  attendance_record_id,
  penalty_id,
  student_id,
  name,
  prescribed_penalty,
  status,
  created_at,
  updated_at
)
SELECT
  matched.school_year_id,
  matched.id,
  matched.penalty_id,
  matched.student_id,
  matched.name,
  matched.prescribed_penalty,
  matched.status,
  COALESCE(matched.preserved_created_at, NOW()),
  NOW()
FROM matched;

-- Keep non-event fines (including zero-attendance records) aligned with their record.
DELETE FROM public.fines f
USING public.attendance_records ar
WHERE ar.id = f.attendance_record_id
  AND ar.event_id IS NULL
  AND COALESCE(ar.no_of_absences, 0) <= 0;

WITH non_event_fine_updates AS (
  SELECT
    f.id AS fine_id,
    ar.school_year_id,
    ar.student_id,
    ar.name,
    penalty.id AS penalty_id,
    COALESCE(
      penalty.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty
  FROM public.fines f
  JOIN public.attendance_records ar ON ar.id = f.attendance_record_id
  LEFT JOIN LATERAL (
    SELECT p.id, p.prescribed_penalty
    FROM public.penalties p
    WHERE p.no_of_absences <= ar.no_of_absences
    ORDER BY p.no_of_absences DESC
    LIMIT 1
  ) penalty ON COALESCE(ar.no_of_absences, 0) > 0
  WHERE ar.event_id IS NULL
    AND COALESCE(ar.no_of_absences, 0) > 0
)
UPDATE public.fines f
SET school_year_id = update_row.school_year_id,
    penalty_id = update_row.penalty_id,
    student_id = update_row.student_id,
    name = update_row.name,
    prescribed_penalty = update_row.prescribed_penalty,
    updated_at = NOW()
FROM non_event_fine_updates update_row
WHERE f.id = update_row.fine_id;

WITH zero_attendance_records AS (
  SELECT ar.*
  FROM public.attendance_records ar
  WHERE ar.event_id IS NULL
    AND COALESCE(ar.no_of_absences, 0) > 0
    AND LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
    AND NOT EXISTS (
      SELECT 1
      FROM public.fines f
      WHERE f.attendance_record_id = ar.id
    )
), matched AS (
  SELECT
    ar.*,
    penalty.id AS penalty_id,
    COALESCE(
      penalty.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty
  FROM zero_attendance_records ar
  LEFT JOIN LATERAL (
    SELECT p.id, p.prescribed_penalty
    FROM public.penalties p
    WHERE p.no_of_absences <= ar.no_of_absences
    ORDER BY p.no_of_absences DESC
    LIMIT 1
  ) penalty ON TRUE
)
INSERT INTO public.fines (
  school_year_id,
  attendance_record_id,
  penalty_id,
  student_id,
  name,
  prescribed_penalty,
  status
)
SELECT
  matched.school_year_id,
  matched.id,
  matched.penalty_id,
  matched.student_id,
  matched.name,
  matched.prescribed_penalty,
  'unpaid'
FROM matched;

-- Rebuild final attendance results from the new event-participation and event-roster rules.
DELETE FROM public.attendance_final_results;

WITH event_participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS normalized_student_id
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND NULLIF(TRIM(ar.student_id), '') IS NOT NULL
),
event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
),
imported_records AS (
  SELECT
    ar.school_year_id,
    ar.student_id,
    COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(ar.name), ''), ar.student_id) AS name,
    COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(ar.year_level), '')) AS year_level,
    COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')) AS college,
    COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(ar.program), '')) AS program,
    COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(ar.institution), '')) AS institution,
    CASE
      WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.') THEN NULL
      ELSE pg_temp.phase019_event_key(ar.event_id, ae.name)
    END AS event_key,
    GREATEST(0, COALESCE(ar.no_of_absences, 0))::INT AS no_of_absences,
    COALESCE(ar.scanned_at, ar.created_at) AS scanned_at,
    ar.updated_at
  FROM public.attendance_records ar
  LEFT JOIN public.attendance_events ae ON ae.id = ar.event_id
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
),
imported_totals AS (
  SELECT
    school_year_id,
    LOWER(TRIM(student_id)) AS normalized_student_id,
    MAX(student_id) AS student_id,
    COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
    COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
    COALESCE(NULLIF(MAX(college), ''), '') AS college,
    COALESCE(NULLIF(MAX(program), ''), '') AS program,
    COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
    COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events,
    GREATEST(0, MAX(no_of_absences))::INT AS imported_absences,
    COUNT(*)::INT AS imported_record_count,
    MAX(scanned_at) AS latest_scanned_at,
    MAX(updated_at) AS source_updated_at
  FROM imported_records
  GROUP BY school_year_id, LOWER(TRIM(student_id))
),
manual_records AS (
  SELECT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS normalized_student_id,
    mar.student_id,
    COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(mar.name), ''), mar.student_id) AS name,
    COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(mar.year_level), '')) AS year_level,
    COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')) AS college,
    COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(mar.program), '')) AS program,
    COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(mar.institution), '')) AS institution,
    CASE
      WHEN (
        mar.attendance_type = 'zero_attendance'
        OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      ) THEN NULL
      ELSE pg_temp.phase019_event_key(mar.event_id, ae.name)
    END AS event_key,
    GREATEST(0, COALESCE(mar.no_of_absences, 0))::INT AS no_of_absences,
    COALESCE(mar.scanned_at, mar.created_at) AS scanned_at,
    mar.updated_at
  FROM public.manual_attendance_records mar
  LEFT JOIN public.attendance_events ae ON ae.id = mar.event_id
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
),
manual_totals AS (
  SELECT
    school_year_id,
    normalized_student_id,
    MAX(student_id) AS student_id,
    COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
    COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
    COALESCE(NULLIF(MAX(college), ''), '') AS college,
    COALESCE(NULLIF(MAX(program), ''), '') AS program,
    COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
    GREATEST(0, SUM(no_of_absences))::INT AS manual_absences,
    COUNT(*)::INT AS manual_record_count,
    MAX(scanned_at) AS latest_scanned_at,
    MAX(updated_at) AS source_updated_at
  FROM manual_records
  GROUP BY school_year_id, normalized_student_id
),
imported_event_scope AS (
  SELECT DISTINCT school_year_id, event_key
  FROM imported_records
  WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
),
imported_event_participation AS (
  SELECT
    ep.school_year_id,
    ep.normalized_student_id,
    ep.event_id::TEXT AS event_key
  FROM event_participation ep
  JOIN imported_event_scope scope
    ON scope.school_year_id IS NOT DISTINCT FROM ep.school_year_id
   AND scope.event_key = ep.event_id::TEXT
),
event_attendance AS (
  SELECT school_year_id, normalized_student_id, event_key
  FROM imported_event_participation
  UNION
  SELECT school_year_id, normalized_student_id, event_key
  FROM manual_records
  WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
),
attended_event_totals AS (
  SELECT
    school_year_id,
    normalized_student_id,
    COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events
  FROM event_attendance
  GROUP BY school_year_id, normalized_student_id
),
student_keys AS (
  SELECT school_year_id, normalized_student_id FROM imported_totals
  UNION
  SELECT school_year_id, normalized_student_id FROM manual_totals
),
student_event_scope AS (
  SELECT
    keys.school_year_id,
    keys.normalized_student_id,
    LOWER(TRIM(COALESCE(
      NULLIF(imported.college, ''),
      NULLIF(manual.college, ''),
      ''
    ))) AS college_key
  FROM student_keys keys
  LEFT JOIN imported_totals imported
    ON imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND imported.normalized_student_id = keys.normalized_student_id
  LEFT JOIN manual_totals manual
    ON manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND manual.normalized_student_id = keys.normalized_student_id
),
expected_event_totals AS (
  SELECT
    student.school_year_id,
    student.normalized_student_id,
    COUNT(DISTINCT roster.event_id)::INT AS expected_events
  FROM student_event_scope student
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND roster.college_key = student.college_key
  GROUP BY student.school_year_id, student.normalized_student_id
),
expected_attended_event_totals AS (
  SELECT
    student.school_year_id,
    student.normalized_student_id,
    COUNT(DISTINCT attended.event_key)::INT AS attended_expected_events
  FROM student_event_scope student
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND roster.college_key = student.college_key
  LEFT JOIN event_attendance attended
    ON attended.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND attended.normalized_student_id = student.normalized_student_id
   AND attended.event_key = roster.event_id::TEXT
  GROUP BY student.school_year_id, student.normalized_student_id
),
merged AS (
  SELECT
    keys.school_year_id,
    COALESCE(imported.student_id, manual.student_id, keys.normalized_student_id) AS student_id,
    COALESCE(imported.name, manual.name, keys.normalized_student_id) AS name,
    COALESCE(imported.year_level, manual.year_level, '') AS year_level,
    COALESCE(imported.college, manual.college, '') AS college,
    COALESCE(imported.program, manual.program, '') AS program,
    COALESCE(imported.institution, manual.institution, '') AS institution,
    COALESCE(attended.attended_events, 0)::INT AS attended_events,
    (
      GREATEST(
        COALESCE(imported.imported_absences, 0),
        GREATEST(
          COALESCE(expected.expected_events, 0) -
            COALESCE(expected_attended.attended_expected_events, 0),
          0
        )
      ) + COALESCE(manual.manual_absences, 0)
    )::INT AS total_absences,
    GREATEST(
      COALESCE(imported.latest_scanned_at, '-infinity'::timestamptz),
      COALESCE(manual.latest_scanned_at, '-infinity'::timestamptz)
    ) AS latest_scanned_at,
    GREATEST(
      COALESCE(imported.source_updated_at, '-infinity'::timestamptz),
      COALESCE(manual.source_updated_at, '-infinity'::timestamptz)
    ) AS source_updated_at
  FROM student_keys keys
  LEFT JOIN imported_totals imported
    ON imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND imported.normalized_student_id = keys.normalized_student_id
  LEFT JOIN manual_totals manual
    ON manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND manual.normalized_student_id = keys.normalized_student_id
  LEFT JOIN attended_event_totals attended
    ON attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND attended.normalized_student_id = keys.normalized_student_id
  LEFT JOIN expected_event_totals expected
    ON expected.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND expected.normalized_student_id = keys.normalized_student_id
  LEFT JOIN expected_attended_event_totals expected_attended
    ON expected_attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND expected_attended.normalized_student_id = keys.normalized_student_id
)
INSERT INTO public.attendance_final_results (
  school_year_id,
  import_id,
  student_id,
  name,
  year_level,
  college,
  program,
  institution,
  attended_events,
  total_absences,
  attendance_status,
  latest_scanned_at,
  source_updated_at
)
SELECT
  school_year_id,
  NULL::UUID,
  student_id,
  name,
  NULLIF(year_level, ''),
  NULLIF(college, ''),
  NULLIF(program, ''),
  NULLIF(institution, ''),
  attended_events,
  total_absences,
  CASE
    WHEN total_absences <= 0 THEN 'perfect_attendance'
    ELSE 'with_absences'
  END,
  NULLIF(latest_scanned_at, '-infinity'::timestamptz),
  NULLIF(source_updated_at, '-infinity'::timestamptz)
FROM merged;

-- Snapshot every saved calculation scope before rebuilding calculation_results.
DROP TABLE IF EXISTS pg_temp.phase019_calculation_scopes;
CREATE TEMP TABLE phase019_calculation_scopes ON COMMIT DROP AS
WITH distinct_scopes AS (
  SELECT DISTINCT
    cr.school_year_id,
    cr.calculation_scope_key
  FROM public.calculation_results cr
), parsed AS (
  SELECT
    school_year_id,
    calculation_scope_key,
    CASE
      WHEN calculation_scope_key IN ('school_year', 'all_imports')
        THEN 'imported,manual,zero_attendance'
      ELSE REPLACE(SPLIT_PART(calculation_scope_key, '|', 1), 'sources:', '')
    END AS source_token,
    CASE
      WHEN calculation_scope_key IN ('school_year', 'all_imports')
        THEN 'all'
      ELSE REPLACE(SPLIT_PART(calculation_scope_key, '|', 2), 'imports:', '')
    END AS import_token
  FROM distinct_scopes
)
SELECT
  school_year_id,
  calculation_scope_key,
  CASE
    WHEN import_token = 'all' OR NULLIF(TRIM(import_token), '') IS NULL
      THEN ARRAY[]::TEXT[]
    ELSE STRING_TO_ARRAY(import_token, ',')
  END AS selected_import_ids,
  'imported' = ANY(STRING_TO_ARRAY(source_token, ',')) AS include_imported,
  'manual' = ANY(STRING_TO_ARRAY(source_token, ',')) AS include_manual,
  'zero_attendance' = ANY(STRING_TO_ARRAY(source_token, ',')) AS include_zero_attendance
FROM parsed;

DELETE FROM public.calculation_results;

WITH event_participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS normalized_student_id
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
    AND NULLIF(TRIM(ar.student_id), '') IS NOT NULL
),
event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    pg_temp.phase019_college_key(ar.student_id, ar.college) AS college_key
  FROM public.attendance_records ar
  WHERE ar.event_id IS NOT NULL
),
imported_records AS (
  SELECT
    scope.calculation_scope_key,
    scope.school_year_id AS scope_school_year_id,
    ar.school_year_id,
    ar.import_id,
    ar.student_id,
    COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(ar.name), ''), ar.student_id) AS name,
    COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(ar.year_level), '')) AS year_level,
    COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')) AS college,
    COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(ar.program), '')) AS program,
    COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(ar.institution), '')) AS institution,
    CASE
      WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.') THEN NULL
      ELSE pg_temp.phase019_event_key(ar.event_id, ae.name)
    END AS event_key,
    GREATEST(0, COALESCE(ar.no_of_absences, 0))::INT AS no_of_absences,
    COALESCE(ar.scanned_at, ar.created_at) AS scanned_at,
    ar.updated_at
  FROM pg_temp.phase019_calculation_scopes scope
  JOIN public.attendance_records ar
    ON ar.school_year_id IS NOT DISTINCT FROM scope.school_year_id
  LEFT JOIN public.attendance_events ae ON ae.id = ar.event_id
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE (
      (
        scope.include_imported
        AND ar.import_id IS NOT NULL
        AND (
          CARDINALITY(scope.selected_import_ids) = 0
          OR ar.import_id::TEXT = ANY(scope.selected_import_ids)
        )
      )
      OR (
        scope.include_zero_attendance
        AND LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      )
    )
),
imported_totals AS (
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    LOWER(TRIM(student_id)) AS normalized_student_id,
    MAX(student_id) AS student_id,
    MAX(name) AS name,
    MAX(year_level) AS year_level,
    MAX(college) AS college,
    MAX(program) AS program,
    MAX(institution) AS institution,
    ARRAY_AGG(DISTINCT import_id) FILTER (WHERE import_id IS NOT NULL) AS import_ids,
    COUNT(DISTINCT event_key)::INT AS attended_events,
    GREATEST(0, MAX(no_of_absences))::INT AS imported_absences,
    COUNT(*)::INT AS imported_record_count,
    MAX(scanned_at) AS latest_scanned_at,
    MAX(updated_at) AS source_updated_at
  FROM imported_records
  GROUP BY
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    LOWER(TRIM(student_id))
),
manual_records AS (
  SELECT
    scope.calculation_scope_key,
    scope.school_year_id AS scope_school_year_id,
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS normalized_student_id,
    mar.student_id,
    COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(mar.name), ''), mar.student_id) AS name,
    COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(mar.year_level), '')) AS year_level,
    COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')) AS college,
    COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(mar.program), '')) AS program,
    COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(mar.institution), '')) AS institution,
    CASE
      WHEN (
        mar.attendance_type = 'zero_attendance'
        OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
      ) THEN NULL
      ELSE pg_temp.phase019_event_key(mar.event_id, ae.name)
    END AS event_key,
    GREATEST(0, COALESCE(mar.no_of_absences, 0))::INT AS no_of_absences,
    COALESCE(mar.scanned_at, mar.created_at) AS scanned_at,
    mar.updated_at
  FROM pg_temp.phase019_calculation_scopes scope
  JOIN public.manual_attendance_records mar
    ON mar.school_year_id IS NOT DISTINCT FROM scope.school_year_id
  LEFT JOIN public.attendance_events ae ON ae.id = mar.event_id
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
  WHERE (
      (
        scope.include_manual
        AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
        AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
      )
      OR (
        scope.include_zero_attendance
        AND (
          mar.attendance_type = 'zero_attendance'
          OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER('Zero attendance registration from landing page.')
        )
      )
    )
),
manual_totals AS (
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id,
    MAX(student_id) AS student_id,
    COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
    COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
    COALESCE(NULLIF(MAX(college), ''), '') AS college,
    COALESCE(NULLIF(MAX(program), ''), '') AS program,
    COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
    GREATEST(0, SUM(no_of_absences))::INT AS manual_absences,
    COUNT(*)::INT AS manual_record_count,
    MAX(scanned_at) AS latest_scanned_at,
    MAX(updated_at) AS source_updated_at
  FROM manual_records
  GROUP BY
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id
),
imported_event_scope AS (
  SELECT DISTINCT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    event_key
  FROM imported_records
  WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
),
imported_event_roster_scope AS (
  SELECT DISTINCT
    scope.calculation_scope_key,
    scope.scope_school_year_id,
    roster.school_year_id,
    roster.event_id,
    roster.college_key
  FROM event_roster_scope roster
  JOIN imported_event_scope scope
    ON scope.school_year_id IS NOT DISTINCT FROM roster.school_year_id
   AND scope.event_key = roster.event_id::TEXT
),
imported_event_participation AS (
  SELECT
    scope.calculation_scope_key,
    scope.scope_school_year_id,
    ep.school_year_id,
    ep.normalized_student_id,
    ep.event_id::TEXT AS event_key
  FROM event_participation ep
  JOIN imported_event_scope scope
    ON scope.school_year_id IS NOT DISTINCT FROM ep.school_year_id
   AND scope.event_key = ep.event_id::TEXT
),
event_attendance AS (
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id,
    event_key
  FROM imported_event_participation
  UNION
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id,
    event_key
  FROM manual_records
  WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
),
attended_event_totals AS (
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id,
    COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events
  FROM event_attendance
  GROUP BY
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id
),
student_keys AS (
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id
  FROM imported_totals
  UNION
  SELECT
    calculation_scope_key,
    scope_school_year_id,
    school_year_id,
    normalized_student_id
  FROM manual_totals
),
student_event_scope AS (
  SELECT
    keys.calculation_scope_key,
    keys.scope_school_year_id,
    keys.school_year_id,
    keys.normalized_student_id,
    LOWER(TRIM(COALESCE(
      NULLIF(imported.college, ''),
      NULLIF(manual.college, ''),
      ''
    ))) AS college_key
  FROM student_keys keys
  LEFT JOIN imported_totals imported
    ON imported.calculation_scope_key = keys.calculation_scope_key
   AND imported.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND imported.normalized_student_id = keys.normalized_student_id
  LEFT JOIN manual_totals manual
    ON manual.calculation_scope_key = keys.calculation_scope_key
   AND manual.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND manual.normalized_student_id = keys.normalized_student_id
),
expected_event_totals AS (
  SELECT
    student.calculation_scope_key,
    student.scope_school_year_id,
    student.school_year_id,
    student.normalized_student_id,
    COUNT(DISTINCT roster.event_id)::INT AS expected_events
  FROM student_event_scope student
  LEFT JOIN imported_event_roster_scope roster
    ON roster.calculation_scope_key = student.calculation_scope_key
   AND roster.scope_school_year_id IS NOT DISTINCT FROM student.scope_school_year_id
   AND roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND roster.college_key = student.college_key
  GROUP BY
    student.calculation_scope_key,
    student.scope_school_year_id,
    student.school_year_id,
    student.normalized_student_id
),
expected_attended_event_totals AS (
  SELECT
    student.calculation_scope_key,
    student.scope_school_year_id,
    student.school_year_id,
    student.normalized_student_id,
    COUNT(DISTINCT attended.event_key)::INT AS attended_expected_events
  FROM student_event_scope student
  LEFT JOIN imported_event_roster_scope roster
    ON roster.calculation_scope_key = student.calculation_scope_key
   AND roster.scope_school_year_id IS NOT DISTINCT FROM student.scope_school_year_id
   AND roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND roster.college_key = student.college_key
  LEFT JOIN event_attendance attended
    ON attended.calculation_scope_key = student.calculation_scope_key
   AND attended.scope_school_year_id IS NOT DISTINCT FROM student.scope_school_year_id
   AND attended.school_year_id IS NOT DISTINCT FROM student.school_year_id
   AND attended.normalized_student_id = student.normalized_student_id
   AND attended.event_key = roster.event_id::TEXT
  GROUP BY
    student.calculation_scope_key,
    student.scope_school_year_id,
    student.school_year_id,
    student.normalized_student_id
),
merged AS (
  SELECT
    keys.school_year_id,
    keys.calculation_scope_key,
    COALESCE(imported.import_ids, ARRAY[]::UUID[]) AS import_ids,
    COALESCE(imported.student_id, manual.student_id, keys.normalized_student_id) AS student_id,
    COALESCE(imported.name, manual.name, keys.normalized_student_id) AS name,
    COALESCE(imported.year_level, manual.year_level) AS year_level,
    COALESCE(imported.college, manual.college) AS college,
    COALESCE(imported.program, manual.program) AS program,
    COALESCE(imported.institution, manual.institution) AS institution,
    COALESCE(attended.attended_events, 0)::INT AS attended_events,
    GREATEST(
      COALESCE(imported.imported_absences, 0),
      GREATEST(
        COALESCE(expected.expected_events, 0) -
          COALESCE(expected_attended.attended_expected_events, 0),
        0
      )
    )::INT AS imported_absences,
    COALESCE(manual.manual_absences, 0)::INT AS manual_absences,
    (
      GREATEST(
        COALESCE(imported.imported_absences, 0),
        GREATEST(
          COALESCE(expected.expected_events, 0) -
            COALESCE(expected_attended.attended_expected_events, 0),
          0
        )
      ) + COALESCE(manual.manual_absences, 0)
    )::INT AS total_absences,
    (
      COALESCE(imported.imported_record_count, 0) +
      COALESCE(manual.manual_record_count, 0)
    )::INT AS source_record_count,
    GREATEST(
      COALESCE(imported.latest_scanned_at, '-infinity'::timestamptz),
      COALESCE(manual.latest_scanned_at, '-infinity'::timestamptz)
    ) AS latest_scanned_at,
    GREATEST(
      COALESCE(imported.source_updated_at, '-infinity'::timestamptz),
      COALESCE(manual.source_updated_at, '-infinity'::timestamptz)
    ) AS source_updated_at
  FROM student_keys keys
  LEFT JOIN imported_totals imported
    ON imported.calculation_scope_key = keys.calculation_scope_key
   AND imported.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND imported.normalized_student_id = keys.normalized_student_id
  LEFT JOIN manual_totals manual
    ON manual.calculation_scope_key = keys.calculation_scope_key
   AND manual.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND manual.normalized_student_id = keys.normalized_student_id
  LEFT JOIN attended_event_totals attended
    ON attended.calculation_scope_key = keys.calculation_scope_key
   AND attended.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND attended.normalized_student_id = keys.normalized_student_id
  LEFT JOIN expected_event_totals expected
    ON expected.calculation_scope_key = keys.calculation_scope_key
   AND expected.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND expected.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND expected.normalized_student_id = keys.normalized_student_id
  LEFT JOIN expected_attended_event_totals expected_attended
    ON expected_attended.calculation_scope_key = keys.calculation_scope_key
   AND expected_attended.scope_school_year_id IS NOT DISTINCT FROM keys.scope_school_year_id
   AND expected_attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
   AND expected_attended.normalized_student_id = keys.normalized_student_id
),
matched AS (
  SELECT
    merged.*,
    penalty.id AS penalty_id,
    penalty.prescribed_penalty
  FROM merged
  LEFT JOIN LATERAL (
    SELECT p.id, p.prescribed_penalty
    FROM public.penalties p
    WHERE p.no_of_absences <= merged.total_absences
    ORDER BY p.no_of_absences DESC
    LIMIT 1
  ) penalty ON merged.total_absences > 0
)
INSERT INTO public.calculation_results (
  school_year_id,
  calculation_scope_key,
  import_ids,
  student_id,
  name,
  year_level,
  college,
  program,
  institution,
  attended_events,
  imported_absences,
  manual_absences,
  total_absences,
  attendance_status,
  penalty_id,
  prescribed_penalty,
  source_record_count,
  latest_scanned_at,
  source_updated_at,
  calculated_at
)
SELECT
  school_year_id,
  calculation_scope_key,
  import_ids,
  student_id,
  name,
  year_level,
  college,
  program,
  institution,
  attended_events,
  imported_absences,
  manual_absences,
  total_absences,
  CASE
    WHEN total_absences <= 0 THEN 'perfect_attendance'
    ELSE 'with_absences'
  END,
  penalty_id,
  CASE
    WHEN total_absences <= 0 THEN NULL
    ELSE COALESCE(prescribed_penalty, 'No prescribed penalty configured.')
  END,
  source_record_count,
  NULLIF(latest_scanned_at, '-infinity'::timestamptz),
  NULLIF(source_updated_at, '-infinity'::timestamptz),
  NOW()
FROM matched;

-- Refresh penalty_results from final attendance totals while preserving existing statuses.
DROP TABLE IF EXISTS pg_temp.phase019_penalty_status;
CREATE TEMP TABLE phase019_penalty_status ON COMMIT DROP AS
SELECT DISTINCT ON (
  pr.school_year_id,
  LOWER(TRIM(pr.student_id))
)
  pr.school_year_id,
  LOWER(TRIM(pr.student_id)) AS student_key,
  pr.status,
  pr.created_at
FROM public.penalty_results pr
WHERE pr.source_table = 'attendance_final_results'
ORDER BY
  pr.school_year_id,
  LOWER(TRIM(pr.student_id)),
  pr.updated_at DESC,
  pr.created_at DESC,
  pr.id DESC;

DELETE FROM public.penalty_results
WHERE source_table = 'attendance_final_results';

WITH totals AS (
  SELECT
    afr.school_year_id,
    afr.student_id,
    afr.name,
    afr.total_absences::INT AS no_of_absences,
    penalty.id AS penalty_id,
    COALESCE(
      penalty.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty,
    'attendance_final_results'::TEXT AS source_table,
    afr.id AS source_record_id
  FROM public.attendance_final_results afr
  LEFT JOIN LATERAL (
    SELECT p.id, p.prescribed_penalty
    FROM public.penalties p
    WHERE p.no_of_absences <= afr.total_absences
    ORDER BY p.no_of_absences DESC
    LIMIT 1
  ) penalty ON afr.total_absences > 0
  WHERE afr.total_absences > 0
), matched AS (
  SELECT
    totals.*,
    COALESCE(status.status, 'unpaid') AS status,
    status.created_at AS preserved_created_at
  FROM totals
  LEFT JOIN pg_temp.phase019_penalty_status status
    ON status.school_year_id IS NOT DISTINCT FROM totals.school_year_id
   AND status.student_key = LOWER(TRIM(totals.student_id))
)
INSERT INTO public.penalty_results (
  school_year_id,
  student_id,
  name,
  no_of_absences,
  penalty_id,
  prescribed_penalty,
  status,
  source_table,
  source_record_id,
  created_at,
  updated_at
)
SELECT
  school_year_id,
  student_id,
  name,
  no_of_absences,
  penalty_id,
  prescribed_penalty,
  status,
  source_table,
  source_record_id,
  COALESCE(preserved_created_at, NOW()),
  NOW()
FROM matched;

COMMIT;
