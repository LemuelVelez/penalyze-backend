import { isPlaceholderStudentNumber, normalizeStudentNumberKey, placeholderStudentNumberMessage } from "./masterlist-normalize";
import { getMasterlistStatus } from "./masterlist.service";
import type { AttendanceFinalResultRecord, AttendanceRecord } from "../database/model/schema.model";
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

export type PublicStudentRecordsProgress = {
  percent: number;
  message: string;
  detail: string;
};
type ProgressCallback = (progress: PublicStudentRecordsProgress) => void;

async function attachFinalResultEventDetails(
  studentId: string,
  rows: AttendanceFinalResultRecord[],
  activeSchoolYearId: string | null,
  report: ProgressCallback,
) {
  const schoolYearIds = [...new Set(rows.map((row) => row.school_year_id).filter((id): id is string => Boolean(id)))];
  if (activeSchoolYearId && schoolYearIds.includes(activeSchoolYearId)) {
    schoolYearIds.splice(schoolYearIds.indexOf(activeSchoolYearId), 1);
    schoolYearIds.unshift(activeSchoolYearId);
  }
  const detailsById = new Map<string, Pick<AttendanceFinalResultRecord, "missed_events" | "event_details">>();
  let completed = 0;
  let unavailable = 0;
  for (const schoolYearId of schoolYearIds) {
    try {
      const detailed = await listAttendanceFinalResults({
        schoolYearId, studentId, limit: 1000, offset: 0,
        includeMissedEvents: true, includeEventDetails: true,
      });
      for (const row of detailed) detailsById.set(String(row.id), { missed_events: row.missed_events, event_details: row.event_details });
    } catch (error) {
      unavailable++;
      console.error(`Public student event details failed for school year ${schoolYearId}; returning summary only.`, error);
    }
    completed++;
    report({
      percent: 66 + Math.round(14 * completed / schoolYearIds.length),
      message: "Checking event details...",
      detail: `${completed} of ${schoolYearIds.length} school year(s) checked.${unavailable ? " Saved summaries will be used where details are unavailable." : ""}`,
    });
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

export async function getPublicStudentRecords(studentId: string, onProgress?: ProgressCallback) {
  if (!/^[A-Za-z0-9-]{4,36}$/.test(studentId.trim())) throw Object.assign(new Error("Enter a valid Student ID."), { statusCode: 400 });
  const cleanStudentId = normalizeStudentNumberKey(studentId);
  if (isPlaceholderStudentNumber(cleanStudentId)) throw Object.assign(new Error(placeholderStudentNumberMessage(studentId.trim())), { statusCode: 400 });
  if (!/^[A-Za-z0-9-]{4,36}$/.test(cleanStudentId)) {
    throw Object.assign(new Error("Enter a valid Student ID."), { statusCode: 400 });
  }

  let percent = 4;
  const report: ProgressCallback = (progress) => {
    percent = Math.max(percent, progress.percent);
    onProgress?.({ ...progress, percent });
  };
  const completed = <T>(request: Promise<T>, weight: number, message: string, detail: string): Promise<T> =>
    request.then((value) => {
      report({ percent: percent + weight, message, detail });
      return value;
    });
  report({ percent, message: "Searching student records...", detail: "Checking your student profile and attendance history." });

  // Report each completed read, while keeping concurrent pool usage bounded.
  const [fallbackProfile, attendance, manualAttendance] = await Promise.all([
    completed(lookupPublicStudentById(cleanStudentId), 6, "Student profile checked...", "Matching your Student ID."),
    completed(listAttendanceRecords(1000, 0, cleanStudentId, undefined, undefined, undefined, [], false, true), 9, "Attendance history checked...", "Uploaded attendance records have been checked."),
    completed(listManualAttendanceRecords({ studentId: cleanStudentId, limit: 500, offset: 0, excludeUnresolved: true }), 6, "Manual attendance checked...", "Manual attendance records have been checked."),
  ]);
  report({ percent: 25, message: "Checking absences and fines...", detail: "Loading saved attendance results and penalties." });
  const [baseFinalResults, fines, penaltyResults] = await Promise.all([
    completed(listAttendanceFinalResults({ studentId: cleanStudentId, limit: 1000, offset: 0 }), 8, "Attendance results checked...", "Saved absence totals have been checked."),
    completed(listFines({ studentId: cleanStudentId, limit: 1000, offset: 0 }), 6, "Fines checked...", "Student fine records have been checked."),
    completed(listPenaltyResults({ studentId: cleanStudentId, limit: 1000, offset: 0 }), 6, "Penalty results checked...", "Calculated penalties have been checked."),
  ]);

  report({ percent: 45, message: "Loading reference data...", detail: "Checking school years, penalties, and attendance events." });
  const [penalties, schoolYears, attendanceEvents] = await getPublicReferenceData();
  report({ percent: 53, message: "Checking masterlist...", detail: "Resolving your school year and college." });

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
  report({ percent: 58, message: "Checking college events...", detail: "Finding attendance events for your college and school years." });
  const collegeEventRecords = await listCollegeEventStubs(college, stubSchoolYearIds);
  report({ percent: 66, message: "Checking event details...", detail: "Matching event details and missed events by school year." });
  const finalResults = await attachFinalResultEventDetails(cleanStudentId, baseFinalResults, schoolYearId, report);
  report({ percent: 82, message: "Student records checked...", detail: "Preparing the attendance records for delivery." });

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
