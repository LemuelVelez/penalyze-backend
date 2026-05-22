BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS attendance_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  event_date DATE NULL,
  description TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE attendance_imports
ADD COLUMN IF NOT EXISTS event_id UUID NULL;

ALTER TABLE attendance_records
ADD COLUMN IF NOT EXISTS event_id UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_imports_event_id_fkey'
  ) THEN
    ALTER TABLE attendance_imports
    ADD CONSTRAINT attendance_imports_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES attendance_events(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendance_records_event_id_fkey'
  ) THEN
    ALTER TABLE attendance_records
    ADD CONSTRAINT attendance_records_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES attendance_events(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_events_event_date ON attendance_events(event_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_records_event_id ON attendance_records(event_id);
CREATE INDEX IF NOT EXISTS idx_attendance_records_student_event ON attendance_records(student_id, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_records_student_event_unique
ON attendance_records(LOWER(TRIM(student_id)), event_id)
WHERE event_id IS NOT NULL;

COMMIT;