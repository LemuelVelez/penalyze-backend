-- Categorize historical records without removing or replacing any audit entry.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS category TEXT;

UPDATE audit_logs
SET category = CASE
  WHEN method = 'SYSTEM' THEN 'System'
  WHEN route ~ '^/api/(auth|users)(/|$)' THEN 'Authentication & Accounts'
  WHEN route LIKE '/api/school-years%' THEN 'School Years'
  WHEN route LIKE '/api/attendance/requests%' THEN 'Attendance Requests'
  WHEN route ~ '^/api/attendance/event-(year-level-)?exemptions(/|$)' THEN 'Attendance Exemptions'
  WHEN route LIKE '/api/attendance/events%' THEN 'Attendance Events'
  WHEN route ~ '^/api/attendance/imports?(/|$)' THEN 'Attendance Imports'
  WHEN route LIKE '/api/attendance/manual%' THEN 'Manual Attendance'
  WHEN route LIKE '/api/attendance/calculation-results%' THEN 'Calculation Results'
  WHEN route LIKE '/api/attendance/%' THEN 'Attendance Records & Final Results'
  WHEN route LIKE '/api/fines%' THEN 'Penalties & Fines'
  WHEN route LIKE '/api/repository-sync%' THEN 'Repository Sync'
  ELSE 'Other'
END;

ALTER TABLE audit_logs ALTER COLUMN category SET DEFAULT 'Other';
ALTER TABLE audit_logs ALTER COLUMN category SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_category_created_at
  ON audit_logs(category, created_at DESC);

-- Preserve the original machine identifiers and the legacy resource scope so
-- repeated inconsistency detections can still be de-duplicated after relabeling.
UPDATE audit_logs
SET details = jsonb_set(
    jsonb_set(details, '{eventCode}', to_jsonb(action), true),
    '{consistencyTable}', to_jsonb(resource_type), true
  ),
  action = 'Detected expected-event total inconsistency',
  resource_type = 'calculation result'
WHERE action = 'attendance_expected_events_consistency_violation';

UPDATE audit_logs
SET details = jsonb_set(details, '{eventCode}', to_jsonb(action), true),
  action = 'Automatically repaired expected-event totals',
  resource_type = 'calculation result'
WHERE action = 'attendance_expected_events_auto_repaired';

-- Relabel previously generic actions by the actual method and endpoint.
UPDATE audit_logs SET action = 'Checked attendance calculation status', resource_type = 'calculation result'
WHERE method = 'POST' AND route = '/api/attendance/calculation-results/status'
  AND action = 'Created status';

UPDATE audit_logs SET action = 'Repaired attendance calculation consistency', resource_type = 'calculation result'
WHERE method = 'POST' AND route = '/api/attendance/calculation-results/repair-consistency'
  AND action IN ('Created repair consistency', 'Created repair-consistency');

UPDATE audit_logs SET action = 'Previewed attendance event college exemption impact', resource_type = 'attendance event college exemption'
WHERE method = 'POST' AND route = '/api/attendance/event-exemptions/impact'
  AND action IN ('Created impact', 'Created event exemptions impact');

UPDATE audit_logs SET action = 'Marked repository uploads as pending', resource_type = 'repository upload'
WHERE method = 'POST' AND route = '/api/repository-sync/pending'
  AND action = 'Created pending';

UPDATE audit_logs SET action = 'Marked repository uploads as uploaded', resource_type = 'repository upload'
WHERE method = 'POST' AND route = '/api/repository-sync/uploaded'
  AND action = 'Created uploaded';

UPDATE audit_logs SET action = 'Reset repository upload status', resource_type = 'repository upload'
WHERE method = 'POST' AND route = '/api/repository-sync/reset'
  AND action = 'Created reset';

UPDATE audit_logs SET action = 'Updated student event attendance (batch)', resource_type = 'attendance final result'
WHERE method = 'PATCH' AND route ~ '^/api/attendance/final-results/[^/]+/events/batch/progress$'
  AND action = 'Updated attendance record';

UPDATE audit_logs SET action = 'Updated student event attendance', resource_type = 'attendance final result'
WHERE method = 'PATCH' AND route ~ '^/api/attendance/final-results/[^/]+/events/[^/]+(/progress)?$'
  AND action = 'Updated attendance record';

UPDATE audit_logs SET action = 'Updated student profile in final results', resource_type = 'attendance final result'
WHERE method = 'PATCH' AND route ~ '^/api/attendance/final-results/[^/]+/profile$'
  AND action = 'Updated attendance record';

UPDATE audit_logs SET action = 'Updated penalty result payment status', resource_type = 'penalty result'
WHERE method = 'PATCH' AND route ~ '^/api/fines/penalty-results/[^/]+/status$'
  AND action IN ('Updated penalty result', 'Updated fine status');

UPDATE audit_logs SET action = 'Transferred school year records', resource_type = 'school year records'
WHERE method = 'PATCH' AND route = '/api/school-years/transfer'
  AND action = 'Updated school year';
