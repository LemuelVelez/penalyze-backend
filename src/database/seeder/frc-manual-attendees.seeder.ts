import "dotenv/config";

import fs from "fs";
import path from "path";
import type { PoolClient } from "pg";

import { query, withTransaction } from "../../lib/db";
import {
  deleteAttendanceImportsByIds,
  refreshAttendanceFinalResults,
} from "../../services/attendance.service";

const TARGET_SCHOOL_YEAR = "2026-2027";
const TARGET_SEMESTER = "first_semester";
const TARGET_EVENT_NAME = "Flag Raising Ceremony";
const TARGET_EVENT_DATE = "2026-09-01";
const PLACEHOLDER_STUDENT_ID = "TC-20-A-00000";
const DEFAULT_COLLEGE = "College of Computing Studies";
const DEFAULT_INSTITUTION =
  "Jose Rizal Memorial State University - Tampilisan Campus";
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;

const DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "september-01-frc",
);

const SCANNER_FILES = [
  "FRC ATTENDANCE (BSCS) SEPTEMBER 1, 2026.csv",
  "FRC ATTENDANCE (BSIS) Sep,1 2026.csv",
] as const;
const NO_QR_FILE = "no QR during flag raising.txt";
const LEGACY_IMPORT_FILE_NAMES = [...SCANNER_FILES, NO_QR_FILE] as const;

type AttendeeSource = "scanner" | "no_qr";

type ManualAttendee = {
  studentId: string;
  name: string;
  yearLevel: string;
  college: string;
  program: string;
  institution: string;
  scannedAt: string | null;
  source: AttendeeSource;
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

export type SeedFrcManualAttendeesResult = {
  alreadySeeded: boolean;
  scannerRowsParsed: number;
  noQrRowsParsed: number;
  manualAttendanceRecordsCreated: number;
  legacyImportsSoftDeleted: number;
  unresolvedAttendees: string[];
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeStudentId(value: unknown) {
  return clean(value).toUpperCase();
}

function normalizeName(value: unknown) {
  return clean(value).replace(/\s+/g, " ").toLowerCase();
}

function getFixturePath(fileName: string) {
  return path.join(DATA_DIRECTORY, fileName);
}

function assertFixtureFilesExist() {
  const requiredFiles = [...SCANNER_FILES, NO_QR_FILE];
  const missingFiles = requiredFiles.filter(
    (fileName) => !fs.existsSync(getFixturePath(fileName)),
  );

  if (missingFiles.length) {
    throw new Error(
      `Missing FRC manual-attendance fixture file(s): ${missingFiles.join(", ")}`,
    );
  }
}

function parseTimestamp(value: string) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const date = new Date(numeric >= 100_000_000_000 ? numeric : numeric * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getManilaDateKey(timestamp: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() + MANILA_OFFSET_MS).toISOString().slice(0, 10);
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

  const studentId = normalizeStudentId(fields.get("student id"));
  const name = clean(fields.get("name"));
  if (!studentId || !name) return null;

  return {
    studentId,
    name,
    yearLevel: clean(fields.get("year level")),
    college: clean(fields.get("college")),
    program: clean(fields.get("program")),
    institution: clean(fields.get("institution")),
  };
}

function parseJsonPayload(payload: string) {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const studentId = normalizeStudentId(parsed.studentId);
    const name = clean(parsed.name);
    if (!studentId || !name) return null;

    return {
      studentId,
      name,
      yearLevel: clean(parsed.yearLevel),
      college: DEFAULT_COLLEGE,
      program: clean(parsed.degreeProgram),
      institution: DEFAULT_INSTITUTION,
    };
  } catch {
    return null;
  }
}

function parseScannerFile(fileName: string): ManualAttendee[] {
  const contents = fs.readFileSync(getFixturePath(fileName), "utf8").replace(/^\uFEFF/, "");
  const records = contents.split(/\r?\n(?=")/).slice(1);
  const marker = '\",\"QR_CODE\",\"';
  const attendees: ManualAttendee[] = [];

  records.forEach((record) => {
    const markerIndex = record.lastIndexOf(marker);
    if (markerIndex < 0) return;

    const payload = (record.startsWith('"') ? record.slice(1, markerIndex) : record.slice(0, markerIndex))
      .replace(/\r/g, "")
      .trim();
    const tail = record.slice(markerIndex + marker.length);
    const tailParts = tail.split('\",\"');
    const scanDate = clean(tailParts[0]);
    const type = clean(tailParts[1]).toUpperCase();
    if (type !== "TEXT") return;

    const parsed = payload.startsWith("{")
      ? parseJsonPayload(payload)
      : parseLabelPayload(payload);
    if (!parsed) return;

    attendees.push({
      ...parsed,
      scannedAt: parseTimestamp(scanDate),
      source: "scanner",
    });
  });

  return attendees;
}

function parseNoQrFile(): ManualAttendee[] {
  const contents = fs.readFileSync(getFixturePath(NO_QR_FILE), "utf8");

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const numberedLine = line.match(/^\d+\.\s*(.+)$/);
      if (!numberedLine) return null;

      const attendee = numberedLine[1].trim();
      const studentIdMatch = attendee.match(/\b(TC-[A-Z0-9-]+)\s*$/i);
      const studentId = studentIdMatch
        ? normalizeStudentId(studentIdMatch[1])
        : "";
      const name = clean(
        studentIdMatch
          ? attendee.slice(0, studentIdMatch.index)
          : attendee,
      );
      if (!name) return null;

      return {
        studentId,
        name,
        yearLevel: "",
        college: "",
        program: "",
        institution: "",
        scannedAt: null,
        source: "no_qr" as const,
      };
    })
    .filter((row): row is ManualAttendee => Boolean(row));
}

function getEventBounds(scannerRows: ManualAttendee[]) {
  const targetTimes = scannerRows
    .map((row) => row.scannedAt)
    .filter((value): value is string => Boolean(value))
    .filter((value) => getManilaDateKey(value) === TARGET_EVENT_DATE)
    .map((value) => new Date(value))
    .filter((value) => !Number.isNaN(value.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());

  return {
    startAt: targetTimes[0]?.toISOString() ?? null,
    endAt: targetTimes[targetTimes.length - 1]?.toISOString() ?? null,
  };
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
      `School year ${TARGET_SCHOOL_YEAR} / ${TARGET_SEMESTER} must exist before seeding September 1 FRC manual attendance.`,
    );
  }

  return schoolYearId;
}

