import type { PoolClient } from "pg";

import type {
  AttendanceRequestEventRecord,
  AttendanceRequestRecord,
  AttendanceRequestStatus,
  AttendanceRequestType,
  SchoolSemester,
} from "../database/model/schema.model";
import { query, withTransaction } from "../lib/db";
import {
  attendanceEventRosterScopeCteSql,
  applyExemptionsToPendingAttendanceRequests,
  getEventCollegeExemptionFilterSql,
  getEventYearLevelExemptionFilterSql,
  normalizeCollegeKey,
  normalizeYearLevelKey,
  tryLockAttendanceAbsenceSync,
  listAttendanceAbsenceSyncLockHolders,
  refreshDerivedAttendanceResultsForSchoolYearsWithClient,
  syncAbsencesForStudents,
} from "./attendance.service";
import { getAttendanceRecordVisibilitySql } from "./attendance-result-visibility";

type AttendanceRequestEventInput = {
  eventId?: unknown;
  eventName?: unknown;
  evidenceUrl?: unknown;
};

export type AttendanceRequestInput = {
  requestType?: unknown;
  honeypot?: unknown;
  formStartedAt?: unknown;
  schoolYearId?: unknown;
  studentId?: unknown;
  name?: unknown;
  yearLevel?: unknown;
  college?: unknown;
  program?: unknown;
  institution?: unknown;
  note?: unknown;
  evidenceUrl?: unknown;
  events?: unknown;
};

export type AttendanceRequestListOptions = {
  status?: unknown;
  requestType?: unknown;
  schoolYearId?: unknown;
  studentId?: unknown;
};

export type AttendanceRequestReviewInput = {
  status?: unknown;
  reviewNote?: unknown;
};

export type AttendanceRequestGroupReviewInput = AttendanceRequestReviewInput & {
  studentId?: unknown;
  requestIds?: unknown;
};

export type AttendanceRequestGroupReviewResult = {
  requests: AttendanceRequestView[];
  approvedCount: number;
  rejectedCount: number;
  autoClosedCount: number;
  createdAttendanceCount: number;
  updatedRowCount: number;
  removedExemptedEventCount: number;
};

export type AttendanceRequestReviewProgress = {
  stage:
    | "validating"
    | "resolving_events"
    | "adding_attendance"
    | "waiting_for_lock"
    | "syncing_absences"
    | "updating_records"
    | "refreshing_final_results"
    | "refreshing_calculations"
    | "refreshing_penalties"
    | "finalizing";
  percent: number;
  message: string;
  completed?: number;
  total?: number;
};

type AttendanceRequestReviewProgressCallback = (
  progress: AttendanceRequestReviewProgress,
) => void;

type AttendanceRequestView = AttendanceRequestRecord & {
  school_year_name: string;
  semester: SchoolSemester;
  reviewed_by_name: string | null;
  events: AttendanceRequestEventRecord[];
};

type AttendanceRequestEventWithSchoolYear = AttendanceRequestEventRecord & {
  school_year_id: string | null;
};

const REQUEST_STATUSES: AttendanceRequestStatus[] = [
  "pending",
  "approved",
  "rejected",
];

const REQUEST_TYPES: AttendanceRequestType[] = [
  "event_review",
  "details_correction",
  "zero_attendance",
];

const ZERO_ATTENDANCE_REMARK = "Zero attendance registration from landing page.";
const DEFAULT_REQUEST_INSTITUTION = "Jose Rizal Memorial State University - Tampilisan Campus";

const REQUEST_INSTITUTION_SELECTION = `
  COALESCE(
    NULLIF(TRIM(ar.institution), ''),
    (SELECT NULLIF(TRIM(s.institution), '') FROM students s
     WHERE LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
       AND NULLIF(TRIM(s.institution), '') IS NOT NULL
     ORDER BY s.updated_at DESC LIMIT 1),
    (SELECT NULLIF(TRIM(a.institution), '') FROM attendance_records a
     WHERE LOWER(TRIM(a.student_id)) = LOWER(TRIM(ar.student_id))
       AND a.deleted_at IS NULL AND NULLIF(TRIM(a.institution), '') IS NOT NULL
     ORDER BY a.updated_at DESC LIMIT 1),
    (SELECT NULLIF(TRIM(m.institution), '') FROM manual_attendance_records m
     WHERE LOWER(TRIM(m.student_id)) = LOWER(TRIM(ar.student_id))
       AND NULLIF(TRIM(m.institution), '') IS NOT NULL
     ORDER BY m.updated_at DESC LIMIT 1),
    (SELECT NULLIF(TRIM(f.institution), '') FROM attendance_final_results f
     WHERE LOWER(TRIM(f.student_id)) = LOWER(TRIM(ar.student_id))
       AND NULLIF(TRIM(f.institution), '') IS NOT NULL
     ORDER BY f.updated_at DESC LIMIT 1),
    (SELECT NULLIF(TRIM(c.institution), '') FROM calculation_results c
     WHERE LOWER(TRIM(c.student_id)) = LOWER(TRIM(ar.student_id))
       AND NULLIF(TRIM(c.institution), '') IS NOT NULL
     ORDER BY c.updated_at DESC LIMIT 1),
    '${DEFAULT_REQUEST_INSTITUTION}'
  ) AS institution
`;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function createHttpError(message: string, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, expose: true });
}

function normalizeRequestStatus(value: unknown, allowPending = true) {
  const status = cleanText(value).toLowerCase() as AttendanceRequestStatus;
  const allowed = allowPending
    ? REQUEST_STATUSES
    : REQUEST_STATUSES.filter((item) => item !== "pending");

  if (!allowed.includes(status)) {
    throw createHttpError(
      allowPending
        ? "Attendance request status must be pending, approved, or rejected."
        : "Review status must be approved or rejected.",
    );
  }

  return status;
}

function normalizeRequestType(value: unknown, defaultToEventReview = true) {
  const raw = cleanText(value).toLowerCase();
  if (!raw && defaultToEventReview) return "event_review" as AttendanceRequestType;

  const requestType = raw as AttendanceRequestType;
  if (!REQUEST_TYPES.includes(requestType)) {
    throw createHttpError(
      "Attendance request type must be event_review, details_correction, or zero_attendance.",
    );
  }
  return requestType;
}

function normalizeComparable(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").toLowerCase();
}

function valuesDiffer(left: unknown, right: unknown) {
  return normalizeComparable(left) !== normalizeComparable(right);
}

function normalizeEvidenceUrl(value: unknown) {
  const text = cleanText(value);
  if (!text) throw createHttpError("An evidence link is required for every selected event.");
  if (text.length > 2048) throw createHttpError("Evidence links must be 2048 characters or fewer.");

  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password ||
        (process.env.NODE_ENV === "production" ? parsed.protocol !== "https:" :
          parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      throw new Error("Unsafe evidence URL");
    }
  } catch {
    throw createHttpError(
      "Evidence must be a valid http/https link, such as Google Drive, OneDrive, Dropbox, iCloud, or another accessible link.",
    );
  }

  return text;
}

function normalizeRequestEvents(value: unknown) {
  if (!Array.isArray(value) || !value.length) {
    throw createHttpError("Select at least one event you attended and provide an evidence link.");
  }

  if (value.length > 30) {
    throw createHttpError("A request can include at most 30 events.");
  }

  const seen = new Set<string>();
  return value.map((raw) => {
    const input = (raw ?? {}) as AttendanceRequestEventInput;
    const eventId = cleanText(input.eventId);
    if (!eventId) throw createHttpError("Every requested event must have an event ID.");
    if (!isUuid(eventId)) throw createHttpError("One or more selected event IDs are invalid.");
    if (seen.has(eventId)) throw createHttpError("The same event cannot be requested twice.");
    seen.add(eventId);

    return {
      eventId,
      evidenceUrl: normalizeEvidenceUrl(input.evidenceUrl),
    };
  });
}

// Keep approval writes atomic with imports, reconciliation and other reviews.
// Poll the same transaction advisory lock without aborting/restarting the
// transaction every 60 seconds. Report real wait time, not fictional progress.
const configuredReviewLockWait = Number(process.env.ATTENDANCE_REVIEW_LOCK_WAIT_MS ?? 600000);
const REVIEW_LOCK_WAIT_MS = Number.isFinite(configuredReviewLockWait)
  ? Math.min(1800000, Math.max(1000, Math.floor(configuredReviewLockWait)))
  : 600000;
const REVIEW_LOCK_POLL_MS = 1000;
const REVIEW_LOCK_PROGRESS_MS = 5000;

