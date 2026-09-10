import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import {
  closeDatabasePool,
  query,
  withTransaction,
} from "../../lib/db";
import { refreshAttendanceFinalResults } from "../../services/attendance.service";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const TARGET_EVENT_NAME = "Flag Raising Ceremony";
const DEFAULT_COLLEGE = "College of Liberal Arts, Mathematics and Sciences";
const DEFAULT_PROGRAM = "BAELS";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";

const DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "liberal-arts-frc",
);

const FIXTURES = [
  {
    fileName: "attendance_sheet_08_24_26.txt",
    eventDate: "2026-08-24",
    eventDateLabel: "August 24, 2026",
  },
  {
    fileName: "attendance_sheet_09_01_26.txt",
    eventDate: "2026-09-01",
    eventDateLabel: "September 1, 2026",
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
  scannedAt: null;
  eventDate: string;
  eventDateLabel: string;
  sourceFile: string;
  sourceLineNumber: number;
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

export type SeedLamsFrcManualAttendeesResult = {
  alreadySeeded: boolean;
  rowsParsed: number;
  manualAttendanceRecordsCreated: number;
  eventsCreated: number;
  skippedJunkRows: number;
  unresolvedAttendees: string[];
};

function clean(value: unknown) {
  return String(value ?? "").replace(/^\uFEFF/, "").trim();
}

function collapseWhitespace(value: unknown) {
  return clean(value).replace(/\s+/g, " ");
}

function normalizeStudentId(value: unknown) {
  return clean(value).toUpperCase();
}

function normalizeName(value: unknown) {
  return normalizeDisplayName(value).toLowerCase();
}

function normalizeDisplayName(value: unknown) {
  return collapseWhitespace(value).replace(/\s*,\s*/g, ", ");
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
      `Missing LAMS FRC manual-attendance fixture file(s): ${missingFiles.join(", ")}`,
    );
  }
}

function extractStudentId(value: string) {
  const match = value.match(/\bTC-[A-Z0-9-]+\b/i);
  return match ? normalizeStudentId(match[0]) : "";
}

function extractYearLevelHeader(value: string) {
  const match = collapseWhitespace(value).match(
    /^BAELS\s+([1-4](?:st|nd|rd|th))\s+YEAR\s+ATTENDANCE$/i,
  );
  return match ? normalizeYearLevel(`${match[1]} Year`) : "";
}

function isJunkPayload(payload: string) {
  const normalized = collapseWhitespace(payload);
  if (!normalized) return false;

  return (
    /^\d+$/.test(normalized) ||
    /^No\.?$/i.test(normalized) ||
    /^Names$/i.test(normalized) ||
    /^TC\s+NUMBER$/i.test(normalized) ||
    /^Republic of the Philippines$/i.test(normalized) ||
    /^JOSE RIZAL MEMORIAL STATE UNIVERSITY$/i.test(normalized) ||
    /^The Premier University in Zamboanga del Norte$/i.test(normalized) ||
    /^TAMPILIAN CAMPUS$/i.test(normalized) ||
    /^Znac,\s*Tampilisan,\s*Zamboanga del Norte$/i.test(normalized) ||
    /^COLLEGE OF LIBERAL ARTS, MATHEMATICS AND SCIENCES$/i.test(normalized) ||
    /^(?:August 24|September 1),?\s*2026$/i.test(normalized) ||
    /^FLAG RAISING CEREMONY$/i.test(normalized) ||
    /^BAELS\s+[1-4](?:st|nd|rd|th)\s+YEAR\s+ATTENDANCE$/i.test(normalized)
  );
}

