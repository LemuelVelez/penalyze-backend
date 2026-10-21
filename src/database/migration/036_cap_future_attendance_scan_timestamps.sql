BEGIN;

-- Repair existing future scan times in storage, not just when displaying them.
UPDATE public.attendance_records
SET scanned_at = NOW()
WHERE scanned_at > NOW();

UPDATE public.manual_attendance_records
SET scanned_at = NOW(), updated_at = NOW()
WHERE scanned_at > NOW();

-- Keep saved final results consistent until the next attendance refresh.
UPDATE public.attendance_final_results
SET latest_scanned_at = NOW(), source_updated_at = NOW(), updated_at = NOW()
WHERE latest_scanned_at > NOW();

COMMIT;
