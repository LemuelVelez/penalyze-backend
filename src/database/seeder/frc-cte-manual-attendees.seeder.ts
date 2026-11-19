import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import { closeDatabasePool, withTransaction } from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";
import { normalizeAttendanceEventIdentityName } from "../../services/attendance-event-identity";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const EVENT_DATE = "2026-10-26";
const EVENT_DATE_LABEL = "October 26, 2026";
const EVENT_NAME = "FRC October 26";
const PLACEHOLDER_STUDENT_ID = "TC-20-A-00000";
const DEFAULT_COLLEGE = "College of Teacher Education";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";
const REMARKS =
  "Seeded as manual attendance from the October 26, 2026 CTE FRC attendance sheet.";
const EVENT_DESCRIPTION =
  "Seeded manual attendance event for the October 26, 2026 CTE Flag Raising Ceremony.";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;
const FIXTURE_FILE_NAME = "synthetic-frc-october-26-2026.csv";
const FIXTURE_PATH = path.join(
  __dirname,
  "data",
  "teacher-education-frc",
  FIXTURE_FILE_NAME,
);

type ManualAttendee = {
  studentId: string;
  name: string;
  yearLevel: string;
  college: string;
  program: string;
  institution: string;
  scannedAt: string | null;
  sourceRowNumber: number;
};

type StudentLookup = {
  student_id: string;
  name: string;
  year_level: string | null;
  college: string | null;
  program: string | null;
  institution: string | null;
};

type TargetEvent = {
  id: string;
  school_year_id: string;
  name: string;
};

export type SeedCteFrcManualAttendeesResult = {
  alreadySeeded: boolean;
  rowsParsed: number;
  manualAttendanceRecordsCreated: number;
  eventsCreated: number;
  skippedJunkRows: number;
  skippedOtherCollegeRows: number;
  unresolvedAttendees: string[];
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function collapseWhitespace(value: unknown) {
  return clean(value).replace(/\s+/g, " ");
}

function normalizeStudentId(value: unknown) {
  return clean(value).toUpperCase();
}

function normalizeName(value: unknown) {
  return collapseWhitespace(value).toLowerCase();
}

function normalizeDisplayName(value: unknown) {
  return collapseWhitespace(value);
}

function normalizeYearLevel(value: unknown) {
  const normalized = collapseWhitespace(value);
  const match = normalized.match(/^([1-5])(st|nd|rd|th)\s+year$/i);
  if (!match) return normalized;

  const ordinalSuffix: Record<string, string> = {
    "1": "st",
    "2": "nd",
    "3": "rd",
    "4": "th",
    "5": "th",
  };

  return `${match[1]}${ordinalSuffix[match[1]]} Year`;
}

function normalizeProgram(value: unknown) {
  const program = collapseWhitespace(value);
  if (/^(BPED|BPE|Bachelor of Physical Education)$/i.test(program)) {
    return "Bachelor of Physical Education";
  }
  if (/^BEEd$/i.test(program)) return "BEED";
  return program;
}

function isJunkPayload(payload: string) {
  const normalized = clean(payload);
  return /^\d+$/.test(normalized) || /^[A-Za-z]$/.test(normalized) || /^https?:\/\//i.test(normalized);
}

function parseLabelPayload(payload: string) {
  const fields = new Map<string, string>();

  payload
    .replace(/\r/g, "")
    .split("\n")
    .forEach((line) => {
      const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/);
      if (!match) return;
      fields.set(match[1].trim().toLowerCase(), clean(match[2]));
    });

  if (!fields.has("name") || !fields.has("student id")) return null;

  const name = normalizeDisplayName(fields.get("name"));
  if (!name) return null;

  return {
    studentId: normalizeStudentId(fields.get("student id")),
    name,
    yearLevel: normalizeYearLevel(fields.get("year level")),
    college: clean(fields.get("college")),
    program: normalizeProgram(fields.get("program")),
    institution: clean(fields.get("institution")),
  };
}

function parseJsonPayload(payload: string) {
  if (!payload.trimStart().startsWith("{")) return null;

  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const name = normalizeDisplayName(parsed.name);
    if (!name) return null;

    return {
      studentId: normalizeStudentId(parsed.studentId),
      name,
      yearLevel: normalizeYearLevel(parsed.yearLevel),
      college: DEFAULT_COLLEGE,
      program: normalizeProgram(parsed.degreeProgram),
      institution: DEFAULT_INSTITUTION,
    };
  } catch {
    return null;
  }
}

