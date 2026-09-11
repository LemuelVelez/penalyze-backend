import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import { closeDatabasePool, withTransaction } from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const TARGET_EVENT_NAME = "Flag Raising Ceremony";
const PLACEHOLDER_STUDENT_ID = "TC-20-A-00000";
const DEFAULT_COLLEGE = "School of Engineering";
const DEFAULT_PROGRAM = "Agricultural Biosystems Engineering";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;

const DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "engineering-frc",
);

const FIXTURES = [
  {
    fileName: "FRC__August_24_2026_.csv",
    eventDate: "2026-08-24",
    eventDateLabel: "August 24, 2026",
  },
] as const;

type FixtureDefinition = (typeof FIXTURES)[number];

type ManualAttendee = {
  studentId: string;
  name: string;
  yearLevel: string;
  college: string;
  program: string;
  institution: string;
  scannedAt: string | null;
  eventDate: string;
  eventDateLabel: string;
  sourceFile: string;
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
};

type ParsedFixture = {
  fixture: FixtureDefinition;
  rows: ManualAttendee[];
  skippedJunkRows: number;
};

export type SeedSoeFrcManualAttendeesResult = {
  alreadySeeded: boolean;
  rowsParsed: number;
  manualAttendanceRecordsCreated: number;
  eventsCreated: number;
  skippedJunkRows: number;
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
  return collapseWhitespace(value);
}

function getFixturePath(fileName: string) {
  return path.join(DATA_DIRECTORY, fileName);
}

function assertFixtureFilesExist() {
  const missingFiles = FIXTURES.map((fixture) => fixture.fileName).filter(
    (fileName) => !fs.existsSync(getFixturePath(fileName)),
  );

  if (missingFiles.length) {
    throw new Error(
      `Missing SOE FRC manual-attendance fixture file(s): ${missingFiles.join(", ")}`,
    );
  }
}

function isJunkPayload(payload: string) {
  const normalized = clean(payload);
  return /^\d+$/.test(normalized) || /^[A-Za-z]$/.test(normalized);
}

function extractStudentId(value: string) {
  const match = value.match(/\bTC-[A-Z0-9-]+\b/i);
  return match ? normalizeStudentId(match[0]) : "";
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
      program: normalizeProgram(parsed.degreeProgram),
      institution: DEFAULT_INSTITUTION,
    };
  } catch {
    return null;
  }
}

function parseNameWithTrailingId(payload: string) {
  const singleLine = payload.replace(/\r?\n/g, " ").trim();
  const match = singleLine.match(
    /^\s*(?:Name\s*:\s*)?(.+?)\s+(TC-[A-Z0-9-]+)\s*$/i,
  );
  if (!match) return null;

  const name = normalizeDisplayName(match[1]);
  if (!name) return null;

  return {
    studentId: normalizeStudentId(match[2]),
    name,
    yearLevel: "",
    program: "",
    institution: DEFAULT_INSTITUTION,
  };
}

function parseDelimitedPayload(payload: string) {
  const lineOrPipeParts = payload
    .replace(/\r/g, "")
    .split(/\n|\|/)
    .map((part) => clean(part))
    .filter(Boolean);

  const exactIdIndex = lineOrPipeParts.findIndex((part) =>
    /^TC-[A-Z0-9-]+$/i.test(part),
  );

  if (exactIdIndex >= 0) {
    const studentId = normalizeStudentId(lineOrPipeParts[exactIdIndex]);
    const nameCandidate =
      exactIdIndex === 0
        ? lineOrPipeParts[1]
        : lineOrPipeParts.slice(0, exactIdIndex).join(" ");
    const name = normalizeDisplayName(
      clean(nameCandidate).replace(/^Name\s*:\s*/i, ""),
    );
    if (!name) return null;

    const trailingParts = lineOrPipeParts.slice(
      exactIdIndex === 0 ? 2 : exactIdIndex + 1,
    );
    const programCandidate = trailingParts.find(
      (part) =>
        !/^college\s+of\s+agriculture\s+and\s+forestry$/i.test(part) &&
        !/^Name\s*:/i.test(part),
    );

    return {
      studentId,
      name,
      yearLevel: "",
      program: normalizeProgram(programCandidate),
      institution: DEFAULT_INSTITUTION,
    };
  }

  const commaParts = payload
    .replace(/\r?\n/g, " ")
    .split(",")
    .map((part) => clean(part));
  const commaIdIndex = commaParts.findIndex((part) =>
    /^TC-[A-Z0-9-]+$/i.test(part),
  );

  if (commaIdIndex > 0) {
    const name = normalizeDisplayName(
      commaParts.slice(0, commaIdIndex).join(", "),
    );
    if (!name) return null;

    return {
      studentId: normalizeStudentId(commaParts[commaIdIndex]),
      name,
      yearLevel: "",
      program: normalizeProgram(commaParts[commaIdIndex + 1]),
      institution: DEFAULT_INSTITUTION,
    };
  }

  return null;
}

