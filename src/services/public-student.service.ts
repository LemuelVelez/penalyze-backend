import type { AttendanceRecord } from "../database/model/schema.model";
import { query } from "../lib/db";
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

async function listCollegeEventStubs(college: string): Promise<AttendanceRecord[]> {
  if (!college.trim()) return [];

  // Only one synthetic record per event, never other students' attendance rows.
  // The college resolution and hidden/deleted import rules mirror listAttendanceRecords.
  const result = await query<AttendanceRecord>(`
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
    JOIN attendance_events ae ON ae.id = ar.event_id
    LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
    WHERE ${getAttendanceRecordVisibilitySql("ar")}
      AND LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), ar.college, ''))) = LOWER(TRIM($1))
      AND LOWER(TRIM(COALESCE(ar.remarks, ''))) NOT LIKE '%zero attendance%'
    GROUP BY ae.id, ar.event_id
    ORDER BY ae.event_order ASC NULLS LAST, ae.event_start_at ASC NULLS LAST, ae.id
  `, [college]);
  return result.rows;
}

export async function getPublicStudentRecords(studentId: string) {
  const cleanStudentId = studentId.trim();
  if (!/^[A-Za-z0-9-]{4,36}$/.test(cleanStudentId)) {
    throw Object.assign(new Error("Enter a valid Student ID."), { statusCode: 400 });
  }

  const [profile, attendance, manualAttendance, finalResults, fines, penaltyResults,
    penalties, schoolYears, attendanceEvents] = await Promise.all([
    lookupPublicStudentById(cleanStudentId),
    listAttendanceRecords(1000, 0, cleanStudentId),
    listManualAttendanceRecords({ studentId: cleanStudentId, limit: 500, offset: 0 }),
    listAttendanceFinalResults({
      studentId: cleanStudentId,
      limit: 1000,
      offset: 0,
      includeMissedEvents: true,
      includeEventDetails: true,
    }),
    listFines({ studentId: cleanStudentId, limit: 1000, offset: 0 }),
    listPenaltyResults({ studentId: cleanStudentId, limit: 1000, offset: 0 }),
    listPenalties(),
    listSchoolYears(),
    listAttendanceEvents(500, 0),
  ]);

  const college = profile?.college || attendance.find((row) => row.college)?.college ||
    manualAttendance.find((row) => row.college)?.college ||
    finalResults.find((row) => row.college)?.college ||
    penaltyResults.find((row) => row.college)?.college || "";
  const collegeEventRecords = await listCollegeEventStubs(college);

  return {
    profile,
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
