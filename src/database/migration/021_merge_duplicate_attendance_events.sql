BEGIN;

SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

CREATE TABLE IF NOT EXISTS public.attendance_event_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL,
  target_event_id UUID REFERENCES public.attendance_events(id) ON DELETE SET NULL,
  source_event_id UUID NOT NULL,
  target_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  source_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  moved_counts JSONB NOT NULL DEFAULT '{}'::JSONB,
  merged_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_event_merges_school_year
  ON public.attendance_event_merges(school_year_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_event_merges_target
  ON public.attendance_event_merges(target_event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_event_merges_source
  ON public.attendance_event_merges(source_event_id, created_at DESC);

-- Keep independent proof of attendance for separate imports. Presence is derived by
-- DISTINCT event_id, so records from multiple scanners must not be physically deduped.
DO $$
DECLARE
  item RECORD;
BEGIN
  FOR item IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'attendance_records'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%student_id%'
      AND indexdef ILIKE '%event_id%'
  LOOP
    EXECUTE FORMAT('DROP INDEX IF EXISTS public.%I', item.indexname);
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_records_student_event_scan
  ON public.attendance_records(
    LOWER(TRIM(student_id)), event_id, scanned_at DESC, created_at DESC
  );

CREATE OR REPLACE FUNCTION pg_temp.phase021_event_identity(p_name TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT TRIM(REGEXP_REPLACE(
    REGEXP_REPLACE(
      REGEXP_REPLACE(
        REGEXP_REPLACE(
          LOWER(COALESCE(p_name, '')),
          '\([^)]*\)[[:space:]]*$',
          ' ',
          'g'
        ),
        '(^|[^a-z0-9])(gen|genl)([^a-z0-9]|$)',
        '\1general\3',
        'g'
      ),
      '(^|[^a-z0-9])(assy|asm)([^a-z0-9]|$)',
      '\1assembly\3',
      'g'
    ),
    '[^a-z0-9]+',
    ' ',
    'g'
  ));
$$;

CREATE OR REPLACE FUNCTION pg_temp.phase021_event_core(p_name TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT TRIM(REGEXP_REPLACE(
    REGEXP_REPLACE(
      pg_temp.phase021_event_identity(p_name),
      '(^|[[:space:]])(attendance|batch|section|sec|part|group|scanner|scan|copy|file|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)([[:space:]]|$)',
      ' ',
      'g'
    ),
    '(^|[[:space:]])[0-9]{1,4}(st|nd|rd|th)?([[:space:]]|$)',
    ' ',
    'g'
  ));
$$;

CREATE OR REPLACE FUNCTION pg_temp.phase021_college_key(
  p_student_id TEXT,
  p_record_college TEXT,
  p_program TEXT,
  p_institution TEXT
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
    CASE
      WHEN NULLIF(TRIM(p_program), '') IS NOT NULL
        THEN 'program:' || LOWER(TRIM(p_program))
      WHEN NULLIF(TRIM(p_institution), '') IS NOT NULL
        THEN 'institution:' || LOWER(TRIM(p_institution))
      ELSE 'student:' || LOWER(TRIM(p_student_id))
    END
  )));
$$;

DROP TABLE IF EXISTS pg_temp.phase021_merge_map;
CREATE TEMP TABLE phase021_merge_map (
  source_event_id UUID PRIMARY KEY,
  target_event_id UUID NOT NULL,
  school_year_id UUID
) ON COMMIT DROP;

-- Backfill only conservative, high-confidence duplicates: same school year,
-- same normalized core name and same event date. Null-date events are left for
-- the admin merge UI instead of being guessed automatically.
WITH ranked AS (
  SELECT
    e.id,
    e.school_year_id,
    pg_temp.phase021_event_core(e.name) AS event_core,
    COALESCE(e.event_start_at, e.event_end_at)::DATE AS event_day,
    FIRST_VALUE(e.id) OVER (
      PARTITION BY
        e.school_year_id,
        pg_temp.phase021_event_core(e.name),
        COALESCE(e.event_start_at, e.event_end_at)::DATE
      ORDER BY e.event_order ASC NULLS LAST, e.created_at ASC, e.id ASC
    ) AS target_event_id,
    COUNT(*) OVER (
      PARTITION BY
        e.school_year_id,
        pg_temp.phase021_event_core(e.name),
        COALESCE(e.event_start_at, e.event_end_at)::DATE
    ) AS group_size
  FROM public.attendance_events e
  WHERE NULLIF(pg_temp.phase021_event_core(e.name), '') IS NOT NULL
    AND COALESCE(e.event_start_at, e.event_end_at) IS NOT NULL
)
INSERT INTO phase021_merge_map(source_event_id, target_event_id, school_year_id)
SELECT id, target_event_id, school_year_id
FROM ranked
WHERE group_size > 1
  AND id <> target_event_id
ON CONFLICT (source_event_id) DO NOTHING;

INSERT INTO public.attendance_event_merges (
  school_year_id,
  target_event_id,
  source_event_id,
  target_snapshot,
  source_snapshot,
  moved_counts,
  merged_by
)
SELECT
  map.school_year_id,
  target.id,
  source.id,
  TO_JSONB(target),
  TO_JSONB(source),
  JSONB_BUILD_OBJECT(
    'attendanceRecords', (SELECT COUNT(*) FROM public.attendance_records ar WHERE ar.event_id = source.id),
    'attendanceImports', (SELECT COUNT(*) FROM public.attendance_imports ai WHERE ai.event_id = source.id),
    'manualAttendanceRecords', (SELECT COUNT(*) FROM public.manual_attendance_records mar WHERE mar.event_id = source.id),
    'attendanceRequestEvents', (SELECT COUNT(*) FROM public.attendance_request_events areq WHERE areq.event_id = source.id)
  ),
  NULL
FROM phase021_merge_map map
JOIN public.attendance_events source ON source.id = map.source_event_id
JOIN public.attendance_events target ON target.id = map.target_event_id
WHERE NOT EXISTS (
  SELECT 1
  FROM public.attendance_event_merges log
  WHERE log.source_event_id = map.source_event_id
    AND log.target_event_id = map.target_event_id
);

UPDATE public.attendance_records ar
SET event_id = map.target_event_id,
    updated_at = NOW()
FROM phase021_merge_map map
WHERE ar.event_id = map.source_event_id;

UPDATE public.attendance_imports ai
SET event_id = map.target_event_id,
    needs_reattachment = FALSE
FROM phase021_merge_map map
WHERE ai.event_id = map.source_event_id;

UPDATE public.manual_attendance_records mar
SET event_id = map.target_event_id,
    updated_at = NOW()
FROM phase021_merge_map map
WHERE mar.event_id = map.source_event_id;

DELETE FROM public.attendance_request_events source
USING phase021_merge_map map
WHERE source.event_id = map.source_event_id
  AND EXISTS (
    SELECT 1
    FROM public.attendance_request_events target
    WHERE target.request_id = source.request_id
      AND target.event_id = map.target_event_id
  );

UPDATE public.attendance_request_events areq
SET event_id = map.target_event_id,
    event_name = target.name
FROM phase021_merge_map map
JOIN public.attendance_events target ON target.id = map.target_event_id
WHERE areq.event_id = map.source_event_id;

DELETE FROM public.attendance_events source
USING phase021_merge_map map
WHERE source.id = map.source_event_id;

WITH ordered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY school_year_id
      ORDER BY event_order ASC NULLS LAST,
        COALESCE(event_start_at, event_end_at, created_at) ASC,
        created_at ASC,
        id ASC
    ) AS next_order
  FROM public.attendance_events
)
UPDATE public.attendance_events e
SET event_order = ordered.next_order,
    updated_at = NOW()