async function prepareAttendanceReviewTransaction(
  client: PoolClient,
  status: AttendanceRequestStatus,
  emit: AttendanceRequestReviewProgressCallback,
  isDisconnected?: () => boolean,
) {
  if (status !== "approved") return;
  await client.query("SELECT set_config('statement_timeout','180000ms',true)");
  await client.query("SELECT set_config('lock_timeout','60000ms',true)");
  await client.query("SELECT set_config('application_name','penalyze: attendance request review',true)");
  const started = Date.now();
  let nextProgress = started;
  while (true) {
    if (isDisconnected?.()) {
      throw createHttpError("Approval was disconnected before it started. No changes were saved.", 409);
    }
    const now = Date.now();
    if (now >= nextProgress) {
      const elapsed = Math.floor((now - started) / 1000);
      emit({ stage: "validating", percent: 5, message: elapsed
        ? `Another attendance update is running. Waiting for database access (${elapsed}s elapsed). Approval will continue automatically.`
        : "Waiting for attendance recalculation access." });
      nextProgress = now + REVIEW_LOCK_PROGRESS_MS;
    }
    if (await tryLockAttendanceAbsenceSync(client)) {
      if (isDisconnected?.()) {
        throw createHttpError("Approval was disconnected before it started. No changes were saved.", 409);
      }
      emit({ stage: "validating", percent: 7, message: "Attendance database lock acquired. Checking selected requests." });
      return;
    }
    const remaining = REVIEW_LOCK_WAIT_MS - (Date.now() - started);
    if (remaining <= 0) {
      // A distinct application code prevents withTransaction from repeating the
      // entire wait via its automatic PostgreSQL lock-timeout retry policy.
      // Diagnostic metadata stays in server logs, not in the public response.
      // If the owner disappears between the failed try and this query, the
      // empty list simply means the lock was released at the deadline.
      const holders = await listAttendanceAbsenceSyncLockHolders(client).catch(() => []);
      throw Object.assign(new Error("Attendance review lock wait expired"), {
        code: "ATTENDANCE_REVIEW_LOCK_TIMEOUT",
        waitedMs: Date.now() - started,
        holders,
      });
    }
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(REVIEW_LOCK_POLL_MS, remaining)));
  }
}

async function getRequestableEventIds(
  client: PoolClient,
  schoolYearId: string,
  studentId: string,
  collegeKey: string,
  eventIds: string[],
): Promise<Set<string>> {
  if (!eventIds.length) return new Set<string>();
  const result = await client.query<{ id: string }>(
    `WITH ${attendanceEventRosterScopeCteSql("$1", "$4")}
     SELECT DISTINCT roster.event_id::text AS id
     FROM event_roster_scope roster
     LEFT JOIN attendance_student_event_overrides correction
       ON correction.school_year_id IS NOT DISTINCT FROM roster.school_year_id
      AND correction.student_key = LOWER(TRIM($2))
      AND correction.event_id = roster.event_id
     WHERE roster.school_year_id = $1::uuid
       AND roster.college_key = $3::text
       AND roster.event_id = ANY($4::uuid[])
       AND (
         (correction.id IS NOT NULL AND correction.attended = FALSE)
         OR (
           correction.id IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM attendance_records attended_record
             LEFT JOIN attendance_imports attended_import
               ON attended_import.id = attended_record.import_id
              AND attended_import.deleted_at IS NULL
             WHERE ${getAttendanceRecordVisibilitySql("attended_record")}
               AND attended_record.school_year_id = $1::uuid
               AND LOWER(TRIM(attended_record.student_id)) = LOWER(TRIM($2))
               AND COALESCE(attended_record.event_id, attended_import.event_id) = roster.event_id
           )
           AND NOT EXISTS (
             SELECT 1 FROM manual_attendance_records attended_manual
             WHERE attended_manual.school_year_id = $1::uuid
               AND LOWER(TRIM(attended_manual.student_id)) = LOWER(TRIM($2))
               AND attended_manual.event_id = roster.event_id
               AND COALESCE(attended_manual.attendance_type, 'manual') <> 'zero_attendance'
               AND LOWER(TRIM(COALESCE(attended_manual.remarks, ''))) <> LOWER($5::text)
           )
         )
       )`,
    [schoolYearId, studentId, collegeKey, eventIds, ZERO_ATTENDANCE_REMARK],
  );

  return new Set(result.rows.map((row) => row.id));
}

type CurrentStudentDetails = {
  exists: boolean;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
};

async function getActiveSchoolYearId(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM school_years
      WHERE is_active = TRUE
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `,
  );
  return result.rows[0]?.id ?? null;
}

async function getCurrentStudentDetails(
  client: PoolClient,
  studentId: string,
): Promise<CurrentStudentDetails> {
  const result = await client.query<CurrentStudentDetails>(
    `
      WITH source_rows AS (
        SELECT
          1 AS priority,
          NULLIF(TRIM(name), '') AS name,
          NULLIF(TRIM(year_level), '') AS year_level,
          NULLIF(TRIM(college), '') AS college,
          NULLIF(TRIM(program), '') AS program,
          NULLIF(TRIM(institution), '') AS institution,
          updated_at
        FROM students
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))

        UNION ALL

        SELECT
          2,
          NULLIF(TRIM(name), ''),
          NULLIF(TRIM(year_level), ''),
          NULLIF(TRIM(college), ''),
          NULLIF(TRIM(program), ''),
          NULLIF(TRIM(institution), ''),
          updated_at
        FROM attendance_records
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
          AND deleted_at IS NULL

        UNION ALL

        SELECT
          3,
          NULLIF(TRIM(name), ''),
          NULLIF(TRIM(year_level), ''),
          NULLIF(TRIM(college), ''),
          NULLIF(TRIM(program), ''),
          NULLIF(TRIM(institution), ''),
          updated_at
        FROM manual_attendance_records
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))

        UNION ALL

        SELECT
          4,
          NULLIF(TRIM(name), ''),
          NULLIF(TRIM(year_level), ''),
          NULLIF(TRIM(college), ''),
          NULLIF(TRIM(program), ''),
          NULLIF(TRIM(institution), ''),
          updated_at
        FROM attendance_final_results
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))

        UNION ALL

        SELECT
          5,
          NULLIF(TRIM(name), ''),
          NULLIF(TRIM(year_level), ''),
          NULLIF(TRIM(college), ''),
          NULLIF(TRIM(program), ''),
          NULLIF(TRIM(institution), ''),
          updated_at
        FROM calculation_results
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))

        UNION ALL

        SELECT
          6,
          NULLIF(TRIM(name), ''),
          NULL::TEXT,
          NULL::TEXT,
          NULL::TEXT,
          NULL::TEXT,
          updated_at
        FROM fines
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      ), allowed_existence AS (
        SELECT EXISTS (
          SELECT 1 FROM students WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
          UNION ALL
          SELECT 1 FROM attendance_records
          WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1)) AND deleted_at IS NULL
          UNION ALL
          SELECT 1 FROM manual_attendance_records
          WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
          UNION ALL
          SELECT 1 FROM fines WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        ) AS exists
      )
      SELECT
        allowed_existence.exists,
        COALESCE((
          SELECT name FROM source_rows
          WHERE name IS NOT NULL
          ORDER BY priority, updated_at DESC
          LIMIT 1
        ), '') AS name,
        (SELECT year_level FROM source_rows WHERE year_level IS NOT NULL ORDER BY priority, updated_at DESC LIMIT 1) AS year_level,
        (SELECT college FROM source_rows WHERE college IS NOT NULL ORDER BY priority, updated_at DESC LIMIT 1) AS college,
        (SELECT program FROM source_rows WHERE program IS NOT NULL ORDER BY priority, updated_at DESC LIMIT 1) AS program,
        (SELECT institution FROM source_rows WHERE institution IS NOT NULL ORDER BY priority, updated_at DESC LIMIT 1) AS institution
      FROM allowed_existence
    `,
    [studentId],
  );

  return result.rows[0] ?? {
    exists: false,
    name: "",
    year_level: null,
    college: null,
    program: null,
    institution: null,
  };
}

async function getRequestViewById(
  requestId: string,
  client?: Pick<PoolClient, "query">,
) {
  const sql = `
      SELECT
        ar.*,
        ${REQUEST_INSTITUTION_SELECTION},
        sy.name AS school_year_name,
        sy.semester,
        reviewer.name AS reviewed_by_name,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', are.id,
              'request_id', are.request_id,
              'event_id', are.event_id,
              'event_name', are.event_name,
              'evidence_url', are.evidence_url,
              'created_at', are.created_at
            ) ORDER BY are.created_at, are.event_name
          ) FILTER (WHERE are.id IS NOT NULL),
          '[]'::JSON
        ) AS events
      FROM attendance_requests ar
      JOIN school_years sy ON sy.id = ar.school_year_id
      LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by
      LEFT JOIN attendance_request_events are ON are.request_id = ar.id
      WHERE ar.id = $1
      GROUP BY ar.id, sy.id, reviewer.id
      LIMIT 1
    `;
  const params = [requestId];
  const result = client
    ? await client.query<AttendanceRequestView>(sql, params)
    : await query<AttendanceRequestView>(sql, params);

  return result.rows[0] ?? null;
}

function cleanPublicField(value: unknown, max: number, label: string): string {
  if (value !== undefined && typeof value !== "string") throw createHttpError(`${label} is invalid.`);
  const text = String(value ?? "").replace(/<[^>]*>/g, "").trim();
  if (text.length > max) throw createHttpError(`${label} is too long.`);
  return text;
}

async function findCountedEventParticipationForStudent(
  client: PoolClient,
  studentId: string,
  schoolYearId: string,
): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM attendance_records ar
        LEFT JOIN attendance_imports ai
          ON ai.id = ar.import_id
         AND ai.deleted_at IS NULL
        WHERE ${getAttendanceRecordVisibilitySql("ar")}
          AND ar.school_year_id = $2::uuid
          AND LOWER(TRIM(ar.student_id)) = LOWER(TRIM($1))
          AND COALESCE(ar.event_id, ai.event_id) IS NOT NULL
          AND LOWER(TRIM(COALESCE(ar.remarks, ''))) <> LOWER($3::text)
          AND NOT EXISTS (
            SELECT 1
            FROM attendance_student_event_overrides correction
            WHERE correction.school_year_id = ar.school_year_id
              AND correction.student_key = LOWER(TRIM(ar.student_id))
              AND correction.event_id = COALESCE(ar.event_id, ai.event_id)
              AND correction.attended = FALSE
          )
        UNION ALL
        SELECT 1
        FROM manual_attendance_records mar
        WHERE mar.school_year_id = $2::uuid
          AND LOWER(TRIM(mar.student_id)) = LOWER(TRIM($1))
          AND mar.event_id IS NOT NULL
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
          AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER($3::text)
          AND NOT EXISTS (
            SELECT 1
            FROM attendance_student_event_overrides correction
            WHERE correction.school_year_id = mar.school_year_id
              AND correction.student_key = LOWER(TRIM(mar.student_id))
              AND correction.event_id = mar.event_id
              AND correction.attended = FALSE
          )
        UNION ALL
        SELECT 1
        FROM attendance_student_event_overrides correction
        WHERE correction.school_year_id = $2::uuid
          AND correction.student_key = LOWER(TRIM($1))
          AND correction.attended = TRUE
      ) AS exists
    `,
    [studentId, schoolYearId, ZERO_ATTENDANCE_REMARK],
  );
  return result.rows[0]?.exists ?? false;
}

