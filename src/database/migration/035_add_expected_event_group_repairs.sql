BEGIN;

-- Explicit admin-approved denominator corrections, without changing imported attendance.
-- observed_expected_values makes a correction inapplicable if the source roster changes.
CREATE TABLE IF NOT EXISTS public.attendance_expected_event_group_repairs (
  school_year_id UUID NOT NULL REFERENCES public.school_years(id) ON DELETE CASCADE,
  college_key TEXT NOT NULL,
  year_level_key TEXT NOT NULL DEFAULT '',
  expected_events INTEGER NOT NULL CHECK (expected_events >= 0),
  observed_expected_values INTEGER[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (school_year_id, college_key, year_level_key),
  CHECK (cardinality(observed_expected_values) > 1)
);

COMMIT;
