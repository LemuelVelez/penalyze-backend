import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import { closeDatabasePool, withTransaction } from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const TARGET_EVENT_NAME = "Flag Raising Ceremony";
const TARGET_EVENT_DATE = "2026-09-01";
const TARGET_EVENT_DATE_LABEL = "September 1, 2026";
const PLACEHOLDER_STUDENT_ID = "TC-20-A-00000";
const DEFAULT_COLLEGE = "School of Criminal Justice Education";
const DEFAULT_PROGRAM = "BS Criminology";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";

const DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "criminal-justice-frc",
);

const FIXTURES = [
  {
    fileName: "FRC_SEPTEMBER_01_2026.txt",
    eventDate: TARGET_EVENT_DATE,
    eventDateLabel: TARGET_EVENT_DATE_LABEL,
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

export type SeedScjeFrcManualAttendeesResult = {
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

function getFixturePath(fileName: string) {
  return path.join(DATA_DIRECTORY, fileName);
}

function assertFixtureFilesExist() {
  const missingFiles = FIXTURES.map((fixture) => fixture.fileName).filter(
    (fileName) => !fs.existsSync(getFixturePath(fileName)),
  );

  if (missingFiles.length) {
    throw new Error(
      `Missing SCJE FRC manual-attendance fixture file(s): ${missingFiles.join(", ")}`,
    );
  }
}

function parseFixture(fixture: FixtureDefinition): ParsedFixture {
  const contents = fs
    .readFileSync(getFixturePath(fixture.fileName), "utf8")
    .replace(/^\uFEFF/, "");
  const rows: ManualAttendee[] = [];
  let skippedJunkRows = 0;

  contents.split(/\r?\n/).forEach((line, index) => {
    const sourceRowNumber = index + 1;
    const payload = clean(line);
    if (!payload) return;
    if (/^FRC\s+SEPTEMBER\s+01\s+2026$/i.test(payload)) return;

    if (!/^TC-\d{2}-A-\d{5}$/i.test(payload)) {
      skippedJunkRows += 1;
      return;
    }

    rows.push({
      studentId: normalizeStudentId(payload),
      name: "",
      yearLevel: "",
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: DEFAULT_INSTITUTION,
      scannedAt: null,
      eventDate: fixture.eventDate,
      eventDateLabel: fixture.eventDateLabel,
      sourceFile: fixture.fileName,
      sourceRowNumber,
    });
  });

  return { fixture, rows, skippedJunkRows };
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
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding SCJE FRC manual attendance.`,
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
        NULL,
        NULL,
        $4,
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
      `Seeded manual attendance event for the ${parsedFixture.fixture.eventDateLabel} SCJE Flag Raising Ceremony.`,
    ],
  );

  return { event: created.rows[0], created: true };
}

function mergeAttendeeRows(rows: ManualAttendee[]) {
  const merged = new Map<string, ManualAttendee>();

  rows.forEach((row) => {
    const key = normalizeStudentId(row.studentId);
    if (!key || key === PLACEHOLDER_STUDENT_ID || merged.has(key)) return;

    merged.set(key, {
      ...row,
      studentId: key,
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: DEFAULT_INSTITUTION,
      scannedAt: null,
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

function resolveRows(
  rows: ManualAttendee[],
  existingStudents: Map<string, StudentLookup>,
  unresolvedAttendees: string[],
) {
  const resolvedRows: ManualAttendee[] = [];

  rows.forEach((row) => {
    const studentId = normalizeStudentId(row.studentId);
    const existingStudent = existingStudents.get(studentId);
    const name = normalizeDisplayName(existingStudent?.name);

    if (!existingStudent || !name) {
      unresolvedAttendees.push(studentId);
      return;
    }

    resolvedRows.push({
      ...row,
      studentId,
      name,
      yearLevel: normalizeYearLevel(existingStudent.year_level),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: clean(existingStudent.institution) || DEFAULT_INSTITUTION,
      scannedAt: null,
    });
  });

  return resolvedRows;
}

async function updateExistingStudentDefaults(
  client: PoolClient,
  row: ManualAttendee,
) {
  const updated = await client.query<{ id: string }>(
    `
      UPDATE students
      SET
        college = COALESCE(NULLIF(TRIM(college), ''), $2),
        program = COALESCE(NULLIF(TRIM(program), ''), $3),
        institution = COALESCE(NULLIF(TRIM(institution), ''), $4),
        updated_at = NOW()
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        AND (
          NULLIF(TRIM(college), '') IS NULL
          OR NULLIF(TRIM(program), '') IS NULL
          OR NULLIF(TRIM(institution), '') IS NULL
        )
      RETURNING id
    `,
    [row.studentId, DEFAULT_COLLEGE, DEFAULT_PROGRAM, DEFAULT_INSTITUTION],
  );

  return Boolean(updated.rowCount);
}

async function insertManualAttendanceRow(
  client: PoolClient,
  schoolYearId: string,
  eventId: string,
  row: ManualAttendee,
) {
  const remarks =
    "Seeded as manual attendance from the September 1, 2026 SCJE FRC attendance sheet.";
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
        NULL
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
    ],
  );

  return inserted.rowCount ?? 0;
}

export async function seedScjeFrcManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedScjeFrcManualAttendeesResult> {
  onProgress?.("Verifying bundled SCJE FRC manual-attendance text fixture");
  assertFixtureFilesExist();

  onProgress?.("Parsing the bundled SCJE FRC attendance sheet");
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
    "Resolving SY 2026-2027 / First Semester and SCJE Flag Raising Ceremony event",
  );
  const transactionResult = await withTransaction(async (client) => {
    const schoolYearId = await getTargetSchoolYearId(client);
    let eventsCreated = 0;
    let manualAttendanceRecordsCreated = 0;
    let studentsChanged = 0;
    const unresolvedAttendees: string[] = [];

    for (const parsedFixture of parsedFixtures) {
      const targetEvent = await getOrCreateTargetEvent(
        client,
        schoolYearId,
        parsedFixture,
      );
      if (targetEvent.created) eventsCreated += 1;

      const mergedRows = mergeAttendeeRows(parsedFixture.rows);
      const existingStudents = await hydrateExistingStudents(client, mergedRows);
      const resolvedRows = resolveRows(
        mergedRows,
        existingStudents,
        unresolvedAttendees,
      );

      for (const row of resolvedRows) {
        if (await updateExistingStudentDefaults(client, row)) studentsChanged += 1;
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
      "Refreshing final attendance and penalty results after SCJE manual-attendance changes",
    );
    await refreshAttendanceFinalResults({
      schoolYearId: transactionResult.schoolYearId,
    });
  } else {
    onProgress?.(
      "SCJE manual attendance is unchanged; final attendance and penalty results do not need refreshing",
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
  seedScjeFrcManualAttendees()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "SCJE FRC manual attendance is already seeded."
          : `Created ${result.manualAttendanceRecordsCreated} SCJE FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      );
      if (result.unresolvedAttendees.length > 0) {
        console.warn(
          `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
        );
      }
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("SCJE FRC manual-attendance seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