export async function createAttendanceRequest(input: AttendanceRequestInput) {
  const requestType = normalizeRequestType(input.requestType);
  const inputSchoolYearId = cleanText(input.schoolYearId);
  const studentId = cleanText(input.studentId);

  if (inputSchoolYearId && !isUuid(inputSchoolYearId)) {
    throw createHttpError("School year / semester ID is invalid.");
  }
  if (!studentId || !/^[A-Za-z0-9-]{4,36}$/.test(studentId)) throw createHttpError("Invalid student information.");
  if (cleanText(input.honeypot)) throw createHttpError("Invalid submission.");
  const fillTime = Date.now() - Number(input.formStartedAt);
  if (!Number.isFinite(fillTime) || fillTime < 3000 || fillTime > 24 * 60 * 60 * 1000) {
    throw createHttpError("Please complete the form normally and try again.");
  }
  // Check the original types, length-limit every public field, and persist only
  // the sanitized values rather than merely validating a cleaned copy.
  input = {
    ...input,
    name: cleanPublicField(input.name, 160, "name"),
    yearLevel: cleanPublicField(input.yearLevel, 80, "yearLevel"),
    college: cleanPublicField(input.college, 160, "college"),
    program: cleanPublicField(input.program, 160, "program"),
    institution: cleanPublicField(input.institution, 160, "institution"),
    note: cleanPublicField(input.note, 1000, "note"),
  };

  return withTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext(LOWER(TRIM($1))))", [studentId]);
    const identity = await getCurrentStudentDetails(client, studentId);
    // Students without a saved attendance record may submit a request; officers verify it before approval.
    if (!identity.exists && requestType === "details_correction") {
      throw createHttpError("Student record was not found.", 404);
    }
    const schoolYearId = inputSchoolYearId || (await getActiveSchoolYearId(client));
    if (!schoolYearId) {
      throw createHttpError(
        "School year / semester is required. Activate a school year / semester first.",
      );
    }

    const schoolYearResult = await client.query<{ id: string }>(
      `SELECT id FROM school_years WHERE id = $1 LIMIT 1`,
      [schoolYearId],
    );
    if (!schoolYearResult.rows[0]) {
      throw createHttpError("School year / semester was not found.", 404);
    }

    if (requestType === "details_correction") {
      if (input.events !== undefined && input.events !== null) {
        throw createHttpError(
          "Details correction requests cannot include attendance events.",
        );
      }

      const current = await getCurrentStudentDetails(client, studentId);
      if (!current.exists || !current.name) {
        throw createHttpError(
          "Student ID was not found in student, attendance, manual attendance, or fine records.",
          404,
        );
      }

      // Names are no longer editable through details correction.
      const requestedName = current.name;
      const requestedYearLevel = cleanText(input.yearLevel) || current.year_level || "";
      const requestedCollege = cleanText(input.college) || current.college || "";
      const requestedProgram = cleanText(input.program) || current.program || "";

      const hasChanges =
        valuesDiffer(requestedYearLevel, current.year_level) ||
        valuesDiffer(requestedCollege, current.college) ||
        valuesDiffer(requestedProgram, current.program);
      if (!hasChanges) {
        throw createHttpError("No changes detected.");
      }

      const pendingResult = await client.query<{ id: string }>(
        `
          SELECT id
          FROM attendance_requests
          WHERE request_type = 'details_correction'
            AND status = 'pending'
            AND LOWER(TRIM(student_id)) = LOWER(TRIM($1))
          LIMIT 1
        `,
        [studentId],
      );
      if (pendingResult.rows[0]) {
        throw createHttpError(
          "A pending details correction request already exists for this Student ID.",
          409,
        );
      }

      const requestResult = await client.query<AttendanceRequestRecord>(
        `
          INSERT INTO attendance_requests (
            request_type,
            school_year_id,
            student_id,
            name,
            year_level,
            college,
            program,
            institution,
            current_name,
            current_year_level,
            current_college,
            current_program,
            request_note
          )
          VALUES (
            'details_correction',
            $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''),
            NULLIF($7, ''), $8, NULLIF($9, ''), NULLIF($10, ''),
            NULLIF($11, ''), NULLIF($12, '')
          )
          RETURNING *
        `,
        [
          schoolYearId,
          studentId,
          requestedName,
          requestedYearLevel,
          requestedCollege,
          requestedProgram,
          current.institution ?? "",
          current.name,
          current.year_level ?? "",
          current.college ?? "",
          current.program ?? "",
          cleanText(input.note),
        ],
      );

      return (await getRequestViewById(requestResult.rows[0].id, client))!;
    }

    if (requestType === "zero_attendance") {
      if (input.events != null || input.evidenceUrl != null) {
        throw createHttpError("A no-participation declaration cannot include event evidence.");
      }
      const name = cleanText(input.name) || identity.name;
      const yearLevel = cleanText(input.yearLevel) || identity.year_level || "";
      const college = cleanText(input.college) || identity.college || "";
      const program = cleanText(input.program) || identity.program || "";
      if (!name || !yearLevel || !college || !program) {
        throw createHttpError("Name, year level, college, and program are required.");
      }
      if (await findCountedEventParticipationForStudent(client, studentId, schoolYearId)) {
        throw createHttpError("An event attendance record already exists for this school year. Request an event review instead.", 409);
      }
      const pending = await client.query<{ id: string }>(`
        SELECT id FROM attendance_requests
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
          AND school_year_id = $2 AND status = 'pending'
          AND request_type IN ('zero_attendance', 'event_review') LIMIT 1
      `, [studentId, schoolYearId]);
      if (pending.rows.length) {
        throw createHttpError("A pending attendance request already exists for this Student ID and school year.", 409);
      }
      const created = await client.query<AttendanceRequestRecord>(`
        INSERT INTO attendance_requests (
          request_type, school_year_id, student_id, name, year_level,
          college, program, institution, request_note
        ) VALUES ('zero_attendance', $1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [
        schoolYearId, studentId, name, yearLevel, college, program,
        cleanText(input.institution) || identity.institution || DEFAULT_REQUEST_INSTITUTION,
        cleanText(input.note),
      ]);
      return (await getRequestViewById(created.rows[0].id, client))!;
    }

    let name = identity.name || cleanText(input.name);
    // A verified student can enter an event name without needing the private event roster.
    const submittedEvents = Array.isArray(input.events) ? await Promise.all(input.events.map(async (raw) => {
      const submitted = raw as AttendanceRequestEventInput;
      if (submitted?.eventId || !submitted?.eventName) return raw;
      const eventName = cleanPublicField(submitted.eventName, 160, "event name");
      const matched = await client.query<{id: string}>(`
        SELECT id FROM attendance_events
        WHERE school_year_id = $1 AND LOWER(TRIM(name)) = LOWER(TRIM($2))
        ORDER BY created_at DESC LIMIT 1
      `, [schoolYearId, eventName]);
      if (!matched.rows.length) throw createHttpError("Selected event was not found.", 404);
      return { eventId: matched.rows[0].id, evidenceUrl: submitted.evidenceUrl };
    })) : input.events;
    let events = normalizeRequestEvents(submittedEvents);
    if (!name) {
      const currentStudent = await getCurrentStudentDetails(client, studentId);
      name = currentStudent.name ?? "";
    }
    if (!name) {
      throw createHttpError(
        "Name is required. Submit a Request Details Correction first, then try the attendance review again.",
      );
    }

    const pendingZero = await client.query<{ id: string }>(`
      SELECT id FROM attendance_requests
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND school_year_id = $2 AND status = 'pending'
        AND request_type = 'zero_attendance' LIMIT 1
    `, [studentId, schoolYearId]);
    if (pendingZero.rows.length) {
      throw createHttpError("A no-participation request is already pending for this school year.", 409);
    }

    const duplicates = await client.query<{ id: string }>(`
      SELECT ar.id FROM attendance_requests ar
      JOIN attendance_request_events are ON are.request_id = ar.id
      WHERE ar.status = 'pending' AND ar.request_type = 'event_review'
        AND LOWER(TRIM(ar.student_id)) = LOWER(TRIM($1))
        AND ar.school_year_id = $2 AND are.event_id = ANY($3::uuid[])
      LIMIT 1
    `, [studentId, schoolYearId, events.map((event) => event.eventId)]);
    if (duplicates.rows.length) throw createHttpError("A pending request already exists for one or more selected events.", 409);

    let eventIds = events.map((event) => event.eventId);
    const eventResult = await client.query<{
      id: string;
      name: string;
      school_year_id: string | null;
    }>(
      `
        SELECT id, name, school_year_id
        FROM attendance_events
        WHERE id = ANY($1::uuid[])
        ORDER BY event_order, event_start_at, created_at
      `,
      [eventIds],
    );

    if (eventResult.rows.length !== eventIds.length) {
      throw createHttpError("One or more selected attendance events were not found.", 404);
    }

    const eventById = new Map(eventResult.rows.map((event) => [event.id, event]));
    for (const event of events) {
      const storedEvent = eventById.get(event.eventId);
      if (storedEvent?.school_year_id !== schoolYearId) {
        throw createHttpError(
          `The event “${storedEvent?.name ?? event.eventId}” does not belong to the selected school year / semester.`,
        );
      }
    }

    const requestCollege = identity.college || cleanText(input.college);
    const requestYearLevel = identity.year_level || cleanText(input.yearLevel);
    const requestCollegeKey = normalizeCollegeKey(requestCollege);
    const requestYearLevelKey = normalizeYearLevelKey(requestYearLevel);

    const exemptedEvents = await client.query<{ id: string }>(`
      SELECT e.id
      FROM attendance_events e
      WHERE e.id = ANY($1::uuid[])
        AND (
          NOT (${getEventCollegeExemptionFilterSql('e.id', '$2::text')})
          OR NOT (${getEventYearLevelExemptionFilterSql('e.id', '$3::text', '$2::text')})
        )
    `, [eventIds, requestCollegeKey, requestYearLevelKey]);
    const exemptedIds = new Set(exemptedEvents.rows.map((event) => event.id));
    events = events.filter((event) => !exemptedIds.has(event.eventId));
    eventIds = events.map((event) => event.eventId);
    if (!eventIds.length) {
      throw createHttpError(
        "All selected events are exempted for your college/year level, so no attendance request is needed.",
      );
    }

    if (!requestCollegeKey) {
      throw createHttpError(
        "Your college is missing. Submit a Request Details Correction first, then try the attendance review again.",
      );
    }

    const requestableIds = await getRequestableEventIds(
      client,
      schoolYearId,
      studentId,
      requestCollegeKey,
      eventIds,
    );
    events = events.filter((event) => requestableIds.has(event.eventId));
    eventIds = events.map((event) => event.eventId);
    if (!eventIds.length) {
      throw createHttpError(
        "None of the selected events are counted as missed for your college, so no attendance request is needed.",
      );
    }

    const duplicateResult = await client.query<{ event_id: string | null }>(
      `
        SELECT are.event_id
        FROM attendance_request_events are
        JOIN attendance_requests ar ON ar.id = are.request_id
        WHERE ar.status = 'pending'
          AND ar.school_year_id = $1
          AND LOWER(TRIM(ar.student_id)) = LOWER(TRIM($2))
          AND are.event_id = ANY($3::uuid[])
      `,
      [schoolYearId, studentId, eventIds],
    );
    if (duplicateResult.rows.length) {
      throw createHttpError(
        "A pending attendance request already exists for one or more selected events.",
        409,
      );
    }

    const requestResult = await client.query<AttendanceRequestRecord>(
      `
        INSERT INTO attendance_requests (
          request_type,
          school_year_id,
          student_id,
          name,
          year_level,
          college,
          program,
          institution,
          request_note
        )
        VALUES ('event_review', $1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''))
        RETURNING *
      `,
      [
        schoolYearId,
        studentId,
        name,
        requestYearLevel,
        requestCollege,
        cleanText(input.program) || identity.program || "",
        identity.institution || cleanText(input.institution) || DEFAULT_REQUEST_INSTITUTION,
        cleanText(input.note),
      ],
    );
    const request = requestResult.rows[0];

    for (const event of events) {
      const storedEvent = eventById.get(event.eventId)!;
      await client.query(
        `
          INSERT INTO attendance_request_events (
            request_id,
            event_id,
            event_name,
            evidence_url
          )
          VALUES ($1, $2, $3, $4)
        `,
        [request.id, storedEvent.id, storedEvent.name, event.evidenceUrl],
      );
    }

    return (await getRequestViewById(request.id, client))!;
  });
}

export async function listAttendanceRequests(
  options: AttendanceRequestListOptions = {},
) {
  const rawStatus = cleanText(options.status);
  const status = rawStatus ? normalizeRequestStatus(rawStatus) : null;
  const rawRequestType = cleanText(options.requestType);
  const requestType = rawRequestType
    ? normalizeRequestType(rawRequestType, false)
    : null;
  const schoolYearId = cleanOptionalText(options.schoolYearId);
  const studentId = cleanOptionalText(options.studentId);

  const result = await query<AttendanceRequestView>(
    `
      SELECT
        ar.*,
        ${REQUEST_INSTITUTION_SELECTION},
        sy.name AS school_year_name,
        sy.semester,
        reviewer.name AS reviewed_by_name,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', are.id,
              'request_id', are.request_id,
              'event_id', are.event_id,
              'event_name', are.event_name,
              'evidence_url', are.evidence_url,
              'created_at', are.created_at
            ) ORDER BY are.created_at, are.event_name
          ) FILTER (WHERE are.id IS NOT NULL),
          '[]'::JSON
        ) AS events
      FROM attendance_requests ar
      JOIN school_years sy ON sy.id = ar.school_year_id
      LEFT JOIN users reviewer ON reviewer.id = ar.reviewed_by
      LEFT JOIN attendance_request_events are ON are.request_id = ar.id
      WHERE ($1::TEXT IS NULL OR ar.status = $1)
        AND ($2::TEXT IS NULL OR ar.request_type = $2)
        AND ($3::UUID IS NULL OR ar.school_year_id = $3)
        AND ($4::TEXT IS NULL OR LOWER(TRIM(ar.student_id)) = LOWER(TRIM($4)))
      GROUP BY ar.id, sy.id, reviewer.id
      ORDER BY
        CASE ar.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        ar.created_at DESC
    `,
    [status, requestType, schoolYearId, studentId],
  );

  return result.rows;
}

async function addApprovedManualAttendance(
  client: PoolClient,
  request: AttendanceRequestRecord,
  events: AttendanceRequestEventWithSchoolYear[],
  reviewerId: string,
  onEventProgress?: (
    event: AttendanceRequestEventWithSchoolYear,
    index: number,
    total: number,
  ) => void,
) {
  const studentId = cleanText(request.student_id);
  const studentValues = [
    studentId,
    request.name,
    request.year_level ?? "",
    request.college ?? "",
    request.program ?? "",
    request.institution ?? "",
  ];
  const updatedStudent = await client.query(
    `
      UPDATE students
      SET name = $2,
          year_level = COALESCE(NULLIF($3, ''), year_level),
          college = COALESCE(NULLIF($4, ''), college),
          program = COALESCE(NULLIF($5, ''), program),
          institution = COALESCE(NULLIF($6, ''), institution),
          updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM students
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      )
    `,
    studentValues,
  );

  if (!updatedStudent.rowCount) {
    await client.query(
      `
        INSERT INTO students (
          student_id,
          name,
          year_level,
          college,
          program,
          institution
        )
        VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''))
        ON CONFLICT ((LOWER(TRIM(student_id))))
        DO UPDATE SET
          name = EXCLUDED.name,
          year_level = COALESCE(EXCLUDED.year_level, students.year_level),
          college = COALESCE(EXCLUDED.college, students.college),
          program = COALESCE(EXCLUDED.program, students.program),
          institution = COALESCE(EXCLUDED.institution, students.institution),
          updated_at = NOW()
      `,
      studentValues,
    );
  }

  let createdAttendanceCount = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    onEventProgress?.(event, eventIndex + 1, events.length);
    if (!event.event_id || event.school_year_id !== request.school_year_id) {
      throw createHttpError(
        `The requested event “${event.event_name}” is no longer available in this school year / semester. Reject the request or restore the event before approving it.`,
        409,
      );
    }

    const existingResult = await client.query<{ exists: boolean }>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM attendance_records ar
          WHERE ar.event_id = $1
            AND ar.deleted_at IS NULL
            AND LOWER(TRIM(ar.student_id)) = LOWER(TRIM($2))
          UNION ALL
          SELECT 1
          FROM manual_attendance_records mar
          WHERE mar.event_id = $1
            AND LOWER(TRIM(mar.student_id)) = LOWER(TRIM($2))
        ) AS exists
      `,
      [event.event_id, studentId],
    );

    // An explicit absent override takes precedence over source rows. An
    // approved review must reverse it, even when a source row already exists.
    await client.query(
      `UPDATE attendance_student_event_overrides
       SET attended = TRUE, updated_by = $4::uuid, updated_at = NOW()
       WHERE school_year_id = $1::uuid AND student_key = LOWER(TRIM($2::text))
         AND event_id = $3::uuid AND attended = FALSE`,
      [request.school_year_id, studentId, event.event_id, reviewerId],
    );
    if (existingResult.rows[0]?.exists) continue;

    await client.query(
      `
        INSERT INTO manual_attendance_records (
          school_year_id,
          event_id,
          attendance_type,
          student_id,
          name,
          year_level,
          college,
          program,
          institution,
          no_of_absences,
          remarks,
          scanned_at
        )
        VALUES ($1, $2, 'manual', $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), 0, $9, NULL)
      `,
      [
        request.school_year_id,
        event.event_id,
        studentId,
        request.name,
        request.year_level ?? "",
        request.college ?? "",
        request.program ?? "",
        request.institution ?? "",
        `Approved attendance request. Evidence: ${event.evidence_url}`,
      ],
    );
    createdAttendanceCount += 1;
  }

  const zeroManualResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM manual_attendance_records
      WHERE school_year_id = $1
        AND attendance_type = 'zero_attendance'
        AND LOWER(TRIM(student_id)) = LOWER(TRIM($2))
    `,
    [request.school_year_id, studentId],
  );
  const zeroManualIds = zeroManualResult.rows.map((row) => row.id);

  if (zeroManualIds.length) {
    await client.query(
      `
        DELETE FROM penalty_results
        WHERE source_table = 'manual_attendance_records'
          AND source_record_id = ANY($1::uuid[])
      `,
      [zeroManualIds],
    );
    await client.query(
      `DELETE FROM manual_attendance_records WHERE id = ANY($1::uuid[])`,
      [zeroManualIds],
    );
  }

  await client.query(
    `
      DELETE FROM attendance_records
      WHERE school_year_id = $1
        AND deleted_at IS NULL
        AND event_id IS NULL
        AND LOWER(TRIM(student_id)) = LOWER(TRIM($2))
        AND remarks = $3
    `,
    [request.school_year_id, studentId, ZERO_ATTENDANCE_REMARK],
  );

  return createdAttendanceCount;
}


/** Minimal public lookup: no names, evidence, request notes or reviewer details. */
export type PublicStudentLookup = {
  student_id: string;
  course: string | null;
  year_level: string | null;
  college: string | null;
  status: AttendanceRequestStatus | null;
};

export async function lookupPublicStudentById(studentId: string): Promise<PublicStudentLookup | null> {
  const id = studentId.trim();
  if (!/^[A-Za-z0-9-]{4,36}$/.test(id)) return null;

  // Select only the four approved profile fields. Prefer the maintained student
  // profile, but support older attendance records that predate student upserts.
  const profile = await query<{
    student_id: string;
    course: string | null;
    year_level: string | null;
    college: string | null;
  }>(`
    SELECT student_id, course, year_level, college
    FROM (
      SELECT student_id, NULLIF(TRIM(program), '') AS course,
        NULLIF(TRIM(year_level), '') AS year_level,
        NULLIF(TRIM(college), '') AS college, 0 AS priority, updated_at
      FROM students WHERE LOWER(TRIM(student_id)) = LOWER($1)
      UNION ALL
      SELECT student_id, NULLIF(TRIM(program), ''),
        NULLIF(TRIM(year_level), ''), NULLIF(TRIM(college), ''), 1, updated_at
      FROM attendance_records
      WHERE LOWER(TRIM(student_id)) = LOWER($1) AND deleted_at IS NULL
    ) profiles
    ORDER BY priority, updated_at DESC
    LIMIT 1
  `, [id]);
  const student = profile.rows[0];
  if (!student) return null;

  const latest = await query<{ status: AttendanceRequestStatus }>(`
    SELECT status FROM attendance_requests
    WHERE LOWER(TRIM(student_id)) = LOWER($1)
    ORDER BY created_at DESC, id DESC LIMIT 1
  `, [id]);
  return {
    student_id: student.student_id,
    course: student.course,
    year_level: student.year_level,
    college: student.college,
    status: latest.rows[0]?.status ?? null,
  };
}

export type PublicStudentAttendanceRequestStatus = {
  id: string;
  school_year_id: string;
  school_year_name: string;
  semester: SchoolSemester;
  request_type: AttendanceRequestType;
  status: AttendanceRequestStatus;
  review_note: string | null;
  review_note_access: boolean;
  reviewed_at: string | null;
  created_at: string;
};

export async function listPublicAttendanceRequestsForStudent(
  verifiedRequestIds: string[],
  studentId?: string,
): Promise<PublicStudentAttendanceRequestStatus[]> {
  const cleanStudentId = studentId?.trim() || null;
  if (cleanStudentId && !/^[A-Za-z0-9-]{4,36}$/.test(cleanStudentId)) {
    throw createHttpError("Enter a valid Student ID.", 400);
  }
  const receiptIds = verifiedRequestIds.length <= 20 &&
    verifiedRequestIds.every((id) => isUuid(id)) ? verifiedRequestIds : [];
  if (!cleanStudentId && !receiptIds.length) return [];

  // Student ID lookups expose request status and reviewer notes.
  // Evidence and other request details stay private.
  const result = await query<PublicStudentAttendanceRequestStatus>(`
    SELECT ar.id, ar.school_year_id, sy.name AS school_year_name,
      sy.semester, ar.request_type, ar.status,
      ar.review_note,
      TRUE AS review_note_access,
      ar.reviewed_at, ar.created_at
    FROM attendance_requests ar
    JOIN school_years sy ON sy.id = ar.school_year_id
    WHERE (
      $2::text IS NOT NULL AND LOWER(TRIM(ar.student_id)) = LOWER(TRIM($2::text))
    ) OR (
      $2::text IS NULL AND ar.id = ANY($1::uuid[])
    )
    ORDER BY ar.created_at DESC, ar.id DESC
  `, [receiptIds, cleanStudentId]);
  return result.rows;
}

async function resolveRequestEventsForApproval(
  client: PoolClient,
  request: AttendanceRequestRecord,
) {
  const eventResult = await client.query<AttendanceRequestEventWithSchoolYear>(
    `
      SELECT are.*, ae.school_year_id
      FROM attendance_request_events are
      LEFT JOIN attendance_events ae ON ae.id = are.event_id
      WHERE are.request_id = $1
      ORDER BY are.created_at, are.event_name
    `,
    [request.id],
  );

  if (!eventResult.rows.length) {
    throw createHttpError("This request does not contain any events.", 409);
  }

  const resolvedEvents: AttendanceRequestEventWithSchoolYear[] = [];

  for (const event of eventResult.rows) {
    if (event.event_id && event.school_year_id === request.school_year_id) {
      resolvedEvents.push(event);
      continue;
    }

    const matchingEvent = await client.query<{
      id: string;
      school_year_id: string | null;
    }>(
      `
        SELECT id, school_year_id
        FROM attendance_events
        WHERE school_year_id = $1
          AND LOWER(REGEXP_REPLACE(TRIM(name), '\\s+', ' ', 'g')) =
              LOWER(REGEXP_REPLACE(TRIM($2), '\\s+', ' ', 'g'))
        ORDER BY event_order ASC, created_at ASC, id ASC
        LIMIT 1
      `,
      [request.school_year_id, event.event_name],
    );

    let resolvedEvent = matchingEvent.rows[0];

    if (!resolvedEvent) {
      const restoredEvent = await client.query<{
        id: string;
        school_year_id: string | null;
      }>(
        `
          INSERT INTO attendance_events (
            school_year_id,
            name,
            description,
            event_order
          )
          SELECT
            $1,
            $2,
            $3,
            COALESCE(MAX(event_order), 0) + 1
          FROM attendance_events
          WHERE school_year_id = $1
          RETURNING id, school_year_id
        `,
        [
          request.school_year_id,
          event.event_name,
          "Restored automatically from a pending attendance review request.",
        ],
      );
      resolvedEvent = restoredEvent.rows[0];
    }

    if (!resolvedEvent) {
      throw createHttpError(
        `Unable to restore the requested event “${event.event_name}”.`,
        409,
      );
    }

    const relinked = await client.query(
      `
        UPDATE attendance_request_events target
        SET event_id = $2
        WHERE target.id = $1
          AND NOT EXISTS (
            SELECT 1 FROM attendance_request_events duplicate
            WHERE duplicate.request_id = target.request_id
              AND duplicate.event_id = $2 AND duplicate.id <> target.id
          )
      `,
      [event.id, resolvedEvent.id],
    );
    if (!relinked.rowCount) {
      throw createHttpError(
        `More than one request entry resolves to “${event.event_name}”. Remove the duplicate entry after checking its evidence, then approve again.`,
        409,
      );
    }

    resolvedEvents.push({
      ...event,
      event_id: resolvedEvent.id,
      school_year_id: resolvedEvent.school_year_id,
    });
  }

  const applied = await applyExemptionsToPendingAttendanceRequests(client, {
    schoolYearId: request.school_year_id,
    requestIds: [request.id],
  });
  const remaining = await client.query<AttendanceRequestEventWithSchoolYear>(`
    SELECT are.*, ae.school_year_id
    FROM attendance_request_events are
    LEFT JOIN attendance_events ae ON ae.id = are.event_id
    WHERE are.request_id = $1
    ORDER BY are.created_at, are.event_name
  `, [request.id]);

  const collegeKey = normalizeCollegeKey(request.college);
  if (collegeKey) {
    const ids = remaining.rows
      .map((event) => event.event_id)
      .filter((eventId): eventId is string => eventId !== null);
    const requestableIds = await getRequestableEventIds(
      client,
      request.school_year_id,
      request.student_id,
      collegeKey,
      ids,
    );
    const invalidEvents = remaining.rows.filter(
      (event) => !event.event_id || !requestableIds.has(event.event_id),
    );
    if (invalidEvents.length) {
      throw createHttpError(
        `These events are not counted as missed for this student's college and cannot be approved: ${invalidEvents.map((event) => event.event_name).join(", ")}. Remove them from the request, then approve again.`,
        409,
      );
    }
  }

  return {
    events: remaining.rows,
    removedEventNames: applied.removedByRequest.get(request.id) ?? [],
    autoClosed: applied.requestsClosed > 0,
  };
}

