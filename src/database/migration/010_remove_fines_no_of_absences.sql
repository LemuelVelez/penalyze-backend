BEGIN;

ALTER TABLE public.fines
  ADD COLUMN IF NOT EXISTS attendance_record_id UUID;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'fines'
      AND column_name = 'no_of_absences'
  ) THEN
    EXECUTE $migration$
      WITH ranked_matches AS (
        SELECT
          f.id AS fine_id,
          ar.id AS attendance_record_id,
          ROW_NUMBER() OVER (
            PARTITION BY f.id
            ORDER BY ar.updated_at DESC, ar.created_at DESC
          ) AS match_rank
        FROM public.fines f
        JOIN public.attendance_records ar
          ON LOWER(TRIM(ar.student_id)) = LOWER(TRIM(f.student_id))
         AND COALESCE(ar.no_of_absences, 0) = COALESCE(f.no_of_absences, 0)
        WHERE f.attendance_record_id IS NULL
      )
      UPDATE public.fines f
      SET attendance_record_id = ranked_matches.attendance_record_id,
          updated_at = NOW()
      FROM ranked_matches
      WHERE ranked_matches.fine_id = f.id
        AND ranked_matches.match_rank = 1
    $migration$;
  END IF;
END $$;

UPDATE public.fines f
SET attendance_record_id = NULL,
    updated_at = NOW()
WHERE f.attendance_record_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.attendance_records ar
    WHERE ar.id = f.attendance_record_id
  );

CREATE INDEX IF NOT EXISTS idx_fines_attendance_record_id
  ON public.fines(attendance_record_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fines_attendance_record_id_fkey'
      AND conrelid = 'public.fines'::regclass
  ) THEN
    ALTER TABLE public.fines
      ADD CONSTRAINT fines_attendance_record_id_fkey
      FOREIGN KEY (attendance_record_id)
      REFERENCES public.attendance_records(id)
      ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE public.fines
  DROP COLUMN IF EXISTS no_of_absences;

COMMIT;