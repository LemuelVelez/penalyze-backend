# penalyze-backend

## Penalyze ↔ AttendanceRepository sync

Configure these server-side environment variables (never expose the integration key to a Vite frontend):

- **penalyze-backend:** `ATTENDANCE_REPOSITORY_URL=https://attendance-repo.jrmsu-tc.cloud` (HTTPS origin only; no trailing slash or `/api`) and `PENALYZE_INTEGRATION_KEY=<shared-secret>`.
- **AttendanceRepository:** `PENALYZE_INTEGRATION_KEY=<shared-secret>`.

The integration key **must match on both services**. Restart **both services** after changing the environment variables; each reads its environment at startup.

| Repository Sync page error | Cause |
| --- | --- |
| "integration is not configured" | Repository URL or integration key is missing in penalyze-backend. |
| "penalyze integration disabled" | Integration key is missing in AttendanceRepository. |
| "rejected the integration credentials" | The keys do not match. |
| "AttendanceRepository is unavailable" | Repository URL is wrong, unreachable, or redirects. |
