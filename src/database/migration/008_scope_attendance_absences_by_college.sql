BEGIN;

SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint);

LOCK TABLE attendance_records, fines IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE attendance_absence_scope_records ON COMMIT DROP AS
WITH college_event_scope AS (
  SELECT DISTINCT
    ar.event_id,
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.college), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(ar.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(ar.college), ''),
      ''
    ))) AS college_key
  FROM attendance_records ar
  WHERE ar.event_id IS NOT NULL
),
student_scope AS (
  SELECT DISTINCT
    LOWER(TRIM(ar.student_id)) AS student_key,
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.college), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(ar.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(ar.college), ''),
      ''
    ))) AS college_key
  FROM attendance_records ar
  WHERE ar.event_id IS NOT NULL
),
student_absences AS (
  SELECT
    ss.student_key,
    ss.college_key,
    GREATEST(
      COUNT(DISTINCT ces.event_id)::INT -
        COUNT(DISTINCT attended.event_id)::INT,
      0
    ) AS no_of_absences
  FROM student_scope ss
  LEFT JOIN college_event_scope ces ON ces.college_key = ss.college_key
  LEFT JOIN attendance_records attended
    ON LOWER(TRIM(attended.student_id)) = ss.student_key
    AND attended.event_id = ces.event_id
    AND LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.college), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(attended.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(attended.college), ''),
      ''
    ))) = ss.college_key
  GROUP BY ss.student_key, ss.college_key
)
SELECT
  ar.id,
  ar.student_id,
  ar.name,
  ar.scanned_at,
  ar.created_at,
  sa.college_key,
  sa.no_of_absences
FROM attendance_records ar
JOIN student_absences sa
  ON LOWER(TRIM(ar.student_id)) = sa.student_key
 AND LOWER(TRIM(COALESCE(
    (
      SELECT NULLIF(TRIM(scope_student.college), '')
      FROM students scope_student
      WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(ar.student_id))
      LIMIT 1
    ),
    NULLIF(TRIM(ar.college), ''),
    ''
  ))) = sa.college_key
WHERE ar.event_id IS NOT NULL;

CREATE TEMP TABLE attendance_absence_locked_record_ids ON COMMIT DROP AS
SELECT id
FROM attendance_absence_scope_records
ORDER BY id;

SELECT ar.id
FROM attendance_records ar
JOIN attendance_absence_locked_record_ids locked_scope
  ON locked_scope.id = ar.id
ORDER BY ar.id
FOR UPDATE OF ar;

UPDATE attendance_records ar
SET no_of_absences = scope.no_of_absences,
    updated_at = CASE
      WHEN ar.no_of_absences IS DISTINCT FROM scope.no_of_absences THEN NOW()
      ELSE ar.updated_at
    END
FROM attendance_absence_scope_records scope
WHERE ar.id = scope.id;

CREATE TEMP TABLE attendance_absence_active_records ON COMMIT DROP AS
SELECT *
FROM (
  SELECT
    scope.*,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(scope.student_id)), scope.college_key
      ORDER BY
        CASE WHEN f.id IS NOT NULL THEN 0 ELSE 1 END,
        COALESCE(scope.scanned_at, scope.created_at) DESC NULLS LAST,
        scope.created_at DESC NULLS LAST
    ) AS scope_rank
  FROM attendance_absence_scope_records scope
  LEFT JOIN fines f ON f.attendance_record_id = scope.id
) ranked_scope_records
WHERE scope_rank = 1;

DELETE FROM fines
WHERE attendance_record_id IN (
  SELECT scope.id
  FROM attendance_absence_scope_records scope
  LEFT JOIN attendance_absence_active_records active_scope
    ON active_scope.id = scope.id
  WHERE active_scope.id IS NULL
     OR scope.no_of_absences <= 0
);

WITH best_penalties AS (
  SELECT DISTINCT ON (active_scope.id)
    active_scope.id AS attendance_record_id,
    p.id AS penalty_id,
    COALESCE(
      p.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty
  FROM attendance_absence_active_records active_scope
  LEFT JOIN penalties p ON p.no_of_absences <= active_scope.no_of_absences
  ORDER BY active_scope.id, p.no_of_absences DESC NULLS LAST
)
UPDATE fines f
SET student_id = active_scope.student_id,
    name = active_scope.name,
    no_of_absences = active_scope.no_of_absences,
    penalty_id = bp.penalty_id,
    prescribed_penalty = COALESCE(
      bp.prescribed_penalty,
      'No prescribed penalty configured.'
    ),
    updated_at = NOW()
FROM attendance_absence_active_records active_scope
LEFT JOIN best_penalties bp ON bp.attendance_record_id = active_scope.id
WHERE f.attendance_record_id = active_scope.id
  AND active_scope.no_of_absences > 0;

WITH best_penalties AS (
  SELECT DISTINCT ON (active_scope.id)
    active_scope.id AS attendance_record_id,
    p.id AS penalty_id,
    COALESCE(
      p.prescribed_penalty,
      'No prescribed penalty configured.'
    ) AS prescribed_penalty
  FROM attendance_absence_active_records active_scope
  LEFT JOIN penalties p ON p.no_of_absences <= active_scope.no_of_absences
  WHERE active_scope.no_of_absences > 0
  ORDER BY active_scope.id, p.no_of_absences DESC NULLS LAST
)
INSERT INTO fines (
  attendance_record_id,
  penalty_id,
  student_id,
  name,
  no_of_absences,
  prescribed_penalty,
  status
)
SELECT
  active_scope.id,
  bp.penalty_id,
  active_scope.student_id,
  active_scope.name,
  active_scope.no_of_absences,
  COALESCE(bp.prescribed_penalty, 'No prescribed penalty configured.'),
  'unpaid'
FROM attendance_absence_active_records active_scope
LEFT JOIN best_penalties bp ON bp.attendance_record_id = active_scope.id
WHERE active_scope.no_of_absences > 0
  AND NOT EXISTS (
    SELECT 1
    FROM fines f
    WHERE f.attendance_record_id = active_scope.id
  );

COMMIT;