async function getOrCreateTargetEvent(
  schoolYearId: string,
  scannerRows: ManualAttendee[],
): Promise<TargetEvent> {
  return withTransaction(async (client) => {
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
      [schoolYearId, TARGET_EVENT_NAME, TARGET_EVENT_DATE],
    );

    if (existing.rows[0]) return existing.rows[0];

    const bounds = getEventBounds(scannerRows);
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
        TARGET_EVENT_DATE,
        bounds.startAt,
        bounds.endAt,
        "Seeded manual attendance event for the September 1, 2026 Flag Raising Ceremony.",
      ],
    );

    return created.rows[0];
  });
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

function mergeAttendeeRows(rows: ManualAttendee[]) {
  const merged = new Map<string, ManualAttendee>();

  rows.forEach((row) => {
    const key = normalizeStudentId(row.studentId);
    if (!key) return;

    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row, studentId: key });
      return;
    }

    const existingTime = existing.scannedAt
      ? new Date(existing.scannedAt).getTime()
      : 0;
    const rowTime = row.scannedAt ? new Date(row.scannedAt).getTime() : 0;
    const newer = rowTime >= existingTime ? row : existing;
    const older = newer === row ? existing : row;

    merged.set(key, {
      studentId: key,
      name: clean(newer.name) || clean(older.name),
      yearLevel: clean(newer.yearLevel) || clean(older.yearLevel),
      college: clean(newer.college) || clean(older.college),
      program: clean(newer.program) || clean(older.program),
      institution: clean(newer.institution) || clean(older.institution),
      scannedAt: newer.scannedAt ?? older.scannedAt,
      source:
        existing.source === "scanner" || row.source === "scanner"
          ? "scanner"
          : "no_qr",
    });
  });

  return Array.from(merged.values());
}

async function upsertStudent(client: PoolClient, row: ManualAttendee) {
  const params = [
    row.studentId,
    row.name,
    row.yearLevel,
    row.college,
    row.program,
    row.institution,
  ];
  const updated = await client.query(
    `
      UPDATE students
      SET
        name = $2,
        year_level = COALESCE(NULLIF($3, ''), year_level),
        college = COALESCE(NULLIF($4, ''), college),
        program = COALESCE(NULLIF($5, ''), program),
        institution = COALESCE(NULLIF($6, ''), institution),
        updated_at = NOW()
      WHERE LOWER(TRIM(student_id)) = LOWER(TRIM($1))
    `,
    params,
  );

  if (updated.rowCount) return;

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
    params,
  );
}

