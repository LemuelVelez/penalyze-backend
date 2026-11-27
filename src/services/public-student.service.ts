import { isPlaceholderStudentNumber, normalizeStudentNumberKey, placeholderStudentNumberMessage } from "./masterlist-normalize";
import { getMasterlistStatus } from "./masterlist.service";
import type { AttendanceFinalResultRecord, AttendanceRecord } from "../database/model/schema.model";
import { query, withTransaction } from "../lib/db";
import { lookupPublicStudentById } from "./attendance-requests.service";
import {
  listAttendanceEvents,
  listAttendanceFinalResults,
  listAttendanceRecords,
  listManualAttendanceRecords,
} from "./attendance.service";
import { getAttendanceRecordVisibilitySql } from "./attendance-result-visibility";
import { listFines, listPenalties, listPenaltyResults } from "./fines.service";
import { listSchoolYears } from "./school-years.service";

const REFERENCE_CACHE_TTL_MS = 30_000;
type ReferenceData = [Awaited<ReturnType<typeof listPenalties>>, Awaited<ReturnType<typeof listSchoolYears>>, Awaited<ReturnType<typeof listAttendanceEvents>>];
let referenceCache: { expiresAt: number; value: Promise<ReferenceData> } | null = null;

function getPublicReferenceData(): Promise<ReferenceData> {
  const now = Date.now();
  if (referenceCache && referenceCache.expiresAt > now) return referenceCache.value;
  const value = Promise.all([listPenalties(), listSchoolYears(), listAttendanceEvents(500, 0)]) as Promise<ReferenceData>;
  referenceCache = { expiresAt: now + REFERENCE_CACHE_TTL_MS, value };
  value.catch(() => { if (referenceCache?.value === value) referenceCache = null; });
  return value;
}

// Event enrichment is optional; do not make a public lookup wait for multiple
// full database statement timeouts when the semester roster is rebuilding.
const EVENT_DETAIL_BUDGET_MS = 6_000;
const EVENT_DETAIL_QUERY_TIMEOUT_MS = 3_000;

async function attachFinalResultEventDetails(
  studentId: string,
  rows: AttendanceFinalResultRecord[],
  activeSchoolYearId: string | null,
) {
  const schoolYearIds = [...new Set(rows.map((row) => row.school_year_id).filter((id): id is string => Boolean(id)))];
  if (activeSchoolYearId && schoolYearIds.includes(activeSchoolYearId)) {
    schoolYearIds.splice(schoolYearIds.indexOf(activeSchoolYearId), 1);
    schoolYearIds.unshift(activeSchoolYearId);
  }
  const deadline = Date.now() + EVENT_DETAIL_BUDGET_MS;
  const detailsById = new Map<string, Pick<AttendanceFinalResultRecord, "missed_events" | "event_details">>();
  for (const schoolYearId of schoolYearIds) {
    if (Date.now() >= deadline) break;
    try {
      const detailed = await withTransaction(async (client) => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return [];
        // SET LOCAL is scoped to this transaction and cannot affect other pool users.
        await client.query("SELECT set_config('statement_timeout', $1, true)", [
          `${Math.min(remaining, EVENT_DETAIL_QUERY_TIMEOUT_MS)}ms`,
        ]);
        return listAttendanceFinalResults({
          schoolYearId, studentId, limit: 1000, offset: 0,
          includeMissedEvents: true, includeEventDetails: true,
        }, client);
      });
      for (const row of detailed) detailsById.set(String(row.id), { missed_events: row.missed_events, event_details: row.event_details });
    } catch (error) {
      console.error(`Public student event details failed for school year ${schoolYearId}; returning summary only.`, error);
    }
  }
  return rows.map((row) => {
    const details = detailsById.get(String(row.id));
    return details ? { ...row, ...details } : row;
  });
}

