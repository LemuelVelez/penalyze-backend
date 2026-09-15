BEGIN;

-- Dashboard and per-student detail loads frequently need the newest visible
-- attendance rows inside one school year.
CREATE INDEX IF NOT EXISTS idx_attendance_records_active_school_year_scan_desc
  ON public.attendance_records (
    school_year_id,
    scanned_at DESC,
    created_at DESC
  )
  WHERE deleted_at IS NULL;

-- Student event/detail dialogs always scope manual records by school year and
-- normalized student ID. Keep that lookup narrow as the table grows.
CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_school_year_student_scan
  ON public.manual_attendance_records (
    school_year_id,
    LOWER(TRIM(student_id)),
    scanned_at DESC,
    created_at DESC
  );

-- Penalty-result listing repeatedly verifies that a student still has a current
-- final result with absences. This partial index makes that existence check cheap.
CREATE INDEX IF NOT EXISTS idx_attendance_final_results_school_year_student_with_absences
  ON public.attendance_final_results (
    school_year_id,
    LOWER(TRIM(student_id))
  )
  WHERE total_absences > 0;

COMMIT;