FROM ordered
WHERE e.id = ordered.id
  AND e.event_order IS DISTINCT FROM ordered.next_order;

-- Recompute the derived absence count after event identity has been repaired.
WITH event_participation AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    LOWER(TRIM(ar.student_id)) AS student_key
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
    AND ar.event_id IS NOT NULL
), event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    ar.event_id,
    pg_temp.phase021_college_key(
      ar.student_id, ar.college, ar.program, ar.institution
    ) AS college_key
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
    AND ar.event_id IS NOT NULL
), student_scope AS (
  SELECT DISTINCT
    LOWER(TRIM(ar.student_id)) AS student_key,
    ar.school_year_id,
    pg_temp.phase021_college_key(
      ar.student_id, ar.college, ar.program, ar.institution
    ) AS college_key
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
    AND ar.event_id IS NOT NULL
), student_absences AS (
  SELECT
    scope.student_key,
    scope.school_year_id,
    scope.college_key,
    GREATEST(
      COUNT(DISTINCT roster.event_id)::INT -
        COUNT(DISTINCT attended.event_id)::INT,
      0
    ) AS no_of_absences
  FROM student_scope scope
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM scope.school_year_id
   AND roster.college_key = scope.college_key
  LEFT JOIN event_participation attended
    ON attended.school_year_id IS NOT DISTINCT FROM scope.school_year_id
   AND attended.student_key = scope.student_key
   AND attended.event_id = roster.event_id
  GROUP BY scope.student_key, scope.school_year_id, scope.college_key
)
UPDATE public.attendance_records ar
SET no_of_absences = calculated.no_of_absences,
    updated_at = CASE
      WHEN ar.no_of_absences IS DISTINCT FROM calculated.no_of_absences THEN NOW()
      ELSE ar.updated_at
    END
