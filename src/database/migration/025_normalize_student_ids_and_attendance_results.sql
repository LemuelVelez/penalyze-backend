BEGIN;

LOCK TABLE public.students IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.attendance_final_results IN SHARE ROW EXCLUSIVE MODE;

-- Keep one deterministic final-result row for each derived (import_id IS NULL)
-- school-year/student key. Prefer the most recently refreshed source row.
DROP TABLE IF EXISTS pg_temp.phase025_final_result_duplicates;
CREATE TEMP TABLE phase025_final_result_duplicates ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    afr.id,
    FIRST_VALUE(afr.id) OVER (
      PARTITION BY afr.school_year_id, LOWER(TRIM(afr.student_id))
      ORDER BY
        afr.source_updated_at DESC NULLS LAST,
        afr.latest_scanned_at DESC NULLS LAST,
        afr.updated_at DESC,
        afr.created_at DESC,
        afr.id DESC
    ) AS keep_id,
    ROW_NUMBER() OVER (
      PARTITION BY afr.school_year_id, LOWER(TRIM(afr.student_id))
      ORDER BY
        afr.source_updated_at DESC NULLS LAST,
        afr.latest_scanned_at DESC NULLS LAST,
        afr.updated_at DESC,
        afr.created_at DESC,
        afr.id DESC
    ) AS row_number
  FROM public.attendance_final_results afr
  WHERE afr.import_id IS NULL
)
SELECT id AS duplicate_id, keep_id
FROM ranked
WHERE row_number > 1;

UPDATE public.penalty_results pr
SET source_record_id = duplicate.keep_id
FROM phase025_final_result_duplicates duplicate
WHERE pr.source_table = 'attendance_final_results'
  AND pr.source_record_id = duplicate.duplicate_id;

DELETE FROM public.attendance_final_results afr
USING phase025_final_result_duplicates duplicate
WHERE afr.id = duplicate.duplicate_id;

-- Pick one canonical student row for every case/whitespace-insensitive ID.
DROP TABLE IF EXISTS pg_temp.phase025_canonical_students;
CREATE TEMP TABLE phase025_canonical_students ON COMMIT DROP AS
SELECT DISTINCT ON (LOWER(TRIM(student_id)))
  LOWER(TRIM(student_id)) AS normalized_student_id,
  id AS keep_id,
  TRIM(student_id) AS canonical_student_id
FROM public.students
ORDER BY
  LOWER(TRIM(student_id)),
  updated_at DESC,
  created_at DESC,
  id DESC;

-- Merge the newest non-empty profile values into the canonical row before
-- deleting its case/whitespace variants.
UPDATE public.students canonical_student
SET name = COALESCE(
      (
        SELECT candidate.name
        FROM public.students candidate
        WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
          AND NULLIF(TRIM(candidate.name), '') IS NOT NULL
        ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      ),
      canonical_student.name
    ),
    year_level = COALESCE(
      (
        SELECT candidate.year_level
        FROM public.students candidate
        WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
          AND NULLIF(TRIM(candidate.year_level), '') IS NOT NULL
        ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      ),
      canonical_student.year_level
    ),
    college = COALESCE(
      (
        SELECT candidate.college
        FROM public.students candidate
        WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
          AND NULLIF(TRIM(candidate.college), '') IS NOT NULL
        ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      ),
      canonical_student.college
    ),
    program = COALESCE(
      (
        SELECT candidate.program
        FROM public.students candidate
        WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
          AND NULLIF(TRIM(candidate.program), '') IS NOT NULL
        ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      ),
      canonical_student.program
    ),
    institution = COALESCE(
      (
        SELECT candidate.institution
        FROM public.students candidate
        WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
          AND NULLIF(TRIM(candidate.institution), '') IS NOT NULL
        ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.id DESC
        LIMIT 1
      ),
      canonical_student.institution
    ),
    updated_at = GREATEST(
      canonical_student.updated_at,
      COALESCE(
        (
          SELECT MAX(candidate.updated_at)
          FROM public.students candidate
          WHERE LOWER(TRIM(candidate.student_id)) = canonical.normalized_student_id
        ),
        canonical_student.updated_at
      )
    )
FROM phase025_canonical_students canonical
WHERE canonical_student.id = canonical.keep_id
  AND EXISTS (
    SELECT 1
    FROM public.students duplicate_student
    WHERE LOWER(TRIM(duplicate_student.student_id)) = canonical.normalized_student_id
      AND duplicate_student.id <> canonical.keep_id
  );

DELETE FROM public.students student
USING phase025_canonical_students canonical
WHERE LOWER(TRIM(student.student_id)) = canonical.normalized_student_id
  AND student.id <> canonical.keep_id;

UPDATE public.students student
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE student.id = canonical.keep_id
  AND student.student_id IS DISTINCT FROM canonical.canonical_student_id;

-- Normalize all persisted student-ID copies to the selected canonical spelling.
UPDATE public.attendance_records record
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(record.student_id)) = canonical.normalized_student_id
  AND record.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.manual_attendance_records record
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(record.student_id)) = canonical.normalized_student_id
  AND record.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.attendance_requests request
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(request.student_id)) = canonical.normalized_student_id
  AND request.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.attendance_final_results result
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(result.student_id)) = canonical.normalized_student_id
  AND result.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.calculation_results result
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(result.student_id)) = canonical.normalized_student_id
  AND result.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.penalty_results result
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(result.student_id)) = canonical.normalized_student_id
  AND result.student_id IS DISTINCT FROM canonical.canonical_student_id;

UPDATE public.fines fine
SET student_id = canonical.canonical_student_id
FROM phase025_canonical_students canonical
WHERE LOWER(TRIM(fine.student_id)) = canonical.normalized_student_id
  AND fine.student_id IS DISTINCT FROM canonical.canonical_student_id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_students_student_id_normalized
  ON public.students (LOWER(TRIM(student_id)));

-- import_id is NULL for derived final results, so the older unique index does not
-- protect this scope because PostgreSQL treats NULLs as distinct.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_final_results_derived_student
  ON public.attendance_final_results (
    COALESCE(school_year_id, '00000000-0000-0000-0000-000000000000'::uuid),
    LOWER(TRIM(student_id))
  )
  WHERE import_id IS NULL;

COMMIT;
