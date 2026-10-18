ALTER TABLE attendance_imports
  ADD COLUMN IF NOT EXISTS college_key TEXT,
  ADD COLUMN IF NOT EXISTS college_label TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_imports_school_year_college
  ON attendance_imports (school_year_id, college_key);
