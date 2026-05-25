BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.school_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  starts_at DATE NOT NULL,
  ends_at DATE NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT school_years_name_format_check CHECK (name ~ '^\d{4}-\d{4}$'),
  CONSTRAINT school_years_valid_range_check CHECK (starts_at <= ends_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_school_years_active_unique
  ON public.school_years(is_active)
  WHERE is_active = TRUE;

WITH source_dates AS (
  SELECT COALESCE(event_start_at, event_end_at, created_at)::DATE AS scope_date
  FROM public.attendance_events
  UNION ALL
  SELECT created_at::DATE AS scope_date
  FROM public.attendance_imports
  UNION ALL
  SELECT COALESCE(scanned_at, created_at)::DATE AS scope_date
  FROM public.attendance_records
  UNION ALL
  SELECT created_at::DATE AS scope_date
  FROM public.fines
  UNION ALL
  SELECT CURRENT_DATE AS scope_date
), school_year_rows AS (
  SELECT DISTINCT
    CASE
      WHEN EXTRACT(MONTH FROM scope_date) >= 6
        THEN CONCAT(EXTRACT(YEAR FROM scope_date)::INT, '-', EXTRACT(YEAR FROM scope_date)::INT + 1)
      ELSE CONCAT(EXTRACT(YEAR FROM scope_date)::INT - 1, '-', EXTRACT(YEAR FROM scope_date)::INT)
    END AS name,
    CASE
      WHEN EXTRACT(MONTH FROM scope_date) >= 6
        THEN MAKE_DATE(EXTRACT(YEAR FROM scope_date)::INT, 6, 1)
      ELSE MAKE_DATE(EXTRACT(YEAR FROM scope_date)::INT - 1, 6, 1)
    END AS starts_at,
    CASE
      WHEN EXTRACT(MONTH FROM scope_date) >= 6
        THEN MAKE_DATE(EXTRACT(YEAR FROM scope_date)::INT + 1, 5, 31)
      ELSE MAKE_DATE(EXTRACT(YEAR FROM scope_date)::INT, 5, 31)
    END AS ends_at
  FROM source_dates
  WHERE scope_date IS NOT NULL
)
INSERT INTO public.school_years (name, starts_at, ends_at)
SELECT name, starts_at, ends_at
FROM school_year_rows
ON CONFLICT (name) DO UPDATE SET
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  updated_at = NOW();

ALTER TABLE public.attendance_events
  ADD COLUMN IF NOT EXISTS school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL;

ALTER TABLE public.attendance_imports
  ADD COLUMN IF NOT EXISTS school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL;

ALTER TABLE public.attendance_records
  ADD COLUMN IF NOT EXISTS school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL;

ALTER TABLE public.fines
  ADD COLUMN IF NOT EXISTS school_year_id UUID REFERENCES public.school_years(id) ON DELETE SET NULL;

WITH event_scope AS (
  SELECT
    e.id,
    sy.id AS school_year_id
  FROM public.attendance_events e
  JOIN public.school_years sy ON sy.name = CASE
    WHEN EXTRACT(MONTH FROM COALESCE(e.event_start_at, e.event_end_at, e.created_at)::DATE) >= 6
      THEN CONCAT(EXTRACT(YEAR FROM COALESCE(e.event_start_at, e.event_end_at, e.created_at)::DATE)::INT, '-', EXTRACT(YEAR FROM COALESCE(e.event_start_at, e.event_end_at, e.created_at)::DATE)::INT + 1)
    ELSE CONCAT(EXTRACT(YEAR FROM COALESCE(e.event_start_at, e.event_end_at, e.created_at)::DATE)::INT - 1, '-', EXTRACT(YEAR FROM COALESCE(e.event_start_at, e.event_end_at, e.created_at)::DATE)::INT)
  END
)
UPDATE public.attendance_events e
SET school_year_id = event_scope.school_year_id,
    updated_at = NOW()
FROM event_scope
WHERE e.id = event_scope.id
  AND e.school_year_id IS NULL;

WITH import_scope AS (
  SELECT
    ai.id,
    COALESCE(e.school_year_id, sy.id) AS school_year_id
  FROM public.attendance_imports ai
  LEFT JOIN public.attendance_events e ON e.id = ai.event_id
  LEFT JOIN public.school_years sy ON sy.name = CASE
    WHEN EXTRACT(MONTH FROM ai.created_at::DATE) >= 6
      THEN CONCAT(EXTRACT(YEAR FROM ai.created_at::DATE)::INT, '-', EXTRACT(YEAR FROM ai.created_at::DATE)::INT + 1)
    ELSE CONCAT(EXTRACT(YEAR FROM ai.created_at::DATE)::INT - 1, '-', EXTRACT(YEAR FROM ai.created_at::DATE)::INT)
  END
)
UPDATE public.attendance_imports ai
SET school_year_id = import_scope.school_year_id
FROM import_scope
WHERE ai.id = import_scope.id
  AND ai.school_year_id IS NULL;

WITH record_scope AS (
  SELECT
    ar.id,
    COALESCE(e.school_year_id, ai.school_year_id, sy.id) AS school_year_id
  FROM public.attendance_records ar
  LEFT JOIN public.attendance_events e ON e.id = ar.event_id
  LEFT JOIN public.attendance_imports ai ON ai.id = ar.import_id
  LEFT JOIN public.school_years sy ON sy.name = CASE
    WHEN EXTRACT(MONTH FROM COALESCE(ar.scanned_at, ar.created_at)::DATE) >= 6
      THEN CONCAT(EXTRACT(YEAR FROM COALESCE(ar.scanned_at, ar.created_at)::DATE)::INT, '-', EXTRACT(YEAR FROM COALESCE(ar.scanned_at, ar.created_at)::DATE)::INT + 1)
    ELSE CONCAT(EXTRACT(YEAR FROM COALESCE(ar.scanned_at, ar.created_at)::DATE)::INT - 1, '-', EXTRACT(YEAR FROM COALESCE(ar.scanned_at, ar.created_at)::DATE)::INT)
  END
)
UPDATE public.attendance_records ar
SET school_year_id = record_scope.school_year_id,
    updated_at = NOW()
FROM record_scope
WHERE ar.id = record_scope.id
  AND ar.school_year_id IS NULL;

WITH fine_scope AS (
  SELECT
    f.id,
    COALESCE(ar.school_year_id, sy.id) AS school_year_id
  FROM public.fines f
  LEFT JOIN public.attendance_records ar ON ar.id = f.attendance_record_id
  LEFT JOIN public.school_years sy ON sy.name = CASE
    WHEN EXTRACT(MONTH FROM f.created_at::DATE) >= 6
      THEN CONCAT(EXTRACT(YEAR FROM f.created_at::DATE)::INT, '-', EXTRACT(YEAR FROM f.created_at::DATE)::INT + 1)
    ELSE CONCAT(EXTRACT(YEAR FROM f.created_at::DATE)::INT - 1, '-', EXTRACT(YEAR FROM f.created_at::DATE)::INT)
  END
)
UPDATE public.fines f
SET school_year_id = fine_scope.school_year_id,
    updated_at = NOW()
FROM fine_scope
WHERE f.id = fine_scope.id
  AND f.school_year_id IS NULL;

WITH current_scope AS (
  SELECT sy.id
  FROM public.school_years sy
  WHERE CURRENT_DATE BETWEEN sy.starts_at AND sy.ends_at
  ORDER BY sy.starts_at DESC
  LIMIT 1
)
UPDATE public.school_years sy
SET is_active = CASE WHEN sy.id = current_scope.id THEN TRUE ELSE FALSE END,
    updated_at = NOW()
FROM current_scope
WHERE NOT EXISTS (SELECT 1 FROM public.school_years WHERE is_active = TRUE);

CREATE INDEX IF NOT EXISTS idx_attendance_events_school_year_id
  ON public.attendance_events(school_year_id);

CREATE INDEX IF NOT EXISTS idx_attendance_imports_school_year_id
  ON public.attendance_imports(school_year_id);

CREATE INDEX IF NOT EXISTS idx_attendance_records_school_year_id
  ON public.attendance_records(school_year_id);

CREATE INDEX IF NOT EXISTS idx_fines_school_year_id
  ON public.fines(school_year_id);

COMMIT;