async function applyApprovedDetailsCorrection(
  client: PoolClient,
  request: AttendanceRequestRecord,
  onProgress?: AttendanceRequestReviewProgressCallback,
  deferredSchoolYearIds?: Set<string>,
) {
  const studentId = cleanText(request.student_id);
  const requestedName = cleanText(request.name);
  const requestedYearLevel = cleanText(request.year_level);
  const requestedCollege = cleanText(request.college);
  const requestedProgram = cleanText(request.program);

  const schoolYearResult = await client.query<{ school_year_id: string }>(
    `
      SELECT DISTINCT school_year_id
      FROM (
        SELECT school_year_id FROM attendance_records
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT school_year_id FROM manual_attendance_records
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT school_year_id FROM attendance_final_results
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT school_year_id FROM calculation_results
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT school_year_id FROM fines
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT school_year_id FROM penalty_results
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        UNION ALL
        SELECT $2::UUID AS school_year_id
      ) student_school_years
      WHERE school_year_id IS NOT NULL
    `,
    [studentId, request.school_year_id],
  );
  const schoolYearIds = schoolYearResult.rows.map((row) => row.school_year_id);

  onProgress?.({
    stage: "updating_records",
    percent: 14,
    message: "Updating student details across attendance records.",
  });

  let updatedRowCount = 0;

  const studentResult = await client.query(
    `
      INSERT INTO students (
        student_id, name, year_level, college, program, institution
      )
      VALUES (
        $1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, '')
      )
      ON CONFLICT ((LOWER(TRIM(student_id))))
      DO UPDATE SET
        name = COALESCE(NULLIF(TRIM(EXCLUDED.name), ''), students.name),
        year_level = COALESCE(EXCLUDED.year_level, students.year_level),
        college = COALESCE(EXCLUDED.college, students.college),
        program = COALESCE(EXCLUDED.program, students.program),
        updated_at = NOW()
    `,
    [
      studentId,
      requestedName || request.current_name || "Unknown Student",
      requestedYearLevel,
      requestedCollege,
      requestedProgram,
      request.institution ?? "",
    ],
  );
  updatedRowCount += studentResult.rowCount ?? 0;

  for (const table of [
    "attendance_records",
    "manual_attendance_records",
    "attendance_final_results",
    "calculation_results",
  ]) {
    const result = await client.query(
      `
        UPDATE ${table}
        SET
          name = COALESCE(NULLIF(TRIM($2), ''), name),
          year_level = COALESCE(NULLIF(TRIM($3), ''), year_level),
          college = COALESCE(NULLIF(TRIM($4), ''), college),
          program = COALESCE(NULLIF(TRIM($5), ''), program),
          updated_at = NOW()
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      `,
      [
        studentId,
        requestedName,
        requestedYearLevel,
        requestedCollege,
        requestedProgram,
      ],
    );
    updatedRowCount += result.rowCount ?? 0;
  }

  for (const table of ["fines", "penalty_results"]) {
    const result = await client.query(
      `
        UPDATE ${table}
        SET
          name = COALESCE(NULLIF(TRIM($2), ''), name),
          updated_at = NOW()
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      `,
      [studentId, requestedName],
    );
    updatedRowCount += result.rowCount ?? 0;
  }

  // Existing pending reviews must use the newly approved student scope.
  await client.query(`
    UPDATE attendance_requests
    SET college = COALESCE(NULLIF($2::text, ''), college),
        year_level = COALESCE(NULLIF($3::text, ''), year_level),
        updated_at = NOW()
    WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      AND status = 'pending' AND request_type = 'event_review'
  `, [studentId, requestedCollege, requestedYearLevel]);

  if (deferredSchoolYearIds) {
    for (const schoolYearId of schoolYearIds) deferredSchoolYearIds.add(schoolYearId);
    return updatedRowCount;
  }

  const scopeTotal = schoolYearIds.length;
  const scopeSpan = scopeTotal ? 72 / scopeTotal : 0;

  for (let index = 0; index < schoolYearIds.length; index += 1) {
    const schoolYearId = schoolYearIds[index];
    const completed = index + 1;
    const basePercent = 20 + index * scopeSpan;
    const scopeLabel = `(${completed} of ${scopeTotal})`;

    onProgress?.({
      stage: "syncing_absences",
      percent: Math.round(basePercent),
      message: `Syncing absences ${scopeLabel}.`,
      completed,
      total: scopeTotal,
    });
    await syncAbsencesForStudents(client, [studentId], schoolYearId, true);

    await refreshDerivedAttendanceResultsForSchoolYearsWithClient(
      client,
      [schoolYearId],
      (progress) => {
        const offsets = {
          refreshing_final_results: 0.28,
          refreshing_calculations: 0.56,
          refreshing_penalties: 0.8,
        } as const;
        const labels = {
          refreshing_final_results: "Refreshing final attendance results",
          refreshing_calculations: "Refreshing attendance calculations",
          refreshing_penalties: "Refreshing fines and penalties",
        } as const;

        onProgress?.({
          stage: progress.stage,
          percent: Math.round(basePercent + scopeSpan * offsets[progress.stage]),
          message: `${labels[progress.stage]} ${scopeLabel}.`,
          completed,
          total: scopeTotal,
        });
      },
    );
  }

  return updatedRowCount;
}

