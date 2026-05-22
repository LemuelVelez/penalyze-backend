BEGIN;

WITH total_events AS (
  SELECT COUNT(DISTINCT event_id)::INT AS total
  FROM attendance_records
  WHERE event_id IS NOT NULL
),
student_absences AS (
  SELECT
    LOWER(TRIM(student_id)) AS student_key,
    GREATEST((SELECT total FROM total_events) - COUNT(DISTINCT event_id)::INT, 0) AS no_of_absences
  FROM attendance_records
  WHERE event_id IS NOT NULL
  GROUP BY LOWER(TRIM(student_id))
),
updated_records AS (
  UPDATE attendance_records ar
  SET no_of_absences = sa.no_of_absences,
      updated_at = NOW()
  FROM student_absences sa
  WHERE ar.event_id IS NOT NULL
    AND LOWER(TRIM(ar.student_id)) = sa.student_key
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