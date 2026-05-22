BEGIN;

UPDATE users
SET role = 'admin'
WHERE role <> 'admin';

ALTER TABLE users
DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users
ALTER COLUMN role SET DEFAULT 'admin';

ALTER TABLE users
ADD CONSTRAINT users_role_check CHECK (role = 'admin');

COMMIT;