async function applyApprovedZeroAttendance(
  client: PoolClient,
  request: AttendanceRequestRecord,
) {
  const studentId = cleanText(request.student_id);
  if (await findCountedEventParticipationForStudent(client, studentId, request.school_year_id)) {
    throw createHttpError("This student already has recorded event attendance for this school year / semester, so the no-participation declaration cannot be approved. Reject it and ask the student to submit an event review instead.", 409);
  }

  const studentValues = [
    studentId,
    request.name,
    request.year_level ?? "",
    request.college ?? "",
    request.program ?? "",
    request.institution || DEFAULT_REQUEST_INSTITUTION,
  ];
  const updatedStudent = await client.query(
    `
      UPDATE students
      SET name = $2,
          year_level = COALESCE(NULLIF($3, ''), year_level),
          college = COALESCE(NULLIF($4, ''), college),
          program = COALESCE(NULLIF($5, ''), program),
          institution = COALESCE(NULLIF($6, ''), institution),
          updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM students
        WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      )
    `,
    studentValues,
  );

  if (!updatedStudent.rowCount) {
    await client.query(
      `
        INSERT INTO students (
          student_id,
          name,
          year_level,
          college,
          program,
          institution
        )
        VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''))
        ON CONFLICT ((LOWER(TRIM(student_id))))
        DO UPDATE SET
          name = EXCLUDED.name,
          year_level = COALESCE(EXCLUDED.year_level, students.year_level),
          college = COALESCE(EXCLUDED.college, students.college),
          program = COALESCE(EXCLUDED.program, students.program),
          institution = COALESCE(EXCLUDED.institution, students.institution),
          updated_at = NOW()
      `,
      studentValues,
    );
  }

  const saved = await client.query<{ id: string }>(`
    SELECT id FROM attendance_records
    WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1)) AND school_year_id = $2
      AND event_id IS NULL AND deleted_at IS NULL AND remarks = $3
    ORDER BY created_at DESC LIMIT 1
    FOR UPDATE
  `, [studentId, request.school_year_id, ZERO_ATTENDANCE_REMARK]);

  if (saved.rows[0]) {
    await client.query(`
      UPDATE attendance_records SET name = $2, year_level = NULLIF($3, ''), college = NULLIF($4, ''),
        program = NULLIF($5, ''), institution = $6, updated_at = NOW()
      WHERE id = $1
    `, [saved.rows[0].id, request.name, request.year_level, request.college,
      request.program, request.institution || DEFAULT_REQUEST_INSTITUTION]);
    return 0;
  }
  await client.query(`
    INSERT INTO attendance_records (
      school_year_id, import_id, event_id, student_id, name, year_level,
      college, program, institution, no_of_absences, remarks, scanned_at
    ) VALUES ($1, NULL, NULL, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7, 0, $8, NULL)
  `, [
    request.school_year_id, studentId, request.name, request.year_level,
    request.college, request.program,
    request.institution || DEFAULT_REQUEST_INSTITUTION,
    ZERO_ATTENDANCE_REMARK,
  ]);
  return 1;
}

