BEGIN;

DO $$
DECLARE
  constraint_record RECORD;
BEGIN
  FOR constraint_record IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'attendance_records'::REGCLASS
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%student_id%'
      AND pg_get_constraintdef(oid) ILIKE '%event_id%'
  LOOP
    EXECUTE FORMAT('ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS %I', constraint_record.conname);
  END LOOP;
END $$;

DO $$
DECLARE
  index_record RECORD;
BEGIN
  FOR index_record IN
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = CURRENT_SCHEMA()
      AND tablename = 'attendance_records'
      AND indexdef ILIKE '%UNIQUE%'
      AND indexdef ILIKE '%student_id%'
      AND indexdef ILIKE '%event_id%'
  LOOP
    EXECUTE FORMAT('DROP INDEX IF EXISTS %I', index_record.indexname);
  END LOOP;
END $$;

DROP INDEX IF EXISTS attendance_records_event_id_student_id_key;
DROP INDEX IF EXISTS attendance_records_event_student_id_key;
DROP INDEX IF EXISTS attendance_records_student_event_key;
DROP INDEX IF EXISTS idx_attendance_records_event_student_unique;
DROP INDEX IF EXISTS idx_attendance_records_unique_event_student;

CREATE INDEX IF NOT EXISTS idx_attendance_records_student_event_scan
ON attendance_records (LOWER(TRIM(student_id)), event_id, scanned_at DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_attendance_records_import_student_event
ON attendance_records (import_id, LOWER(TRIM(student_id)), event_id);

COMMIT;