async function seedManualAttendanceRows(
  schoolYearId: string,
  eventId: string,
  sourceRows: ManualAttendee[],
) {
  return withTransaction(async (client) => {
    const unresolvedAttendees: string[] = [];
    const resolvedRows: ManualAttendee[] = [];

    for (const sourceRow of sourceRows) {
      const currentStudentId = normalizeStudentId(sourceRow.studentId);
      const needsNameResolution =
        !currentStudentId || currentStudentId === PLACEHOLDER_STUDENT_ID;

      if (!needsNameResolution) {
        resolvedRows.push({ ...sourceRow, studentId: currentStudentId });
        continue;
      }

      const resolvedStudent = await resolveStudentByExactName(
        client,
        sourceRow.name,
      );
      if (!resolvedStudent) {
        unresolvedAttendees.push(
          `${sourceRow.name}${currentStudentId ? ` (${currentStudentId})` : ""}`,
        );
        continue;
      }

      resolvedRows.push({
        ...sourceRow,
        studentId: normalizeStudentId(resolvedStudent.student_id),
        name: clean(resolvedStudent.name) || sourceRow.name,
        yearLevel: sourceRow.yearLevel || clean(resolvedStudent.year_level),
        college: sourceRow.college || clean(resolvedStudent.college),
        program: sourceRow.program || clean(resolvedStudent.program),
        institution:
          sourceRow.institution || clean(resolvedStudent.institution),
      });
    }

    const mergedRows = mergeAttendeeRows(resolvedRows);
    const existingStudents = await hydrateExistingStudents(client, mergedRows);
    const hydratedRows = mergedRows.map((row) => {
      const existingStudent = existingStudents.get(row.studentId);
      if (!existingStudent) return row;

      return {
        ...row,
        name: clean(row.name) || clean(existingStudent.name),
        yearLevel: clean(row.yearLevel) || clean(existingStudent.year_level),
        college: clean(row.college) || clean(existingStudent.college),
        program: clean(row.program) || clean(existingStudent.program),
        institution:
          clean(row.institution) || clean(existingStudent.institution),
      };
    });

    let createdCount = 0;

    for (const row of hydratedRows) {
      await upsertStudent(client, row);

      const remarks =
        row.source === "no_qr"
          ? "Seeded as manual attendance from the September 1, 2026 FRC no-QR attendee list."
          : "Seeded as manual attendance from the September 1, 2026 FRC scanner attendee list.";

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
            NULLIF($6, ''),
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
          row.college,
          row.program,
          row.institution,
          remarks,
          row.scannedAt,
        ],
      );

      createdCount += inserted.rowCount ?? 0;
    }

    return {
      createdCount,
      unresolvedAttendees,
    };
  });
}

async function getLegacySeedImportIds(schoolYearId: string) {
  const result = await query<{ id: string }>(
    `
      SELECT id
      FROM attendance_imports
      WHERE school_year_id = $1
        AND deleted_at IS NULL
        AND uploaded_by IS NULL
        AND LOWER(TRIM(file_name)) = ANY($2::text[])
      ORDER BY created_at ASC
    `,
    [
      schoolYearId,
      LEGACY_IMPORT_FILE_NAMES.map((fileName) => fileName.toLowerCase()),
    ],
  );

  return result.rows.map((row) => row.id);
}

export async function seedFrcManualAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedFrcManualAttendeesResult> {
  onProgress?.("Verifying bundled September 1 FRC manual-attendance fixtures");
  assertFixtureFilesExist();

  onProgress?.("Parsing QR scanner CSVs without creating attendance imports");
  const scannerRows = SCANNER_FILES.flatMap(parseScannerFile);
  const noQrRows = parseNoQrFile();

  onProgress?.("Resolving SY 2026-2027 / First Semester and the September 1 FRC event");
  const schoolYearId = await getTargetSchoolYearId();
  const event = await getOrCreateTargetEvent(schoolYearId, scannerRows);

  onProgress?.(
    `Writing ${scannerRows.length + noQrRows.length} source attendee row(s) into manual attendance`,
  );
  const manualSeed = await seedManualAttendanceRows(
    schoolYearId,
    event.id,
    [...scannerRows, ...noQrRows],
  );

  onProgress?.("Removing active legacy seed-created imports for these same fixture files");
  const legacyImportIds = await getLegacySeedImportIds(schoolYearId);
  const legacyCleanup = legacyImportIds.length
    ? await deleteAttendanceImportsByIds(
        legacyImportIds,
        undefined,
        "Reclassified September 1 FRC seed fixtures as manual attendance.",
      )
    : { deletedCount: 0, deletedImports: [] };

  if (manualSeed.createdCount > 0 || legacyCleanup.deletedCount > 0) {
    onProgress?.("Refreshing final attendance and penalty results after manual-attendance seed changes");
    await refreshAttendanceFinalResults({ schoolYearId });
  }

  const alreadySeeded =
    manualSeed.createdCount === 0 &&
    legacyCleanup.deletedCount === 0 &&
    manualSeed.unresolvedAttendees.length === 0;

  return {
    alreadySeeded,
    scannerRowsParsed: scannerRows.length,
    noQrRowsParsed: noQrRows.length,
    manualAttendanceRecordsCreated: manualSeed.createdCount,
    legacyImportsSoftDeleted: legacyCleanup.deletedCount,
    unresolvedAttendees: manualSeed.unresolvedAttendees,
  };
}
