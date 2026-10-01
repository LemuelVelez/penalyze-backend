BEGIN;

-- Repair the UTF-8 bytes that older CSV imports decoded as Latin-1/Windows-1252.
-- The function only replaces known mojibake sequences, so rerunning this migration
-- is safe and correctly encoded text is left untouched.
CREATE OR REPLACE FUNCTION pg_temp.fix_utf8_mojibake(p_value TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT REPLACE(
    REPLACE(
      REPLACE(
        REPLACE(
          REPLACE(
            REPLACE(
              REPLACE(
                REPLACE(
                  p_value,
                  CHR(195) || CHR(177), 'ñ'
                ),
                CHR(195) || CHR(145), 'Ñ'
              ),
              CHR(195) || CHR(8216), 'Ñ'
            ),
            CHR(195) || CHR(161), 'á'
          ),
          CHR(195) || CHR(169), 'é'
        ),
        CHR(195) || CHR(173), 'í'
      ),
      CHR(195) || CHR(179), 'ó'
    ),
    CHR(195) || CHR(186), 'ú'
  );
$$;

-- None of these repaired profile columns participate in the student unique key;
-- student_id remains untouched, so the normalized student-ID indexes cannot collide.
UPDATE public.students
SET name = CASE WHEN name LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(name) ELSE name END,
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%';

UPDATE public.attendance_records
SET name = pg_temp.fix_utf8_mojibake(name),
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END,
    remarks = CASE WHEN remarks LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(remarks) ELSE remarks END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%'
   OR remarks LIKE '%Ã%';

UPDATE public.attendance_events
SET name = pg_temp.fix_utf8_mojibake(name),
    description = CASE WHEN description LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(description) ELSE description END
WHERE name LIKE '%Ã%'
   OR description LIKE '%Ã%';

UPDATE public.attendance_imports
SET file_name = pg_temp.fix_utf8_mojibake(file_name)
WHERE file_name LIKE '%Ã%';

UPDATE public.attendance_final_results
SET name = pg_temp.fix_utf8_mojibake(name),
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%';

UPDATE public.manual_attendance_records
SET name = pg_temp.fix_utf8_mojibake(name),
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END,
    remarks = CASE WHEN remarks LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(remarks) ELSE remarks END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%'
   OR remarks LIKE '%Ã%';

UPDATE public.calculation_results
SET name = pg_temp.fix_utf8_mojibake(name),
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%';

UPDATE public.penalty_results
SET name = pg_temp.fix_utf8_mojibake(name)
WHERE name LIKE '%Ã%';

UPDATE public.fines
SET name = pg_temp.fix_utf8_mojibake(name)
WHERE name LIKE '%Ã%';

UPDATE public.attendance_requests
SET name = pg_temp.fix_utf8_mojibake(name),
    year_level = CASE WHEN year_level LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(year_level) ELSE year_level END,
    college = CASE WHEN college LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(college) ELSE college END,
    program = CASE WHEN program LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(program) ELSE program END,
    institution = CASE WHEN institution LIKE '%Ã%' THEN pg_temp.fix_utf8_mojibake(institution) ELSE institution END
WHERE name LIKE '%Ã%'
   OR year_level LIKE '%Ã%'
   OR college LIKE '%Ã%'
   OR program LIKE '%Ã%'
   OR institution LIKE '%Ã%';

UPDATE public.attendance_request_events
SET event_name = pg_temp.fix_utf8_mojibake(event_name)
WHERE event_name LIKE '%Ã%';

UPDATE public.attendance_event_college_exemptions
SET college_label = pg_temp.fix_utf8_mojibake(college_label)
WHERE college_label LIKE '%Ã%';

-- File names are also persisted inside audit log JSON details. Repair only logs
-- that actually contain the mojibake marker.
UPDATE public.audit_logs
SET details = pg_temp.fix_utf8_mojibake(details::TEXT)::JSONB
WHERE details::TEXT LIKE '%Ã%';

-- Migration 021 is intentionally not rerun here. It uses broader event-name
-- normalization and can merge semantically distinct historical events. This
-- migration only repairs text; existing event IDs and relationships stay intact.

COMMIT;