export async function preflightAttendanceRequestReview(
  requestIdValue: unknown,
  reviewerIdValue: unknown,
  input: AttendanceRequestReviewInput,
) {
  const requestId = cleanText(requestIdValue);
  const reviewerId = cleanText(reviewerIdValue);
  normalizeRequestStatus(input.status, false);

  if (!requestId) throw createHttpError("Attendance request ID is required.");
  if (!isUuid(requestId)) throw createHttpError("Attendance request ID is invalid.");
  if (!reviewerId) throw createHttpError("Authenticated reviewer is required.", 401);

  const [reviewerResult, requestResult] = await Promise.all([
    query<{ id: string }>(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [reviewerId]),
    query<Pick<AttendanceRequestRecord, "id" | "status" | "request_type">>(
      `SELECT id, status, request_type FROM attendance_requests WHERE id = $1 LIMIT 1`,
      [requestId],
    ),
  ]);

  if (!reviewerResult.rows[0]) {
    throw createHttpError("Authenticated reviewer account was not found.", 401);
  }

  const request = requestResult.rows[0];
  if (!request) throw createHttpError("Attendance request not found.", 404);
  if (request.status !== "pending") {
    throw createHttpError("This attendance request has already been reviewed.", 409);
  }

  return request;
}

export async function reviewAttendanceRequest(
  requestIdValue: unknown,
  reviewerIdValue: unknown,
  input: AttendanceRequestReviewInput,
  onProgress?: AttendanceRequestReviewProgressCallback,
  isDisconnected?: () => boolean,
) {
  const requestId = cleanText(requestIdValue);
  const reviewerId = cleanText(reviewerIdValue);
  const status = normalizeRequestStatus(input.status, false);
  const reviewNote = cleanOptionalText(input.reviewNote);

  if (!requestId) throw createHttpError("Attendance request ID is required.");
  if (!isUuid(requestId)) throw createHttpError("Attendance request ID is invalid.");
  if (!reviewerId) throw createHttpError("Authenticated reviewer is required.", 401);

  let lastProgressPercent = 0;
  const emit = (
    progress: Omit<AttendanceRequestReviewProgress, "percent"> & { percent: number },
  ) => {
    if (!onProgress) return;
    const percent = Math.max(
      lastProgressPercent,
      Math.min(100, Math.round(progress.percent)),
    );
    lastProgressPercent = percent;
    onProgress({ ...progress, percent });
  };

  emit({
    stage: "validating",
    percent: 4,
    message: "Validating the attendance request and reviewer.",
  });

  const result = await withTransaction(async (client) => {
    const reviewerResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [reviewerId],
    );
    if (!reviewerResult.rows[0]) {
      throw createHttpError("Authenticated reviewer account was not found.", 401);
    }

    await prepareAttendanceReviewTransaction(client, status, emit, isDisconnected);
    const requestResult = await client.query<AttendanceRequestRecord>(
      `SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const request = requestResult.rows[0];
    if (!request) throw createHttpError("Attendance request not found.", 404);
    if (request.status !== "pending") {
      throw createHttpError("This attendance request has already been reviewed.", 409);
    }

    let createdAttendanceCount = 0;
    let updatedRowCount = 0;
    let removedExemptedEventCount = 0;
    if (status === "approved") {
      if (request.request_type === "details_correction") {
        updatedRowCount = await applyApprovedDetailsCorrection(
          client,
          request,
          emit,
        );
        await applyExemptionsToPendingAttendanceRequests(client, {
          schoolYearId: request.school_year_id,
          studentId: request.student_id,
        });
      } else if (request.request_type === "zero_attendance") {
        emit({
          stage: "adding_attendance", percent: 24,
          message: "Recording the verified no-participation declaration.",
        });
        createdAttendanceCount = await applyApprovedZeroAttendance(client, request);
        emit({
          stage: "syncing_absences", percent: 45,
          message: "Calculating the student's missed events and fines.",
        });
        await syncAbsencesForStudents(client, [request.student_id], request.school_year_id, true);
        await refreshDerivedAttendanceResultsForSchoolYearsWithClient(
          client, [request.school_year_id], (progress) => {
            const stages = {
              refreshing_final_results: 60,
              refreshing_calculations: 75,
              refreshing_penalties: 90,
            } as const;
            const labels = {
              refreshing_final_results: "Refreshing final attendance results.",
              refreshing_calculations: "Refreshing attendance calculations.",
              refreshing_penalties: "Refreshing fines and penalties.",
            } as const;
            emit({ stage: progress.stage, percent: stages[progress.stage], message: labels[progress.stage] });
          },
        );
      } else {
        emit({
          stage: "resolving_events",
          percent: 12,
          message: "Resolving requested events and checking exemptions.",
        });
        const resolved = await resolveRequestEventsForApproval(client, request);
        removedExemptedEventCount = resolved.removedEventNames.length;
        if (resolved.autoClosed) {
          return {
            createdAttendanceCount: 0,
            updatedRowCount: 0,
            requestType: request.request_type,
            removedExemptedEventCount,
            autoClosedByExemption: true,
            request: await getRequestViewById(requestId, client),
          };
        }

        createdAttendanceCount = await addApprovedManualAttendance(
          client,
          request,
          resolved.events,
          reviewerId,
          (event, index, total) => {
            const eventPercent = total
              ? 17 + (index / total) * 17
              : 34;
            emit({
              stage: "adding_attendance",
              percent: eventPercent,
              message: `Adding event ${index} of ${total}: ${event.event_name}`,
              completed: index,
              total,
            });
          },
        );

        emit({
          stage: "syncing_absences",
          percent: 42,
          message: "Recalculating the student's absences.",
        });
        await syncAbsencesForStudents(
          client,
          [request.student_id],
          request.school_year_id,
          true,
        );

        await refreshDerivedAttendanceResultsForSchoolYearsWithClient(
          client,
          [request.school_year_id],
          (progress) => {
            const progressMap = {
              refreshing_final_results: {
                percent: 54,
                message: "Refreshing final attendance results.",
              },
              refreshing_calculations: {
                percent: 72,
                message: "Refreshing attendance calculations.",
              },
              refreshing_penalties: {
                percent: 89,
                message: "Refreshing fines and penalties.",
              },
            } as const;
            const mapped = progressMap[progress.stage];
            emit({
              stage: progress.stage,
              percent: mapped.percent,
              message: mapped.message,
              completed: progress.scopeIndex,
              total: progress.scopeTotal,
            });
          },
        );
      }
    }

    emit({
      stage: "finalizing",
      percent: status === "approved" ? 96 : 90,
      message:
        status === "approved"
          ? "Finalizing the approved request."
          : "Finalizing the rejected request.",
    });

    await client.query(
      `
        UPDATE attendance_requests
        SET
          status = $2,
          reviewed_by = $3,
          review_note = CONCAT_WS(E'\n', NULLIF(review_note, ''), NULLIF($4::text, '')),
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [request.id, status, reviewerId, reviewNote],
    );

    return {
      createdAttendanceCount,
      updatedRowCount,
      requestType: request.request_type,
      removedExemptedEventCount,
      autoClosedByExemption: false,
      request: await getRequestViewById(requestId, client),
    };
  });

  emit({
    stage: "finalizing",
    percent: 98,
    message: "Request review saved.",
  });

  const request = result.request;

  emit({
    stage: "finalizing",
    percent: 100,
    message: "Attendance request review completed.",
  });

  return result.requestType === "details_correction"
    ? { request, updatedRowCount: result.updatedRowCount }
    : {
        request,
        createdAttendanceCount: result.createdAttendanceCount,
        removedExemptedEventCount: result.removedExemptedEventCount,
        autoClosedByExemption: result.autoClosedByExemption,
      };
}

