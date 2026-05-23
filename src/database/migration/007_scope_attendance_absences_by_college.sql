BEGIN;

WITH scoped_events AS (
  SELECT
    LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), ''), ''))) AS college_key,
    COUNT(DISTINCT ar.event_id)::INT AS total_events
  FROM attendance_records ar
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE ar.event_id IS NOT NULL
  GROUP BY LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), ''), '')))
),
student_attendance AS (
  SELECT
    LOWER(TRIM(ar.student_id)) AS student_key,
    LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), ''), ''))) AS college_key,
    COUNT(DISTINCT ar.event_id)::INT AS attended_events
  FROM attendance_records ar
  LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
  WHERE ar.event_id IS NOT NULL
  GROUP BY
    LOWER(TRIM(ar.student_id)),
    LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), ''), '')))
),
student_absences AS (
  SELECT
    sa.student_key,
    sa.college_key,
    GREATEST(COALESCE(se.total_events, 0) - sa.attended_events, 0) AS no_of_absences
  FROM student_attendance sa
  LEFT JOIN scoped_events se ON se.college_key = sa.college_key
),
updated_records AS (
  UPDATE attendance_records ar
  SET no_of_absences = sa.no_of_absences,
      updated_at = NOW()
  FROM student_absences sa
  WHERE ar.event_id IS NOT NULL
    AND LOWER(TRIM(ar.student_id)) = sa.student_key
    AND LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(s.college), '')
        FROM students s
        WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(ar.college), ''),
      ''
    ))) = sa.college_key
  RETURNING ar.id, ar.student_id, ar.name, ar.no_of_absences
),
best_penalties AS (
  SELECT DISTINCT ON (ur.id)
    ur.id AS attendance_record_id,
    p.id AS penalty_id,
    COALESCE(p.prescribed_penalty, 'No prescribed penalty configured.') AS prescribed_penalty
  FROM updated_records ur
  LEFT JOIN penalties p ON p.no_of_absences <= ur.no_of_absences
  ORDER BY ur.id, p.no_of_absences DESC NULLS LAST
)
UPDATE fines f
SET student_id = ur.student_id,
    name = ur.name,
    no_of_absences = ur.no_of_absences,
    penalty_id = bp.penalty_id,
    prescribed_penalty = COALESCE(bp.prescribed_penalty, 'No prescribed penalty configured.'),
    updated_at = NOW()
FROM updated_records ur
LEFT JOIN best_penalties bp ON bp.attendance_record_id = ur.id
WHERE f.attendance_record_id = ur.id;

DELETE FROM fines
WHERE attendance_record_id IN (
  SELECT id
  FROM attendance_records
  WHERE event_id IS NOT NULL
    AND no_of_absences <= 0
);

COMMIT;