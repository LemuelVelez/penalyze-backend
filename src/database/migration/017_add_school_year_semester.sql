BEGIN;

ALTER TABLE public.school_years
  ADD COLUMN IF NOT EXISTS semester TEXT;

UPDATE public.school_years
SET semester = 'first_semester'
WHERE semester IS NULL OR semester NOT IN ('first_semester', 'second_semester');

ALTER TABLE public.school_years
  ALTER COLUMN semester SET DEFAULT 'first_semester',
  ALTER COLUMN semester SET NOT NULL;

ALTER TABLE public.school_years
  DROP CONSTRAINT IF EXISTS school_years_name_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'school_years_semester_check'
      AND conrelid = 'public.school_years'::regclass
  ) THEN
    ALTER TABLE public.school_years
      ADD CONSTRAINT school_years_semester_check
      CHECK (semester IN ('first_semester', 'second_semester'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_school_years_name_semester_unique
  ON public.school_years(name, semester);

COMMIT;
