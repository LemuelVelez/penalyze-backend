
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.manual_attendance_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL,
  event_id UUID REFERENCES public.attendance_events(id) ON DELETE SET NULL,
  attendance_type TEXT NOT NULL DEFAULT 'manual',
  student_id TEXT NOT NULL,
  name TEXT NOT NULL,
  year_level TEXT,
  college TEXT,
  program TEXT,
  institution TEXT,
  no_of_absences INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  scanned_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT manual_attendance_records_type_check CHECK (attendance_type IN ('manual', 'zero_attendance')),
  CONSTRAINT manual_attendance_records_absences_check CHECK (no_of_absences >= 0),
  CONSTRAINT manual_attendance_records_student_check CHECK (TRIM(student_id) <> ''),
  CONSTRAINT manual_attendance_records_name_check CHECK (TRIM(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_school_year
  ON public.manual_attendance_records(school_year_id);

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_event
  ON public.manual_attendance_records(event_id);

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_student
  ON public.manual_attendance_records(LOWER(TRIM(student_id)));

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_college
  ON public.manual_attendance_records(LOWER(TRIM(COALESCE(college, ''))));

CREATE INDEX IF NOT EXISTS idx_manual_attendance_records_type
  ON public.manual_attendance_records(attendance_type);

COMMIT;