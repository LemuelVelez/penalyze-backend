-- Executed in the migration runner's transaction, followed by the TypeScript
-- masterlist repair/reconciliation and derived-results rebuild before registration.
-- This one-time offline rebuild may exceed the normal API statement budget.
-- Keep the lock timeout and transaction rollback behavior unchanged.
SET LOCAL statement_timeout = '0';
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync'));

-- Normalize existing visible source IDs without guessing the student's identity.
-- The TypeScript resolver handles unique name/partial-ID matches and mismatches.
UPDATE public.attendance_records ar
SET student_id = public.masterlist_student_number_key(ar.student_id),
    updated_at = NOW()
WHERE public.is_masterlist_school_year(ar.school_year_id)
  AND EXISTS (SELECT 1 FROM public.student_masterlist m WHERE m.school_year_id = ar.school_year_id)
  AND ar.deleted_at IS NULL
  AND (ar.import_id IS NULL OR EXISTS (
    SELECT 1 FROM public.attendance_imports ai WHERE ai.id = ar.import_id AND ai.deleted_at IS NULL
  ))
  AND public.masterlist_student_number_key(ar.student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
  AND ar.student_id IS DISTINCT FROM public.masterlist_student_number_key(ar.student_id);

-- Match the exact comparison expression in attendanceStudentKeySql. Existing
-- migration 044 indexes remain available for raw masterlist-key lookups.
CREATE INDEX IF NOT EXISTS idx_attendance_records_comparison_key
  ON public.attendance_records (school_year_id, (CASE
    WHEN public.masterlist_student_number_key(student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
    THEN LOWER(public.masterlist_student_number_key(student_id)) ELSE LOWER(TRIM(student_id)) END));

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_comparison_key
  ON public.manual_attendance_records (school_year_id, (CASE
    WHEN public.masterlist_student_number_key(student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
    THEN LOWER(public.masterlist_student_number_key(student_id)) ELSE LOWER(TRIM(student_id)) END));

CREATE INDEX IF NOT EXISTS idx_attendance_overrides_comparison_key
  ON public.attendance_student_event_overrides (school_year_id, (CASE
    WHEN public.masterlist_student_number_key(student_key) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
    THEN LOWER(public.masterlist_student_number_key(student_key)) ELSE LOWER(TRIM(student_key)) END), event_id);

CREATE INDEX IF NOT EXISTS idx_students_comparison_key
  ON public.students ((CASE
    WHEN public.masterlist_student_number_key(student_id) ~ '^TC-[0-9]{2}-[A-Z]-[0-9]{5}$'
    THEN LOWER(public.masterlist_student_number_key(student_id)) ELSE LOWER(TRIM(student_id)) END));
