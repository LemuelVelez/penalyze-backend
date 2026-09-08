BEGIN;

ALTER TABLE attendance_imports
  ADD COLUMN IF NOT EXISTS uploaded_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS event_name_snapshot TEXT NULL,
  ADD COLUMN IF NOT EXISTS needs_reattachment BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE attendance_records
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS deleted_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT NULL;

UPDATE attendance_imports ai
SET event_name_snapshot = ae.name
FROM attendance_events ae
WHERE ai.event_id = ae.id
  AND NULLIF(TRIM(ai.event_name_snapshot), '') IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_imports_active_school_year_created
  ON attendance_imports (school_year_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_imports_active_event
  ON attendance_imports (event_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_imports_deleted_at
  ON attendance_imports (deleted_at DESC)
  WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_records_active_import
  ON attendance_records (import_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_records_active_event_student
  ON attendance_records (event_id, LOWER(TRIM(student_id)))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_records_active_school_year_student
  ON attendance_records (school_year_id, LOWER(TRIM(student_id)))
  WHERE deleted_at IS NULL;

COMMIT;
