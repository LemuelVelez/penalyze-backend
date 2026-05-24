BEGIN;

DO $$
DECLARE
  role_constraint RECORD;
BEGIN
  FOR role_constraint IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE t.relname = 'users'
      AND n.nspname = 'public'
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%role%'
  LOOP
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT IF EXISTS %I', role_constraint.conname);
  END LOOP;
END $$;

ALTER TABLE public.users
  ALTER COLUMN role SET DEFAULT 'admin';

UPDATE public.users
SET role = 'admin'
WHERE role IS NULL
   OR LOWER(TRIM(role)) NOT IN ('admin', 'officer');

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'officer'));

COMMIT;