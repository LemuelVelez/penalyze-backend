BEGIN;

ALTER TABLE attendance_events
ADD COLUMN IF NOT EXISTS event_start_at TIMESTAMPTZ NULL,
ADD COLUMN IF NOT EXISTS event_end_at TIMESTAMPTZ NULL;

ALTER TABLE attendance_records
ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'attendance_events'
      AND column_name = 'event_date'
  ) THEN
    UPDATE attendance_events
    SET event_start_at = COALESCE(event_start_at, event_date::TIMESTAMPTZ)
    WHERE event_date IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_events_event_start_at ON attendance_events(event_start_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_events_event_end_at ON attendance_events(event_end_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_records_scanned_at ON attendance_records(scanned_at DESC);

COMMIT;