function normalizeGroupReviewInput(
  reviewerIdValue: unknown,
  input: AttendanceRequestGroupReviewInput,
) {
  const reviewerId = cleanText(reviewerIdValue);
  const studentId = cleanText(input.studentId).toLowerCase();
  const status = normalizeRequestStatus(input.status, false);
  const reviewNote = cleanOptionalText(input.reviewNote);

  if (!reviewerId) throw createHttpError("Authenticated reviewer is required.", 401);
  if (!studentId) throw createHttpError("Student ID is required.");
  if (!Array.isArray(input.requestIds) || !input.requestIds.length) {
    throw createHttpError("Select at least one attendance request.");
  }
  const requestIds = Array.from(
    new Set(input.requestIds.map((id: unknown) => cleanText(id).toLowerCase())),
  );
  if (requestIds.some((id) => !isUuid(id))) {
    throw createHttpError("One or more attendance request IDs are invalid.");
  }
  return { reviewerId, studentId, requestIds, status, reviewNote };
}

function validateGroupReviewRequests(
  requests: AttendanceRequestRecord[],
  requestIds: string[],
  studentId: string,
) {
  if (requests.length !== requestIds.length) {
    throw createHttpError("One or more attendance requests were not found.", 404);
  }
  if (requests.some((request) => cleanText(request.student_id).toLowerCase() !== studentId)) {
    throw createHttpError("All attendance requests must belong to the specified student.");
  }
  if (requests.some((request) => request.status !== "pending")) {
    throw createHttpError("One or more attendance requests have already been reviewed.", 409);
  }
}