FROM student_absences calculated
WHERE ar.deleted_at IS NULL
  AND LOWER(TRIM(ar.student_id)) = calculated.student_key
  AND ar.school_year_id IS NOT DISTINCT FROM calculated.school_year_id
  AND pg_temp.phase021_college_key(
        ar.student_id, ar.college, ar.program, ar.institution
      ) = calculated.college_key;

-- Preserve the latest paid/waived state while refreshing fine anchors.
DROP TABLE IF EXISTS pg_temp.phase021_fine_status;
CREATE TEMP TABLE phase021_fine_status ON COMMIT DROP AS
SELECT DISTINCT ON (
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)),
  pg_temp.phase021_college_key(ar.student_id, ar.college, ar.program, ar.institution)
)
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)) AS student_key,
  pg_temp.phase021_college_key(ar.student_id, ar.college, ar.program, ar.institution) AS college_key,
  f.status
FROM public.fines f
JOIN public.attendance_records ar ON ar.id = f.attendance_record_id
WHERE ar.deleted_at IS NULL
  AND ar.event_id IS NOT NULL
ORDER BY
  ar.school_year_id,
  LOWER(TRIM(ar.student_id)),
  pg_temp.phase021_college_key(ar.student_id, ar.college, ar.program, ar.institution),
  f.updated_at DESC,
  f.created_at DESC,
  f.id DESC;

DELETE FROM public.fines f
USING public.attendance_records ar
WHERE ar.id = f.attendance_record_id
  AND ar.event_id IS NOT NULL;