// Explicitly allow only fields used by the public result and its existing dialogs.
// An allowlist prevents newly added SQL columns from becoming public by default.
const PUBLIC_RECORD_FIELDS = new Set([
  "id", "school_year_id", "import_id", "event_id", "event_name", "event_order",
  "event_start_at", "event_end_at", "student_id", "year_level", "college",
  "program", "course", "college_key", "no_of_absences", "remarks", "scanned_at",
  "created_at", "updated_at", "attendance_type", "attended_events",
  "expected_events", "total_absences", "absence_calculation_source",
  "attendance_status", "consistency_warning", "latest_scanned_at",
  "source_updated_at", "attendance_record_id", "penalty_id", "prescribed_penalty",
  "status", "attendance_event_id", "attendance_event_name", "attendance_event_order",
  "attendance_event_start_at", "attendance_event_end_at", "attendance_remarks",
  "source_table", "source_record_id",
]);

const PUBLIC_EVENT_FIELDS = new Set([
  "id", "name", "event_order", "event_start_at", "event_end_at",
  "attended", "source", "record_id", "scanned_at", "remarks",
]);

function redactPersonal<T extends { name: string }>(record: T): T {
  const redacted: Record<string, unknown> = { name: "" };
  for (const [key, value] of Object.entries(record)) {
    if (PUBLIC_RECORD_FIELDS.has(key)) redacted[key] = value;
    if ((key === "missed_events" || key === "event_details") && Array.isArray(value)) {
      redacted[key] = value.map((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        return Object.fromEntries(
          Object.entries(item).filter(([field]) => PUBLIC_EVENT_FIELDS.has(field)),
        );
      }).filter(Boolean);
    }
  }
  // Keep the existing record shape for the frontend, without releasing private values.
  if ("institution" in record) redacted.institution = null;
  if ("deleted_at" in record) redacted.deleted_at = null;
  if ("deleted_by" in record) redacted.deleted_by = null;
  if ("delete_reason" in record) redacted.delete_reason = null;
  return redacted as T;
}

async function listCollegeEventStubs(college: string, schoolYearIds: string[]): Promise<AttendanceRecord[]> {
  if (!college.trim() || schoolYearIds.length === 0) return [];

  // Only one synthetic record per event, never other students' attendance rows.
  // The college resolution and hidden/deleted import rules mirror listAttendanceRecords.
  const result = await query<AttendanceRecord>(`
    WITH year_scope AS MATERIALIZED (
      SELECT school_year_id, public.is_masterlist_school_year(school_year_id) AS masterlist_year
      FROM unnest($2::uuid[]) AS years(school_year_id)
    )
    SELECT
      ae.id AS id,
      ae.school_year_id,
      NULL::uuid AS import_id,
      ar.event_id,
      ae.name AS event_name,
      ae.event_order,
      ae.event_start_at,
      ae.event_end_at,
      ''::text AS student_id,
      ''::text AS name,
      NULL::text AS year_level,
      $1::text AS college,
      NULL::text AS program,
      NULL::text AS institution,
      0::int AS no_of_absences,
      NULL::text AS remarks,
      MAX(ar.scanned_at) AS scanned_at,
      NULL::timestamptz AS deleted_at,
      NULL::uuid AS deleted_by,
      NULL::text AS delete_reason,
      MIN(ar.created_at) AS created_at,
      MAX(ar.updated_at) AS updated_at
    FROM attendance_records ar
    JOIN year_scope ys ON ys.school_year_id = ar.school_year_id
    JOIN attendance_events ae ON ae.id = ar.event_id
    LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
    LEFT JOIN student_masterlist m ON ys.masterlist_year AND m.school_year_id = ar.school_year_id AND m.student_number_key = public.masterlist_student_number_key(ar.student_id)
    WHERE ${getAttendanceRecordVisibilitySql("ar")}
      AND ar.school_year_id = ANY($2::uuid[])
      AND NOT (COALESCE(ar.masterlist_status, '')='unmatched' AND ys.masterlist_year)
      AND LOWER(TRIM(COALESCE(CASE WHEN ys.masterlist_year THEN m.college END, NULLIF(TRIM(s.college), ''), ar.college, ''))) = LOWER(TRIM($1))
      AND LOWER(TRIM(COALESCE(ar.remarks, ''))) NOT LIKE '%zero attendance%'
    GROUP BY ae.id, ar.event_id
    ORDER BY ae.event_order ASC NULLS LAST, ae.event_start_at ASC NULLS LAST, ae.id
  `, [college, schoolYearIds]);
  return result.rows;
}