function parseTimeParts(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const fraction = ((value % 1) + 1) % 1;
    const totalSeconds =
      Math.round(fraction * SECONDS_PER_DAY) % SECONDS_PER_DAY;

    return {
      hours: Math.floor(totalSeconds / 3600),
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
      milliseconds: 0,
    };
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      hours: value.getUTCHours(),
      minutes: value.getUTCMinutes(),
      seconds: value.getUTCSeconds(),
      milliseconds: value.getUTCMilliseconds(),
    };
  }

  const text = clean(value);
  if (!text) return null;

  const numeric = Number(text);
  if (Number.isFinite(numeric) && numeric >= 0 && numeric < 1) {
    return parseTimeParts(numeric);
  }

  const match = text.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?$/i,
  );
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  const milliseconds = Number((match[4] ?? "0").padEnd(3, "0"));
  const meridiem = clean(match[5]).toUpperCase();

  if (
    minutes > 59 ||
    seconds > 59 ||
    (!meridiem && hours > 23) ||
    (meridiem && (hours < 1 || hours > 12))
  ) {
    return null;
  }

  if (meridiem === "AM" && hours === 12) hours = 0;
  if (meridiem === "PM" && hours !== 12) hours += 12;

  return { hours, minutes, seconds, milliseconds };
}

function combineManilaEventDateAndTime(eventDate: string, value: unknown) {
  const time = parseTimeParts(value);
  if (!time) return null;

  const dateMatch = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dateMatch) return null;

  const utcMilliseconds =
    Date.UTC(
      Number(dateMatch[1]),
      Number(dateMatch[2]) - 1,
      Number(dateMatch[3]),
      time.hours,
      time.minutes,
      time.seconds,
      time.milliseconds,
    ) - MANILA_OFFSET_MS;

  const timestamp = new Date(utcMilliseconds);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function parseQuotedCsvRecord(record: string) {
  const normalized = record.replace(/\r/g, "").trim();
  const values: string[] = [];
  let position = 0;

  while (position < normalized.length) {
    if (normalized[position] !== '"') return null;
    position += 1;

    let value = "";
    let closed = false;
    while (position < normalized.length) {
      const character = normalized[position];
      position += 1;

      if (character === '"') {
        if (normalized[position] === '"') {
          value += '"';
          position += 1;
        } else {
          closed = true;
          break;
        }
      } else {
        value += character;
      }
    }

    if (!closed) return null;
    values.push(value);
    if (position === normalized.length) return values;
    if (normalized[position] !== ",") return null;
    position += 1;
  }

  return null;
}

function normalizeFixtureDate(value: unknown, expectedEventDate: string) {
  const text = clean(value);
  const match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) return null;

  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);

  const toIsoDate = (month: number, day: number) => {
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) {
      return null;
    }
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  };

  const candidates = [toIsoDate(first, second), toIsoDate(second, first)].filter(
    (candidate): candidate is string => Boolean(candidate),
  );

  return candidates.includes(expectedEventDate) ? expectedEventDate : null;
}