WITH ranked AS (
  SELECT
    ar.*,
    pg_temp.phase021_college_key(ar.student_id, ar.college, ar.program, ar.institution) AS college_key,
    ROW_NUMBER() OVER (
      PARTITION BY
        ar.school_year_id,
        LOWER(TRIM(ar.student_id)),
        pg_temp.phase021_college_key(ar.student_id, ar.college, ar.program, ar.institution)
      ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC, ar.created_at DESC, ar.id DESC
    ) AS anchor_rank
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
    AND ar.event_id IS NOT NULL
    AND ar.no_of_absences > 0
), anchors AS (
  SELECT * FROM ranked WHERE anchor_rank = 1
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
  anchor.school_year_id,
  anchor.id,
  penalty.id,
  anchor.student_id,
  anchor.name,
  COALESCE(penalty.prescribed_penalty, 'No prescribed penalty configured.'),
  COALESCE(saved.status, 'unpaid')
FROM anchors anchor
LEFT JOIN LATERAL (
  SELECT id, prescribed_penalty
  FROM public.penalties
  WHERE no_of_absences <= anchor.no_of_absences
  ORDER BY no_of_absences DESC
  LIMIT 1
) penalty ON TRUE
LEFT JOIN phase021_fine_status saved
  ON saved.school_year_id IS NOT DISTINCT FROM anchor.school_year_id
 AND saved.student_key = LOWER(TRIM(anchor.student_id))
 AND saved.college_key = anchor.college_key;

-- Refresh aggregate stored counts without changing user-maintained statuses.
WITH imported AS (
  SELECT
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    (ARRAY_AGG(ar.student_id ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS student_id,
    (ARRAY_AGG(ar.name ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS name,
    (ARRAY_AGG(ar.year_level ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS year_level,
    (ARRAY_AGG(ar.college ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS college,
    (ARRAY_AGG(ar.program ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS program,
    (ARRAY_AGG(ar.institution ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC))[1] AS institution,
    COUNT(DISTINCT ar.event_id)::INT AS attended_events,
    MAX(ar.no_of_absences)::INT AS imported_absences,
    MAX(ar.scanned_at) AS latest_scanned_at,
    MAX(ar.updated_at) AS source_updated_at,
    ARRAY_AGG(DISTINCT ar.import_id) FILTER (WHERE ar.import_id IS NOT NULL) AS import_ids,
    COUNT(*)::INT AS source_record_count
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
  GROUP BY ar.school_year_id, LOWER(TRIM(ar.student_id))
), manual AS (
  SELECT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS student_key,
    SUM(CASE WHEN COALESCE(mar.attendance_type, 'manual') = 'manual' THEN mar.no_of_absences ELSE 0 END)::INT AS manual_absences
  FROM public.manual_attendance_records mar
  GROUP BY mar.school_year_id, LOWER(TRIM(mar.student_id))
), totals AS (
  SELECT
    imported.*,
    COALESCE(manual.manual_absences, 0)::INT AS manual_absences,
    (imported.imported_absences + COALESCE(manual.manual_absences, 0))::INT AS total_absences
  FROM imported
  LEFT JOIN manual
    ON manual.school_year_id IS NOT DISTINCT FROM imported.school_year_id
   AND manual.student_key = imported.student_key
)
UPDATE public.attendance_final_results result
SET attended_events = totals.attended_events,
    total_absences = totals.total_absences,
    attendance_status = CASE WHEN totals.total_absences <= 0 THEN 'perfect_attendance' ELSE 'with_absences' END,
    latest_scanned_at = totals.latest_scanned_at,
    source_updated_at = totals.source_updated_at,
    updated_at = NOW()
FROM totals
WHERE result.school_year_id IS NOT DISTINCT FROM totals.school_year_id
  AND LOWER(TRIM(result.student_id)) = totals.student_key;

WITH imported AS (
  SELECT
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    COUNT(DISTINCT ar.event_id)::INT AS attended_events,
    MAX(ar.no_of_absences)::INT AS imported_absences,
    ARRAY_AGG(DISTINCT ar.import_id) FILTER (WHERE ar.import_id IS NOT NULL) AS import_ids,
    COUNT(*)::INT AS source_record_count,
    MAX(ar.scanned_at) AS latest_scanned_at,
    MAX(ar.updated_at) AS source_updated_at
  FROM public.attendance_records ar
  WHERE ar.deleted_at IS NULL
  GROUP BY ar.school_year_id, LOWER(TRIM(ar.student_id))
), manual AS (
  SELECT
    mar.school_year_id,
    LOWER(TRIM(mar.student_id)) AS student_key,
    SUM(CASE WHEN COALESCE(mar.attendance_type, 'manual') = 'manual' THEN mar.no_of_absences ELSE 0 END)::INT AS manual_absences
  FROM public.manual_attendance_records mar
  GROUP BY mar.school_year_id, LOWER(TRIM(mar.student_id))
), totals AS (
  SELECT
    imported.*,
    COALESCE(manual.manual_absences, 0)::INT AS manual_absences,
    (imported.imported_absences + COALESCE(manual.manual_absences, 0))::INT AS total_absences
  FROM imported
  LEFT JOIN manual
    ON manual.school_year_id IS NOT DISTINCT FROM imported.school_year_id
   AND manual.student_key = imported.student_key
)
UPDATE public.calculation_results result
SET import_ids = COALESCE(totals.import_ids, '{}'::UUID[]),
    attended_events = totals.attended_events,
    imported_absences = totals.imported_absences,
    manual_absences = totals.manual_absences,
    total_absences = totals.total_absences,
    attendance_status = CASE WHEN totals.total_absences <= 0 THEN 'perfect_attendance' ELSE 'with_absences' END,
    penalty_id = penalty.id,
    prescribed_penalty = CASE WHEN totals.total_absences > 0 THEN COALESCE(penalty.prescribed_penalty, 'No prescribed penalty configured.') ELSE NULL END,
    source_record_count = totals.source_record_count,
    latest_scanned_at = totals.latest_scanned_at,
    source_updated_at = totals.source_updated_at,
    calculated_at = NOW(),
    updated_at = NOW()
FROM totals
LEFT JOIN LATERAL (
  SELECT id, prescribed_penalty
  FROM public.penalties
  WHERE no_of_absences <= totals.total_absences
  ORDER BY no_of_absences DESC
  LIMIT 1
) penalty ON TRUE
WHERE result.school_year_id IS NOT DISTINCT FROM totals.school_year_id
  AND LOWER(TRIM(result.student_id)) = totals.student_key;

WITH final_penalties AS (
  SELECT
    afr.school_year_id,
    afr.id AS source_record_id,
    afr.student_id,
    afr.name,
    afr.total_absences,
    penalty.id AS penalty_id,
    COALESCE(penalty.prescribed_penalty, 'No prescribed penalty configured.') AS prescribed_penalty
  FROM public.attendance_final_results afr
  LEFT JOIN LATERAL (
    SELECT id, prescribed_penalty
    FROM public.penalties
    WHERE no_of_absences <= afr.total_absences
    ORDER BY no_of_absences DESC
    LIMIT 1
  ) penalty ON afr.total_absences > 0
  WHERE afr.total_absences > 0
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
  source_record_id
)
SELECT
  school_year_id,
  student_id,
  name,
  total_absences,
  penalty_id,
  prescribed_penalty,
  'unpaid',
  'attendance_final_results',
  source_record_id
FROM final_penalties
ON CONFLICT (school_year_id, (LOWER(TRIM(student_id))))
DO UPDATE SET
  name = EXCLUDED.name,
  no_of_absences = EXCLUDED.no_of_absences,
  penalty_id = EXCLUDED.penalty_id,
  prescribed_penalty = EXCLUDED.prescribed_penalty,
  source_table = EXCLUDED.source_table,
  source_record_id = EXCLUDED.source_record_id,
  updated_at = NOW();

DELETE FROM public.penalty_results pr
WHERE pr.source_table = 'attendance_final_results'
  AND NOT EXISTS (
    SELECT 1
    FROM public.attendance_final_results afr
    WHERE afr.school_year_id IS NOT DISTINCT FROM pr.school_year_id
      AND LOWER(TRIM(afr.student_id)) = LOWER(TRIM(pr.student_id))
      AND afr.total_absences > 0
  );

COMMIT;