export async function getPublicStudentRecords(studentId: string) {
  if (!/^[A-Za-z0-9-]{4,36}$/.test(studentId.trim())) throw Object.assign(new Error("Enter a valid Student ID."), { statusCode: 400 });
  const cleanStudentId = normalizeStudentNumberKey(studentId);
  if (isPlaceholderStudentNumber(cleanStudentId)) throw Object.assign(new Error(placeholderStudentNumberMessage(studentId.trim())), { statusCode: 400 });
  if (!/^[A-Za-z0-9-]{4,36}$/.test(cleanStudentId)) {
    throw Object.assign(new Error("Enter a valid Student ID."), { statusCode: 400 });
  }

  // Keep each batch small enough that concurrent public searches leave pool
  // capacity for other requests and the semester maintenance jobs.
  const [fallbackProfile, attendance, manualAttendance] = await Promise.all([
    lookupPublicStudentById(cleanStudentId),
    listAttendanceRecords(1000, 0, cleanStudentId, undefined, undefined, undefined, [], false, true),
    listManualAttendanceRecords({ studentId: cleanStudentId, limit: 500, offset: 0, excludeUnresolved: true }),
  ]);
  const [baseFinalResults, fines, penaltyResults] = await Promise.all([
    listAttendanceFinalResults({ studentId: cleanStudentId, limit: 1000, offset: 0 }),
    listFines({ studentId: cleanStudentId, limit: 1000, offset: 0 }),
    listPenaltyResults({ studentId: cleanStudentId, limit: 1000, offset: 0 }),
  ]);

  const [penalties, schoolYears, attendanceEvents] = await getPublicReferenceData();

  const { active, schoolYearId } = await getMasterlistStatus();
  const master = schoolYearId ? (await query<{student_id:string;course:string|null;year_level:string|null;college:string|null}>(`SELECT student_number AS student_id, program AS course, year_level, college FROM student_masterlist WHERE school_year_id=$1 AND student_number_key=public.masterlist_student_number_key($2)`, [schoolYearId, cleanStudentId])).rows[0] : undefined;
  const profile = active && master ? {...master, status: fallbackProfile?.status ?? null} : fallbackProfile;
  const college = profile?.college || attendance.find((row) => row.college)?.college ||
    manualAttendance.find((row) => row.college)?.college ||
    baseFinalResults.find((row) => row.college)?.college ||
    penaltyResults.find((row) => row.college)?.college || "";
  const stubSchoolYearIds = [...new Set([
    ...attendance.map((row) => row.school_year_id),
    ...manualAttendance.map((row) => row.school_year_id),
    ...baseFinalResults.map((row) => row.school_year_id),
    ...penaltyResults.map((row) => row.school_year_id),
    schoolYearId,
    ...schoolYears.filter((row) => row.is_active).map((row) => row.id),
  ].filter((id): id is string => Boolean(id)))];
  const collegeEventRecords = await listCollegeEventStubs(college, stubSchoolYearIds);
  const finalResults = await attachFinalResultEventDetails(cleanStudentId, baseFinalResults, schoolYearId);

  return {
    profile,
    masterlist: { active, schoolYearId, onMasterlist: !!master },
    resolvedCollege: college,
    attendance: attendance.map(redactPersonal),
    manualAttendance: manualAttendance.map(redactPersonal),
    finalResults: finalResults.map(redactPersonal),
    fines: fines.map(redactPersonal),
    penaltyResults: penaltyResults.map(redactPersonal),
    penalties,
    schoolYears,
    attendanceEvents,
    collegeEventRecords,
  };
}