function parseFixture(fixture: FixtureDefinition): ParsedFixture {
  const source = fs.readFileSync(getFixturePath(fixture.fileName), "utf8");
  const lines = source.replace(/\r/g, "").split("\n");
  const rows: ManualAttendee[] = [];
  let skippedJunkRows = 0;
  let currentYearLevel = "";
  let pendingName: { name: string; sourceLineNumber: number } | null = null;

  const pushPendingName = (studentId = "") => {
    if (!pendingName) return;

    rows.push({
      studentId: normalizeStudentId(studentId),
      name: pendingName.name,
      yearLevel: currentYearLevel,
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution: "",
      scannedAt: null,
      eventDate: fixture.eventDate,
      eventDateLabel: fixture.eventDateLabel,
      sourceFile: fixture.fileName,
      sourceLineNumber: pendingName.sourceLineNumber,
    });
    pendingName = null;
  };

  lines.forEach((line, index) => {
    const payload = clean(line);
    if (!payload) return;

    const sectionYearLevel = extractYearLevelHeader(payload);
    if (sectionYearLevel) {
      pushPendingName();
      currentYearLevel = sectionYearLevel;
      skippedJunkRows += 1;
      return;
    }

    const studentId = extractStudentId(payload);
    if (studentId) {
      if (pendingName) {
        pushPendingName(studentId);
      } else {
        skippedJunkRows += 1;
      }
      return;
    }

    if (isJunkPayload(payload)) {
      if (/^\d+$/.test(collapseWhitespace(payload))) {
        pushPendingName();
      }
      skippedJunkRows += 1;
      return;
    }

    if (pendingName) pushPendingName();
    pendingName = {
      name: normalizeDisplayName(payload),
      sourceLineNumber: index + 1,
    };
  });

  pushPendingName();

  return { fixture, rows, skippedJunkRows };
}

async function getTargetSchoolYearId() {
  const result = await query<{ id: string }>(
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
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding LAMS FRC manual attendance.`,
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
      `Seeded manual attendance event for the ${parsedFixture.fixture.eventDateLabel} LAMS Flag Raising Ceremony.`,
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
    if (currentStudentId) {
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
        unresolvedAttendees.push(`${row.name} (${row.eventDate})`);
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
      merged.set(key, {
        ...row,
        studentId: key,
        college: DEFAULT_COLLEGE,
        program: DEFAULT_PROGRAM,
      });
      return;
    }

    merged.set(key, {
      ...existing,
      studentId: key,
      name: normalizeDisplayName(existing.name) || normalizeDisplayName(row.name),
      yearLevel:
        normalizeYearLevel(existing.yearLevel) || normalizeYearLevel(row.yearLevel),
      college: DEFAULT_COLLEGE,
      program: DEFAULT_PROGRAM,
      institution:
        clean(existing.institution) ||
        clean(row.institution) ||
        DEFAULT_INSTITUTION,
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

function hydrateRowsWithStudents(
  rows: ManualAttendee[],
  existingStudents: Map<string, StudentLookup>,
) {
  return rows.map((row) => {
    const existingStudent = existingStudents.get(normalizeStudentId(row.studentId));

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
      scannedAt: null,
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
  const remarks = `Seeded as manual attendance from the ${row.eventDateLabel} LAMS FRC attendance sheet.`;
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
        $7,
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

export async function seedLamsFrcManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedLamsFrcManualAttendeesResult> {
  onProgress?.("Verifying bundled LAMS FRC manual-attendance text fixtures");
  assertFixtureFilesExist();

  onProgress?.("Parsing the bundled LAMS FRC attendance sheets");
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
    "Resolving SY 2026-2027 / First Semester and LAMS Flag Raising Ceremony events",
  );
  const schoolYearId = await getTargetSchoolYearId();

  onProgress?.(
    `Writing ${rowsParsed} parsed LAMS attendee row(s) into manual attendance`,
  );
  const transactionResult = await withTransaction(async (client) => {
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
      const existingStudents = await hydrateExistingStudents(client, mergedRows);
      const hydratedRows = hydrateRowsWithStudents(mergedRows, existingStudents);

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
      "Refreshing final attendance and penalty results after LAMS manual-attendance changes",
    );
    await refreshAttendanceFinalResults({ schoolYearId });
  } else {
    onProgress?.(
      "LAMS manual attendance is unchanged; final attendance and penalty results do not need refreshing",
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
  seedLamsFrcManualAttendees()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? "LAMS FRC manual attendance is already seeded."
          : `Created ${result.manualAttendanceRecordsCreated} LAMS FRC manual attendance record(s) and ${result.eventsCreated} event(s).`,
      );
      if (result.unresolvedAttendees.length > 0) {
        console.warn(
          `Could not safely resolve ${result.unresolvedAttendees.length} attendee(s): ${result.unresolvedAttendees.join(", ")}`,
        );
      }
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("LAMS FRC manual-attendance seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}