export async function preflightAttendanceRequestGroupReview(
  reviewerIdValue: unknown,
  input: AttendanceRequestGroupReviewInput,
) {
  const { reviewerId, studentId, requestIds } = normalizeGroupReviewInput(
    reviewerIdValue,
    input,
  );
  const [reviewerResult, requestResult] = await Promise.all([
    query<{ id: string }>(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [reviewerId]),
    query<AttendanceRequestRecord>(
      `SELECT * FROM attendance_requests WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [requestIds],
    ),
  ]);
  if (!reviewerResult.rows[0]) {
    throw createHttpError("Authenticated reviewer account was not found.", 401);
  }
  validateGroupReviewRequests(requestResult.rows, requestIds, studentId);
  return requestResult.rows;
}

export async function reviewAttendanceRequestGroup(
  reviewerIdValue: unknown,
  input: AttendanceRequestGroupReviewInput,
  onProgress?: AttendanceRequestReviewProgressCallback,
  isDisconnected?: () => boolean,
): Promise<AttendanceRequestGroupReviewResult> {
  const { reviewerId, studentId, requestIds, status, reviewNote } =
    normalizeGroupReviewInput(reviewerIdValue, input);
  let lastProgressPercent = 0;
  const emit = (
    progress: Omit<AttendanceRequestReviewProgress, "percent"> & { percent: number },
  ) => {
    if (!onProgress) return;
    const percent = Math.max(
      lastProgressPercent,
      Math.min(100, Math.round(progress.percent)),
    );
    lastProgressPercent = percent;
    onProgress({ ...progress, percent });
  };

  emit({ stage: "validating", percent: 4, message: "Validating requests and reviewer." });
  const result = await withTransaction(async (client) => {
    const reviewerResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [reviewerId],
    );
    if (!reviewerResult.rows[0]) {
      throw createHttpError("Authenticated reviewer account was not found.", 401);
    }
    await prepareAttendanceReviewTransaction(client, status, emit, isDisconnected);
    const requestResult = await client.query<AttendanceRequestRecord>(
      `SELECT * FROM attendance_requests WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [requestIds],
    );
    validateGroupReviewRequests(requestResult.rows, requestIds, studentId);
    const selected = requestResult.rows;
    const details = selected.filter((request) => request.request_type === "details_correction");
    const zeroRequests = selected.filter((request) => request.request_type === "zero_attendance");
    const events = selected.filter((request) => request.request_type === "event_review");
    const total = selected.length;
    let approvedCount = 0;
    let rejectedCount = 0;
    let autoClosedCount = 0;
    let createdAttendanceCount = 0;
    let updatedRowCount = 0;
    let removedExemptedEventCount = 0;
    const approvedIds: string[] = [];
    const approvedEventSchoolYearIds = new Set<string>();

    if (status === "rejected") {
      emit({
        stage: "finalizing",
        percent: 90,
        message: `Rejecting ${total} selected request(s).`,
        completed: total,
        total,
      });
      await client.query(
        `UPDATE attendance_requests
         SET status = $2, reviewed_by = $3,
             review_note = CONCAT_WS(E'\n', NULLIF(review_note, ''), NULLIF($4::text, '')),
             reviewed_at = NOW(), updated_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [requestIds, status, reviewerId, reviewNote],
      );
      rejectedCount = total;
    } else {
      const deferredDetailYears = events.length === 0 && zeroRequests.length === 0
        ? approvedEventSchoolYearIds : undefined;
      for (let index = 0; index < details.length; index += 1) {
        const request = details[index];
        const completed = index + 1;
        emit({
          stage: "updating_records",
          percent: 10,
          message: `Request ${completed} of ${total}: updating student details.`,
          completed,
          total,
        });
        updatedRowCount += await applyApprovedDetailsCorrection(
          client,
          request,
          (progress) => emit({
            ...progress,
            percent: 10 + (progress.percent / 100) * 24,
            message: `Request ${completed} of ${total}: ${progress.message}`,
            completed,
            total,
          }),
          deferredDetailYears,
        );
        const exemptions = await applyExemptionsToPendingAttendanceRequests(client, {
          schoolYearId: request.school_year_id,
          studentId: request.student_id,
        });
        removedExemptedEventCount += exemptions.eventsRemoved;
        approvedIds.push(request.id);
      }

      for (const request of zeroRequests) {
        emit({
          stage: "adding_attendance", percent: 35,
          message: "Registering verified no-participation declarations.",
        });
        createdAttendanceCount += await applyApprovedZeroAttendance(client, request);
        approvedIds.push(request.id);
        approvedEventSchoolYearIds.add(request.school_year_id);
      }

      // A correction can automatically close pending event reviews in the same group.
      const remainingEventRows = events.length
        ? await client.query<AttendanceRequestRecord>(
            `SELECT * FROM attendance_requests WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
            [events.map((request) => request.id)],
          )
        : { rows: [] as AttendanceRequestRecord[] };
      for (let index = 0; index < remainingEventRows.rows.length; index += 1) {
        const request = remainingEventRows.rows[index];
        const completed = details.length + index + 1;
        if (request.status !== "pending") {
          autoClosedCount += 1;
          emit({
            stage: "resolving_events",
            percent: 36 + (index / Math.max(events.length, 1)) * 16,
            message: `Request ${completed} of ${total}: closed automatically by exemptions.`,
            completed,
            total,
          });
          continue;
        }
        emit({
          stage: "resolving_events",
          percent: 36 + (index / Math.max(events.length, 1)) * 16,
          message: `Request ${completed} of ${total}: resolving events and exemptions.`,
          completed,
          total,
        });
        const resolved = await resolveRequestEventsForApproval(client, request);
        removedExemptedEventCount += resolved.removedEventNames.length;
        if (resolved.autoClosed) {
          autoClosedCount += 1;
          continue;
        }
        createdAttendanceCount += await addApprovedManualAttendance(
          client,
          request,
          resolved.events,
          reviewerId,
          (event, eventIndex, eventTotal) => emit({
            stage: "adding_attendance",
            percent: 37 + ((index + eventIndex / Math.max(eventTotal, 1)) / Math.max(events.length, 1)) * 16,
            message: `Request ${completed} of ${total}: adding event ${eventIndex} of ${eventTotal}: ${event.event_name}`,
            completed,
            total,
          }),
        );
        approvedIds.push(request.id);
        approvedEventSchoolYearIds.add(request.school_year_id);
      }

      if (approvedEventSchoolYearIds.size) {
        const schoolYearIds = [...approvedEventSchoolYearIds];
        for (let index = 0; index < schoolYearIds.length; index += 1) {
          emit({
            stage: "syncing_absences",
            percent: 56 + ((index + 1) / schoolYearIds.length) * 10,
            message: `Syncing absences for school year ${index + 1} of ${schoolYearIds.length}.`,
            completed: approvedIds.length,
            total,
          });
          await syncAbsencesForStudents(client, [studentId], schoolYearIds[index], true);
        }
        await refreshDerivedAttendanceResultsForSchoolYearsWithClient(
          client,
          schoolYearIds,
          (progress) => {
            const mapped = {
              refreshing_final_results: { percent: 72, message: "Refreshing final attendance results." },
              refreshing_calculations: { percent: 83, message: "Refreshing attendance calculations." },
              refreshing_penalties: { percent: 92, message: "Refreshing fines and penalties." },
            } as const;
            emit({
              stage: progress.stage,
              ...mapped[progress.stage],
              completed: progress.scopeIndex,
              total: progress.scopeTotal,
            });
          },
        );
      }

      emit({
        stage: "finalizing",
        percent: 96,
        message: `Finalizing ${approvedIds.length} approved request(s).`,
        completed: approvedIds.length,
        total,
      });
      if (approvedIds.length) {
        await client.query(
          `UPDATE attendance_requests
           SET status = $2, reviewed_by = $3,
               review_note = CONCAT_WS(E'\n', NULLIF(review_note, ''), NULLIF($4::text, '')),
               reviewed_at = NOW(), updated_at = NOW()
           WHERE id = ANY($1::uuid[])`,
          [approvedIds, status, reviewerId, reviewNote],
        );
      }
      approvedCount = approvedIds.length;
    }
    const requests: AttendanceRequestView[] = [];
    for (const id of requestIds) {
      const view = await getRequestViewById(id, client);
      if (!view) throw createHttpError("An attendance request is no longer available.", 409);
      requests.push(view);
    }
    return {
      requests,
      approvedCount,
      rejectedCount,
      autoClosedCount,
      createdAttendanceCount,
      updatedRowCount,
      removedExemptedEventCount,
    };
  });

  emit({
    stage: "finalizing",
    percent: 98,
    message: "Group review saved.",
    completed: requestIds.length,
    total: requestIds.length,
  });
  emit({
    stage: "finalizing",
    percent: 100,
    message: "Attendance request group review completed.",
    completed: requestIds.length,
    total: requestIds.length,
  });
  return result;
}

export async function removeAttendanceRequestEvent(
  requestIdValue: unknown,
  requestEventIdValue: unknown,
  reviewerIdValue: unknown,
) {
  const requestId = cleanText(requestIdValue);
  const requestEventId = cleanText(requestEventIdValue);
  const reviewerId = cleanText(reviewerIdValue);

  if (!requestId) throw createHttpError("Attendance request ID is required.");
  if (!isUuid(requestId)) throw createHttpError("Attendance request ID is invalid.");
  if (!requestEventId) throw createHttpError("Attendance request event ID is required.");
  if (!isUuid(requestEventId)) {
    throw createHttpError("Attendance request event ID is invalid.");
  }
  if (!reviewerId) throw createHttpError("Authenticated reviewer is required.", 401);

  await withTransaction(async (client) => {
    const reviewerResult = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 LIMIT 1`,
      [reviewerId],
    );
    if (!reviewerResult.rows[0]) {
      throw createHttpError("Authenticated reviewer account was not found.", 401);
    }

    const requestResult = await client.query<AttendanceRequestRecord>(
      `SELECT * FROM attendance_requests WHERE id = $1 FOR UPDATE`,
      [requestId],
    );
    const request = requestResult.rows[0];
    if (!request) throw createHttpError("Attendance request not found.", 404);
    if (request.status !== "pending") {
      throw createHttpError("Only pending requests can be edited.", 409);
    }
    if (request.request_type === "details_correction") {
      throw createHttpError(
        "Details correction requests do not contain removable events.",
        409,
      );
    }

    const eventResult = await client.query<AttendanceRequestEventRecord>(
      `
        SELECT *
        FROM attendance_request_events
        WHERE id = $1 AND request_id = $2
        LIMIT 1
      `,
      [requestEventId, requestId],
    );
    if (!eventResult.rows[0]) {
      throw createHttpError("Requested event not found on this request.", 404);
    }

    const countResult = await client.query<{ count: number }>(
      `
        SELECT COUNT(*)::INT AS count
        FROM attendance_request_events
        WHERE request_id = $1
      `,
      [requestId],
    );
    if ((countResult.rows[0]?.count ?? 0) <= 1) {
      throw createHttpError(
        "A request must keep at least one event. Reject the request instead.",
        409,
      );
    }

    await client.query(
      `DELETE FROM attendance_request_events WHERE id = $1 AND request_id = $2`,
      [requestEventId, requestId],
    );
    await client.query(
      `UPDATE attendance_requests SET updated_at = NOW() WHERE id = $1`,
      [requestId],
    );
  });

  return getRequestViewById(requestId);
}

