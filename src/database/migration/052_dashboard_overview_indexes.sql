SET LOCAL lock_timeout = '5000ms';
SET LOCAL statement_timeout = '180000ms';
CREATE INDEX IF NOT EXISTS idx_attendance_records_dashboard_recent
  ON attendance_records (school_year_id, (COALESCE(scanned_at, created_at)) DESC, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