function parseNameOnlyPayload(payload: string) {
  if (extractStudentId(payload)) return null;

  const firstLine = payload
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => clean(line))
    .find(Boolean);
  if (!firstLine) return null;

  const name = normalizeDisplayName(firstLine.replace(/^Name\s*:\s*/i, ""));
  if (name.split(/\s+/).length < 2) return null;

  return {
    studentId: "",
    name,
    yearLevel: "",
    program: "",
    institution: DEFAULT_INSTITUTION,
  };
}

function parseScannerPayload(payload: string) {
  return (
    parseJsonPayload(payload) ??
    parseLabelPayload(payload) ??
    parseDelimitedPayload(payload) ??
    parseNameWithTrailingId(payload) ??
    parseNameOnlyPayload(payload)
  );
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
  if (!normalized.startsWith('"') || !normalized.endsWith('"')) {
    return null;
  }

  return normalized
    .slice(1, -1)
    .split('\",\"')
    .map((value) => value.replace(/\"\"/g, '"'));
}

function parseFixture(fixture: FixtureDefinition): ParsedFixture {
  const contents = fs
    .readFileSync(getFixturePath(fixture.fileName), "utf8")
    .replace(/^\uFEFF/, "");
  const csvRecords = contents.split(/\r?\n(?=")/);
  const header = parseQuotedCsvRecord(csvRecords[0] ?? "")?.map((value) =>
    clean(value).toUpperCase(),
  );

  if (!header) {
    throw new Error(
      `SOE FRC fixture ${fixture.fileName} has an invalid CSV header.`,
    );
  }

  const nameColumnIndex = header.indexOf("NAME");
  const checkInDateColumnIndex = header.indexOf("CHECK-IN DATE");
  const checkInTimeColumnIndex = header.indexOf("CHECK-IN TIME");
  const requiredColumns = [
    "NAME",
    "CHECK-IN DATE",
    "CHECK-IN TIME",
    "CHECK-OUT DATE",
    "CHECK-OUT TIME",
    "TOTAL",
  ];
  const missingColumns = requiredColumns.filter(
    (column) => !header.includes(column),
  );

  if (
    missingColumns.length > 0 ||
    nameColumnIndex < 0 ||
    checkInDateColumnIndex < 0 ||
    checkInTimeColumnIndex < 0
  ) {
    throw new Error(
      `SOE FRC fixture ${fixture.fileName} is missing required CSV column(s): ${missingColumns.join(", ") || "NAME, CHECK-IN DATE, or CHECK-IN TIME"}`,
    );
  }

  const rows: ManualAttendee[] = [];
  let skippedJunkRows = 0;

  csvRecords.slice(1).forEach((record, index) => {
    const sourceRowNumber = index + 2;
    const values = parseQuotedCsvRecord(record);
    if (!values || values.length !== header.length) {
      throw new Error(
        `Unable to parse SOE FRC CSV row ${sourceRowNumber} in ${fixture.fileName}.`,
      );
    }

    const payload = clean(values[nameColumnIndex]);
    if (!payload) return;

    if (isJunkPayload(payload)) {
      skippedJunkRows += 1;
      return;
    }

    const parsedPayload = parseScannerPayload(payload);
    if (!parsedPayload) {
      throw new Error(
        `Unable to parse SOE FRC attendee payload in ${fixture.fileName} row ${sourceRowNumber}: ${payload}`,
      );
    }

    const checkInDate = clean(values[checkInDateColumnIndex]);
    if (checkInDate !== "08-24-2026") {
      throw new Error(
        `Unexpected CHECK-IN DATE in ${fixture.fileName} row ${sourceRowNumber}: ${checkInDate || "(empty)"}.`,
      );
    }

    const checkInTime = clean(values[checkInTimeColumnIndex]);
    const scannedAt = combineManilaEventDateAndTime(
      fixture.eventDate,
      checkInTime,
    );
    if (!scannedAt) {
      throw new Error(
        `Unable to parse CHECK-IN TIME in ${fixture.fileName} row ${sourceRowNumber}: ${checkInTime || "(empty)"}.`,
      );
    }

    rows.push({
      studentId: normalizeStudentId(parsedPayload.studentId),
      name: normalizeDisplayName(parsedPayload.name),
      yearLevel: normalizeYearLevel(parsedPayload.yearLevel),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: clean(parsedPayload.institution) || DEFAULT_INSTITUTION,
      scannedAt,
      eventDate: fixture.eventDate,
      eventDateLabel: fixture.eventDateLabel,
      sourceFile: fixture.fileName,
      sourceRowNumber,
    });
  });

  return { fixture, rows, skippedJunkRows };
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
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding SOE FRC manual attendance.`,
    );
  }

  return schoolYearId;
}

async function getOrCreateTargetEvent(
  client: PoolClient,
  schoolYearId: string,
  parsedFixture: ParsedFixture,
) {
  const existing = await client.query<TargetEvent>(
    `
      SELECT id, school_year_id
      FROM attendance_events
      WHERE school_year_id = $1
        AND LOWER(TRIM(name)) = LOWER(TRIM($2))
        AND (
          event_date = $3::date
          OR timezone('Asia/Manila', event_start_at)::date = $3::date
          OR timezone('Asia/Manila', event_end_at)::date = $3::date
        )
      ORDER BY created_at ASC
      LIMIT 1
    `,
    [schoolYearId, TARGET_EVENT_NAME, parsedFixture.fixture.eventDate],
  );

  if (existing.rows[0]) {
    return { event: existing.rows[0], created: false };
  }

  const bounds = getEventBounds(parsedFixture.rows);
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
      RETURNING id, school_year_id
    `,
    [
      schoolYearId,
      TARGET_EVENT_NAME,
      parsedFixture.fixture.eventDate,
      bounds.startAt,
      bounds.endAt,
      `Seeded manual attendance event for the ${parsedFixture.fixture.eventDateLabel} SOE Flag Raising Ceremony.`,
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

    if (!resolvedStudent) {
      const unresolvedKey = `${row.eventDate}:${normalizedName}`;
      if (!unresolvedKeys.has(unresolvedKey)) {
        unresolvedKeys.add(unresolvedKey);
        unresolvedAttendees.push(
          `${row.name} (${row.eventDate}${currentStudentId ? `, ${currentStudentId}` : ""})`,
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
      program: DEFAULT_PROGRAM,
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
      program: DEFAULT_PROGRAM,
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
        normalizeDisplayName(row.name) ||
        normalizeDisplayName(existingStudent?.name),
      yearLevel:
        normalizeYearLevel(row.yearLevel) ||
        normalizeYearLevel(existingStudent?.year_level),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
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
    DEFAULT_PROGRAM,
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
  const remarks =
    "Seeded as manual attendance from the August 24, 2026 SOE FRC attendance sheet.";
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
      DEFAULT_PROGRAM,
      row.institution || DEFAULT_INSTITUTION,
      remarks,
      row.scannedAt,
    ],
  );

  return inserted.rowCount ?? 0;
}

export async function seedSoeFrcManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedSoeFrcManualAttendeesResult> {
  onProgress?.("Verifying bundled SOE FRC manual-attendance CSV fixture");
  assertFixtureFilesExist();

  onProgress?.("Parsing the bundled SOE FRC attendance CSV");
  const parsedFixtures = FIXTURES.map((fixture) => parseFixture(fixture));
  const rowsParsed = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.rows.length,
    0,
  );
  const skippedJunkRows = parsedFixtures.reduce(
    (sum, parsedFixture) => sum + parsedFixture.skippedJunkRows,
    0,
  );

  onProgress?.(
    "Resolving SY 2026-2027 / First Semester and SOE Flag Raising Ceremony event",
  );
  const transactionResult = await withTransaction(async (client) => {
    const schoolYearId = await getTargetSchoolYearId(client);
    let eventsCreated = 0;
    let manualAttendanceRecordsCreated = 0;
    let studentsChanged = 0;
    const unresolvedAttendees: string[] = [];
    const unresolvedKeys = new Set<string>();
    const resolvedStudentCache = new Map<string, StudentLookup | null>();

    for (const parsedFixture of parsedFixtures) {
      const targetEvent = await getOrCreateTargetEvent(
        client,
        schoolYearId,
        parsedFixture,
      );
      if (targetEvent.created) eventsCreated += 1;

      const resolvedRows = await resolveRows(
        client,
        parsedFixture.rows,
        unresolvedAttendees,
        unresolvedKeys,
        resolvedStudentCache,
      );
      const mergedRows = mergeAttendeeRows(resolvedRows);
      const existingStudents = await hydrateExistingStudents(
        client,
        mergedRows,
      );
      const hydratedRows = hydrateRowsWithStudents(
        mergedRows,
        existingStudents,
      );

      for (const row of hydratedRows) {
        if (await upsertStudent(client, row)) studentsChanged += 1;
        manualAttendanceRecordsCreated += await insertManualAttendanceRow(
          client,
          schoolYearId,
          targetEvent.event.id,
          row,
        );
      }
    }

    return {
      schoolYearId,
      eventsCreated,
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
    onProgress?.(
      "Refreshing final attendance and penalty results after SOE manual-attendance changes",
    );
    await refreshAttendanceFinalResults({
      schoolYearId: transactionResult.schoolYearId,
    });
  } else {
    onProgress?.(
      "SOE manual attendance is unchanged; final attendance and penalty results do not need refreshing",
    );
  }

  return {
    alreadySeeded: !changed,
    rowsParsed,
    manualAttendanceRecordsCreated:
      transactionResult.manualAttendanceRecordsCreated,
    eventsCreated: transactionResult.eventsCreated,
    skippedJunkRows,
    unresolvedAttendees: transactionResult.unresolvedAttendees,
  };
}

if (require.main === module) {
  seedSoeFrcManualAttendees()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "SOE FRC manual attendance is already seeded."
          : `Created ${result.manualAttendanceRecordsCreated} SOE FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      );
      if (result.unresolvedAttendees.length > 0) {
        console.warn(
          `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
        );
      }
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("SOE FRC manual-attendance seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
