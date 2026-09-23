BEGIN;

CREATE TABLE IF NOT EXISTS public.attendance_event_college_exemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES public.attendance_events(id) ON DELETE CASCADE,
  college_key TEXT NOT NULL,
  college_label TEXT NOT NULL,
  reason TEXT NULL,
  created_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT attendance_event_college_exemptions_event_college_key_unique UNIQUE (event_id, college_key)
);

CREATE INDEX IF NOT EXISTS idx_attendance_event_college_exemptions_school_year_college
  ON public.attendance_event_college_exemptions(school_year_id, college_key);

CREATE INDEX IF NOT EXISTS idx_attendance_event_college_exemptions_event
  ON public.attendance_event_college_exemptions(event_id);

DROP TRIGGER IF EXISTS trg_attendance_event_college_exemptions_updated_at
  ON public.attendance_event_college_exemptions;
CREATE TRIGGER trg_attendance_event_college_exemptions_updated_at
BEFORE UPDATE ON public.attendance_event_college_exemptions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

WITH event_roster_scope AS (
  SELECT DISTINCT
    ar.school_year_id,
    COALESCE(ar.event_id, ai.event_id) AS event_id,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
      LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')), '&', ' and ')),
      '[^a-z0-9]+', ' ', 'g'
    ), '[[:space:]]+', ' ', 'g')), '') AS college_key
  FROM public.attendance_records ar
  LEFT JOIN public.attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
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
  FROM public.manual_attendance_records mar
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), participation AS (
  SELECT DISTINCT ar.school_year_id, LOWER(TRIM(ar.student_id)) AS student_key,
    COALESCE(ar.event_id, ai.event_id) AS event_id
  FROM public.attendance_records ar
  LEFT JOIN public.attendance_imports ai ON ai.id = ar.import_id AND ai.deleted_at IS NULL
  WHERE ar.deleted_at IS NULL AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL
  UNION
  SELECT DISTINCT mar.school_year_id, LOWER(TRIM(mar.student_id)), mar.event_id
  FROM public.manual_attendance_records mar
  WHERE mar.event_id IS NOT NULL
    AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
    AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER('Zero attendance registration from landing page.')
), record_scope AS (
  SELECT
    ar.id,
    ar.school_year_id,
    LOWER(TRIM(ar.student_id)) AS student_key,
    NULLIF(TRIM(REGEXP_REPLACE(REGEXP_REPLACE(
      LOWER(REPLACE(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')), '&', ' and ')),
      '[^a-z0-9]+', ' ', 'g'
    ), '[[:space:]]+', ' ', 'g')), '') AS college_key
  FROM public.attendance_records ar
  LEFT JOIN public.students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE ar.deleted_at IS NULL AND ar.event_id IS NOT NULL
), derived AS (
  SELECT rs.id,
    GREATEST(COUNT(DISTINCT roster.event_id)::INT - COUNT(DISTINCT p.event_id)::INT, 0) AS no_of_absences
  FROM record_scope rs
  LEFT JOIN event_roster_scope roster
    ON roster.school_year_id IS NOT DISTINCT FROM rs.school_year_id
   AND roster.college_key = rs.college_key
  LEFT JOIN participation p
    ON p.school_year_id IS NOT DISTINCT FROM rs.school_year_id
   AND p.student_key = rs.student_key
   AND p.event_id = roster.event_id
  GROUP BY rs.id
)
UPDATE public.attendance_records ar
SET no_of_absences = d.no_of_absences,
    updated_at = CASE WHEN ar.no_of_absences IS DISTINCT FROM d.no_of_absences THEN NOW() ELSE ar.updated_at END
FROM derived d
WHERE ar.id = d.id;

COMMIT;
