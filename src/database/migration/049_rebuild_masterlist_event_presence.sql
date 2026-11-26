-- Migration 048 already exists. Re-run the corrected resolver and derived rebuild
-- inside the migration runner transaction, including on upgraded installations.
SET LOCAL statement_timeout = '0';
SET LOCAL lock_timeout = '60000ms';
SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync'));
