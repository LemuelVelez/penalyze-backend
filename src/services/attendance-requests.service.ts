import type { PoolClient } from "pg";

import type {
  AttendanceRequestEventRecord,
  AttendanceRequestRecord,
  AttendanceRequestStatus,
  SchoolSemester,
} from "../database/model/schema.model";
import { query, withTransaction } from "../lib/db";
import {
  refreshDerivedAttendanceResultsForSchoolYearsWithClient,
} from "./attendance.service";

type AttendanceRequestEventInput = {
  eventId?: unknown;
  evidenceUrl?: unknown;
};

export type AttendanceRequestInput = {
  schoolYearId?: unknown;
  studentId?: unknown;
  name?: unknown;
  yearLevel?: unknown;
  college?: unknown;
  program?: unknown;
  institution?: unknown;
  note?: unknown;
  events?: unknown;
};

export type AttendanceRequestListOptions = {
  status?: unknown;
  schoolYearId?: unknown;
  studentId?: unknown;
};

export type AttendanceRequestReviewInput = {
  status?: unknown;
  reviewNote?: unknown;
};

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

const ZERO_ATTENDANCE_REMARK = "Zero attendance registration from landing page.";

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
  return Object.assign(new Error(message), { statusCode });
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

function normalizeEvidenceUrl(value: unknown) {
  const text = cleanText(value);
  if (!text) throw createHttpError("An evidence link is required for every selected event.");
  if (text.length > 2048) throw createHttpError("Evidence links must be 2048 characters or fewer.");

  try {
    const parsed = new URL(text);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported protocol");
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

async function getRequestViewById(
  requestId: string,
  client?: Pick<PoolClient, "query">,
) {
  const sql = `
      SELECT
        ar.*,
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

export async function createAttendanceRequest(input: AttendanceRequestInput) {
  const schoolYearId = cleanText(input.schoolYearId);
  const studentId = cleanText(input.studentId);
  const name = cleanText(input.name);
  const events = normalizeRequestEvents(input.events);

  if (!schoolYearId) throw createHttpError("School year / semester is required.");
  if (!isUuid(schoolYearId)) throw createHttpError("School year / semester ID is invalid.");
  if (!studentId) throw createHttpError("Student ID is required.");
  if (!name) throw createHttpError("Name is required.");

  return withTransaction(async (client) => {
    const schoolYearResult = await client.query<{ id: string }>(
      `SELECT id FROM school_years WHERE id = $1 LIMIT 1`,
      [schoolYearId],
    );
    if (!schoolYearResult.rows[0]) {
      throw createHttpError("School year / semester was not found.", 404);
    }

    const eventIds = events.map((event) => event.eventId);
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
          school_year_id,
          student_id,
          name,
          year_level,
          college,
          program,
          institution,
          request_note
        )
        VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''))
        RETURNING *
      `,
      [
        schoolYearId,
        studentId,
        name,
        cleanText(input.yearLevel),
        cleanText(input.college),
        cleanText(input.program),
        cleanText(input.institution),
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
  const schoolYearId = cleanOptionalText(options.schoolYearId);
  const studentId = cleanOptionalText(options.studentId);

  const result = await query<AttendanceRequestView>(
    `
      SELECT
        ar.*,
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
        AND ($2::UUID IS NULL OR ar.school_year_id = $2)
        AND ($3::TEXT IS NULL OR LOWER(TRIM(ar.student_id)) = LOWER(TRIM($3)))
      GROUP BY ar.id, sy.id, reviewer.id
      ORDER BY
        CASE ar.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
        ar.created_at DESC
    `,
    [status, schoolYearId, studentId],
  );

  return result.rows;
}

async function addApprovedManualAttendance(
  client: PoolClient,
  request: AttendanceRequestRecord,
  events: AttendanceRequestEventWithSchoolYear[],
) {
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
      ON CONFLICT (student_id)
      DO UPDATE SET
        name = EXCLUDED.name,
        year_level = COALESCE(EXCLUDED.year_level, students.year_level),
        college = COALESCE(EXCLUDED.college, students.college),
        program = COALESCE(EXCLUDED.program, students.program),
        institution = COALESCE(EXCLUDED.institution, students.institution),
        updated_at = NOW()
    `,
    [
      request.student_id,
      request.name,
      request.year_level ?? "",
      request.college ?? "",
      request.program ?? "",
      request.institution ?? "",
    ],
  );

  let createdAttendanceCount = 0;

  for (const event of events) {
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
      [event.event_id, request.student_id],
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
        request.student_id,
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
    [request.school_year_id, request.student_id],
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
    [request.school_year_id, request.student_id, ZERO_ATTENDANCE_REMARK],
  );

  return createdAttendanceCount;
}

export async function reviewAttendanceRequest(
  requestIdValue: unknown,
  reviewerIdValue: unknown,
  input: AttendanceRequestReviewInput,
) {
  const requestId = cleanText(requestIdValue);
  const reviewerId = cleanText(reviewerIdValue);
  const status = normalizeRequestStatus(input.status, false);
  const reviewNote = cleanOptionalText(input.reviewNote);

  if (!requestId) throw createHttpError("Attendance request ID is required.");
  if (!isUuid(requestId)) throw createHttpError("Attendance request ID is invalid.");
  if (!reviewerId) throw createHttpError("Authenticated reviewer is required.", 401);

  const result = await withTransaction(async (client) => {
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
      throw createHttpError("This attendance request has already been reviewed.", 409);
    }

    let createdAttendanceCount = 0;
    if (status === "approved") {
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
      createdAttendanceCount = await addApprovedManualAttendance(
        client,
        request,
        eventResult.rows,
      );
      await refreshDerivedAttendanceResultsForSchoolYearsWithClient(client, [
        request.school_year_id,
      ]);
    }

    await client.query(
      `
        UPDATE attendance_requests
        SET
          status = $2,
          reviewed_by = $3,
          review_note = $4,
          reviewed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [request.id, status, reviewerId, reviewNote],
    );

    return { createdAttendanceCount };
  });

  return {
    request: await getRequestViewById(requestId),
    createdAttendanceCount: result.createdAttendanceCount,
  };
}