function parseFixture() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    throw new Error(`Missing CTE FRC manual-attendance fixture: ${FIXTURE_PATH}`);
  }
  const contents = fs.readFileSync(FIXTURE_PATH, "utf8").replace(/^\uFEFF/, "");
  const csvRecords = contents.split(/\r?\n(?=")/);
  const header = parseQuotedCsvRecord(csvRecords[0] ?? "")?.map((value) =>
    clean(value).toUpperCase(),
  );
  const requiredColumns = [
    "NAME",
    "CHECK-IN DATE",
    "CHECK-IN TIME",
    "CHECK-OUT DATE",
    "CHECK-OUT TIME",
    "TOTAL",
  ];
  const missingColumns = requiredColumns.filter((column) => !header?.includes(column));
  if (!header || missingColumns.length) {
    throw new Error(`Invalid CTE FRC fixture header; missing: ${missingColumns.join(", ")}`);
  }

  const rows: ManualAttendee[] = [];
  let skippedJunkRows = 0;
  let skippedOtherCollegeRows = 0;

  csvRecords.slice(1).forEach((record, index) => {
    const sourceRowNumber = index + 2;
    const values = parseQuotedCsvRecord(record);
    if (!values || values.length !== header.length) {
      throw new Error(`Unable to parse CTE FRC CSV row ${sourceRowNumber}.`);
    }

    const payload = clean(values[header.indexOf("NAME")]);
    if (!payload) return;
    if (isJunkPayload(payload)) {
      skippedJunkRows += 1;
      return;
    }

    const parsedPayload = parseJsonPayload(payload) ?? parseLabelPayload(payload);
    if (!parsedPayload) {
      throw new Error(`Unable to parse CTE FRC attendee payload in row ${sourceRowNumber}: ${payload}`);
    }
    if (parsedPayload.college !== DEFAULT_COLLEGE) {
      skippedOtherCollegeRows += 1;
      return;
    }

    const checkInDate = clean(values[header.indexOf("CHECK-IN DATE")]);
    if (!normalizeFixtureDate(checkInDate, EVENT_DATE)) {
      throw new Error(`Unexpected CHECK-IN DATE in CTE FRC row ${sourceRowNumber}: ${checkInDate || "(empty)"}.`);
    }
    const checkInTime = clean(values[header.indexOf("CHECK-IN TIME")]);
    const scannedAt = combineManilaEventDateAndTime(EVENT_DATE, checkInTime);
    if (!scannedAt) {
      throw new Error(`Unable to parse CHECK-IN TIME in CTE FRC row ${sourceRowNumber}: ${checkInTime || "(empty)"}.`);
    }
    rows.push({
      studentId: normalizeStudentId(parsedPayload.studentId),
      name: normalizeDisplayName(parsedPayload.name),
      yearLevel: normalizeYearLevel(parsedPayload.yearLevel),
      college: DEFAULT_COLLEGE,
      program: normalizeProgram(parsedPayload.program),
      institution: clean(parsedPayload.institution) || DEFAULT_INSTITUTION,
      scannedAt,
      sourceRowNumber,
    });
  });

  return { rows, skippedJunkRows, skippedOtherCollegeRows };
}

function getEventBounds(rows: ManualAttendee[]) {
  const timestamps = rows
    .map((row) => row.scannedAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  return {
    startAt: timestamps[0]?.toISOString() ?? null,
    endAt: timestamps[timestamps.length - 1]?.toISOString() ?? null,
  };
}

async function getTargetSchoolYearId(client: PoolClient) {
  const result = await client.query<{ id: string }>(
    `
      SELECT id
      FROM school_years
      WHERE name = $1
        AND semester = $2
      LIMIT 1
    `,
    [TARGET_SCHOOL_YEAR, TARGET_SEMESTER],
  );

  const schoolYearId = result.rows[0]?.id;
  if (!schoolYearId) {
    throw new Error(
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding CTE FRC manual attendance.`,
    );
  }

  return schoolYearId;
}

async function getOrCreateTargetEvent(
  client: PoolClient,
  schoolYearId: string,
  rows: ManualAttendee[],
) {
  const existing = await client.query<TargetEvent>(
    `
      SELECT id, school_year_id, name
      FROM attendance_events
      WHERE school_year_id = $1
        AND (
          event_date = $2::date
          OR timezone('Asia/Manila', event_start_at)::date = $2::date
          OR timezone('Asia/Manila', event_end_at)::date = $2::date
        )
      ORDER BY created_at ASC, id ASC
    `,
    [schoolYearId, EVENT_DATE],
  );

  const targetIdentity = normalizeAttendanceEventIdentityName(
    EVENT_NAME,
  );
  const namedMatch = existing.rows.find(
    (event) =>
      normalizeAttendanceEventIdentityName(event.name) === targetIdentity,
  );
  if (namedMatch) {
    return { event: namedMatch, created: false };
  }

  const frcIdentity = normalizeAttendanceEventIdentityName("FRC");
  const compatibleFrcMatch = existing.rows.find((event) =>
    normalizeAttendanceEventIdentityName(event.name).includes(frcIdentity),
  );
  if (compatibleFrcMatch) return { event: compatibleFrcMatch, created: false };

  if (existing.rows.length === 1) {
    return { event: existing.rows[0], created: false };
  }

  const bounds = getEventBounds(rows);
  const created = await client.query<TargetEvent>(
    `
      INSERT INTO attendance_events (
        school_year_id,
        name,
        event_date,
        event_start_at,
        event_end_at,
        description,
        event_order
      )
      VALUES (
        $1,
        $2,
        $3::date,
        $4::timestamptz,
        $5::timestamptz,
        $6,
        COALESCE(
          (SELECT MAX(event_order) + 1 FROM attendance_events WHERE school_year_id = $1),
          1
        )
      )
      RETURNING id, school_year_id, name
    `,
    [
      schoolYearId,
      EVENT_NAME,
      EVENT_DATE,
      bounds.startAt,
      bounds.endAt,
      EVENT_DESCRIPTION,
    ],
  );

  return { event: created.rows[0], created: true };
}

async function resolveStudentByExactName(
  client: PoolClient,
  name: string,
): Promise<StudentLookup | null> {
  const normalizedName = normalizeName(name);
  if (!normalizedName) return null;

  const result = await client.query<StudentLookup>(
    `
      SELECT student_id, name, year_level, college, program, institution
      FROM students
      WHERE REGEXP_REPLACE(LOWER(TRIM(name)), '[[:space:]]+', ' ', 'g') = $1
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 2
    `,
    [normalizedName],
  );

  return result.rows.length === 1 ? result.rows[0] : null;
}

async function resolveRows(
  client: PoolClient,
  rows: ManualAttendee[],
  unresolvedAttendees: string[],
  unresolvedKeys: Set<string>,
  resolvedStudentCache: Map<string, StudentLookup | null>,
) {
  const resolvedRows: ManualAttendee[] = [];

  for (const row of rows) {
    const currentStudentId = normalizeStudentId(row.studentId);
    const needsNameResolution =
      !currentStudentId || currentStudentId === PLACEHOLDER_STUDENT_ID;

    if (!needsNameResolution) {
      resolvedRows.push({ ...row, studentId: currentStudentId });
      continue;
    }

    const normalizedName = normalizeName(row.name);
    let resolvedStudent = resolvedStudentCache.get(normalizedName);
    if (resolvedStudent === undefined) {
      resolvedStudent = await resolveStudentByExactName(client, row.name);
      resolvedStudentCache.set(normalizedName, resolvedStudent);
    }

    if (
      !resolvedStudent ||
      !normalizeStudentId(resolvedStudent.student_id) ||
      normalizeStudentId(resolvedStudent.student_id) === PLACEHOLDER_STUDENT_ID
    ) {
      const unresolvedKey = normalizedName;
      if (!unresolvedKeys.has(unresolvedKey)) {
        unresolvedKeys.add(unresolvedKey);
        unresolvedAttendees.push(
          `${row.name} (${EVENT_DATE}${currentStudentId ? `, ${currentStudentId}` : ""})`,
        );
      }
      continue;
    }

    resolvedRows.push({
      ...row,
      studentId: normalizeStudentId(resolvedStudent.student_id),
      name: normalizeDisplayName(resolvedStudent.name) || row.name,
      yearLevel: row.yearLevel || normalizeYearLevel(resolvedStudent.year_level),
      college: DEFAULT_COLLEGE,
      program: row.program || normalizeProgram(resolvedStudent.program),
      institution:
        clean(row.institution) ||
        clean(resolvedStudent.institution) ||
        DEFAULT_INSTITUTION,
    });
  }

  return resolvedRows;
}

function mergeAttendeeRows(rows: ManualAttendee[]) {
  const merged = new Map<string, ManualAttendee>();

  rows.forEach((row) => {
    const key = normalizeStudentId(row.studentId);
    if (!key) return;

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, studentId: key, college: DEFAULT_COLLEGE });
      return;
    }

    const existingTime = existing.scannedAt
      ? new Date(existing.scannedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const rowTime = row.scannedAt
      ? new Date(row.scannedAt).getTime()
      : Number.POSITIVE_INFINITY;
    const earlier = rowTime < existingTime ? row : existing;
    const later = earlier === row ? existing : row;

    merged.set(key, {
      ...earlier,
      studentId: key,
      name:
        normalizeDisplayName(earlier.name) || normalizeDisplayName(later.name),
      yearLevel:
        normalizeYearLevel(earlier.yearLevel) ||
        normalizeYearLevel(later.yearLevel),
      college: DEFAULT_COLLEGE,
      program: normalizeProgram(earlier.program) || normalizeProgram(later.program),
      institution:
        clean(earlier.institution) ||
        clean(later.institution) ||
        DEFAULT_INSTITUTION,
      scannedAt: earlier.scannedAt ?? later.scannedAt,
    });
  });

  return Array.from(merged.values());
}

async function hydrateExistingStudents(
  client: PoolClient,
  rows: ManualAttendee[],
) {
  const normalizedIds = Array.from(
    new Set(
      rows
        .map((row) => normalizeStudentId(row.studentId).toLowerCase())
        .filter(Boolean),
    ),
  );
  if (!normalizedIds.length) return new Map<string, StudentLookup>();

  const result = await client.query<StudentLookup>(
    `
      SELECT student_id, name, year_level, college, program, institution
      FROM students
      WHERE LOWER(TRIM(student_id)) = ANY($1::text[])
    `,
    [normalizedIds],
  );

  return new Map(
    result.rows.map((row) => [normalizeStudentId(row.student_id), row]),
  );
}

function hydrateRowsWithStudents(
  rows: ManualAttendee[],
  existingStudents: Map<string, StudentLookup>,
) {
  return rows.map((row) => {
    const existingStudent = existingStudents.get(
      normalizeStudentId(row.studentId),
    );

    return {
      ...row,
      name:
        row.scannedAt === null
          ? normalizeDisplayName(existingStudent?.name) ||
            normalizeDisplayName(row.name)
          : normalizeDisplayName(row.name) ||
            normalizeDisplayName(existingStudent?.name),
      yearLevel:
        normalizeYearLevel(row.yearLevel) ||
        normalizeYearLevel(existingStudent?.year_level),
      college: DEFAULT_COLLEGE,
      program: normalizeProgram(row.program) || normalizeProgram(existingStudent?.program),
      institution:
        clean(row.institution) ||
        clean(existingStudent?.institution) ||
        DEFAULT_INSTITUTION,
    };
  });
}

async function upsertStudent(client: PoolClient, row: ManualAttendee) {
  const params = [
    row.studentId,
    row.name,
    row.yearLevel,
    DEFAULT_COLLEGE,
    row.program,
    row.institution || DEFAULT_INSTITUTION,
  ];

  const updated = await client.query<{ id: string }>(
    `
      UPDATE students
      SET
        name = COALESCE(NULLIF($2, ''), name),
        year_level = COALESCE(NULLIF($3, ''), year_level),
        college = COALESCE(NULLIF($4, ''), college),
        program = COALESCE(NULLIF($5, ''), program),
        institution = COALESCE(NULLIF($6, ''), institution),
        updated_at = NOW()
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND (
          name IS DISTINCT FROM COALESCE(NULLIF($2, ''), name)
          OR year_level IS DISTINCT FROM COALESCE(NULLIF($3, ''), year_level)
          OR college IS DISTINCT FROM COALESCE(NULLIF($4, ''), college)
          OR program IS DISTINCT FROM COALESCE(NULLIF($5, ''), program)
          OR institution IS DISTINCT FROM COALESCE(NULLIF($6, ''), institution)
        )
      RETURNING id
    `,
    params,
  );

  if (updated.rowCount) return true;

  const existing = await client.query<{ id: string }>(
    `
      SELECT id
      FROM students
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
      LIMIT 1
    `,
    [row.studentId],
  );
  if (existing.rows[0]) return false;

  const inserted = await client.query<{ id: string }>(
    `
      INSERT INTO students (
        student_id,
        name,
        year_level,
        college,
        program,
        institution
      )
      VALUES (
        $1,
        NULLIF($2, ''),
        NULLIF($3, ''),
        NULLIF($4, ''),
        NULLIF($5, ''),
        NULLIF($6, '')
      )
      ON CONFLICT (student_id)
      DO UPDATE SET
        name = COALESCE(NULLIF(EXCLUDED.name, ''), students.name),
        year_level = COALESCE(NULLIF(EXCLUDED.year_level, ''), students.year_level),
        college = COALESCE(NULLIF(EXCLUDED.college, ''), students.college),
        program = COALESCE(NULLIF(EXCLUDED.program, ''), students.program),
        institution = COALESCE(NULLIF(EXCLUDED.institution, ''), students.institution),
        updated_at = NOW()
      RETURNING id
    `,
    params,
  );

  return Boolean(inserted.rowCount);
}

async function insertManualAttendanceRow(
  client: PoolClient,
  schoolYearId: string,
  eventId: string,
  row: ManualAttendee,
) {
  const inserted = await client.query<{ id: string }>(
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
      SELECT
        $1,
        $2,
        'manual',
        $3,
        $4,
        NULLIF($5, ''),
        $6,
        NULLIF($7, ''),
        NULLIF($8, ''),
        0,
        $9,
        $10::timestamptz
      WHERE NOT EXISTS (
        SELECT 1
        FROM manual_attendance_records mar
        WHERE mar.event_id = $2
          AND LOWER(TRIM(mar.student_id)) = LOWER(TRIM($3))
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      )
      RETURNING id
    `,
    [
      schoolYearId,
      eventId,
      row.studentId,
      row.name,
      row.yearLevel,
      DEFAULT_COLLEGE,
      row.program,
      row.institution || DEFAULT_INSTITUTION,
      REMARKS,
      row.scannedAt,
    ],
  );

  return inserted.rowCount ?? 0;
}

export async function seedCteFrcManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedCteFrcManualAttendeesResult> {
  onProgress?.(`Parsing the bundled CTE FRC attendance for ${EVENT_DATE_LABEL}`);
  const { rows, skippedJunkRows, skippedOtherCollegeRows } = parseFixture();
  const rowsParsed = rows.length;

  onProgress?.("Resolving SY 2026-2027 / First Semester and CTE FRC event");
  const transactionResult = await withTransaction(async (client) => {
    const schoolYearId = await getTargetSchoolYearId(client);
    const unresolvedAttendees: string[] = [];
    const resolvedRows = await resolveRows(
      client,
      rows,
      unresolvedAttendees,
      new Set<string>(),
      new Map<string, StudentLookup | null>(),
    );
    const mergedRows = mergeAttendeeRows(resolvedRows);
    if (!mergedRows.length) {
      return {
        schoolYearId,
        eventsCreated: 0,
        manualAttendanceRecordsCreated: 0,
        studentsChanged: 0,
        unresolvedAttendees,
      };
    }

    const targetEvent = await getOrCreateTargetEvent(client, schoolYearId, mergedRows);
    const existingStudents = await hydrateExistingStudents(client, mergedRows);
    const hydratedRows = hydrateRowsWithStudents(mergedRows, existingStudents);
    let manualAttendanceRecordsCreated = 0;
    let studentsChanged = 0;

    for (const row of hydratedRows) {
      if (await upsertStudent(client, row)) studentsChanged += 1;
      manualAttendanceRecordsCreated += await insertManualAttendanceRow(
        client,
        schoolYearId,
        targetEvent.event.id,
        row,
      );
    }

    return {
      schoolYearId,
      eventsCreated: targetEvent.created ? 1 : 0,
      manualAttendanceRecordsCreated,
      studentsChanged,
      unresolvedAttendees,
    };
  });

  const changed =
    transactionResult.eventsCreated > 0 ||
    transactionResult.manualAttendanceRecordsCreated > 0 ||
    transactionResult.studentsChanged > 0;
  if (changed) {
    onProgress?.("Refreshing final attendance and penalty results after CTE FRC changes");
    await refreshAttendanceFinalResults({ schoolYearId: transactionResult.schoolYearId });
  } else {
    onProgress?.("CTE FRC manual attendance is unchanged; no refresh needed");
  }

  return {
    alreadySeeded: !changed,
    rowsParsed,
    manualAttendanceRecordsCreated: transactionResult.manualAttendanceRecordsCreated,
    eventsCreated: transactionResult.eventsCreated,
    skippedJunkRows,
    skippedOtherCollegeRows,
    unresolvedAttendees: transactionResult.unresolvedAttendees,
  };
}

if (require.main === module) {
  seedCteFrcManualAttendees()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "CTE FRC manual attendance is already seeded."
          : `Created ${result.manualAttendanceRecordsCreated} CTE FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      );
      if (result.unresolvedAttendees.length > 0) {
        console.warn(
          `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
        );
      }
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("CTE FRC manual-attendance seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
