import path from "path";
import { PoolClient } from "pg";

import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceEventRecord,
  AttendanceImportProgress,
  AttendanceImportRecord,
  AttendancePreviewResult,
  AttendanceRecord,
  FineRecord,
  ParsedAttendanceRow,
  SavedAttendanceImportResult,
} from "../database/model/schema.model";
import { query, withTransaction } from "../lib/db";

declare const require: any;

export type UploadedAttendanceFile = {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
  size?: number;
};

type RawImportRow = Record<string, unknown>;

type SaveRowsInput = {
  eventId?: string;
  eventName?: string;
  eventStartAt?: string;
  eventEndAt?: string;
  eventDate?: string;
  eventDescription?: string;
  resumeImportId?: string;
  fileName?: string;
  fileType?: string;
  rows: RawImportRow[] | ParsedAttendanceRow[];
  onProgress?: AttendanceImportProgressCallback;
  isCancelled?: () => boolean;
};

type AttendanceImportProgressCallback = (
  progress: AttendanceImportProgress,
) => void | Promise<void>;

export type DeletedAttendanceImportsResult = {
  deletedCount: number;
  deletedImports: AttendanceImportRecord[];
};

export type AttendanceEventInput = {
  name?: string;
  eventName?: string;
  eventStartAt?: string;
  event_start_at?: string;
  eventEndAt?: string;
  event_end_at?: string;
  eventDate?: string;
  event_date?: string;
  description?: string;
  eventDescription?: string;
};

function clampAttendanceProgressPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function assertAttendanceImportNotCancelled(
  input: Pick<SaveRowsInput, "isCancelled">,
) {
  if (!input.isCancelled?.()) return;

  throw createValidationError("Attendance import was cancelled.", 499);
}

async function emitAttendanceImportProgress(
  onProgress: AttendanceImportProgressCallback | undefined,
  progress: Partial<AttendanceImportProgress> &
    Pick<AttendanceImportProgress, "stage" | "message">,
) {
  if (!onProgress) return;

  await onProgress({
    stage: progress.stage,
    percent: clampAttendanceProgressPercent(progress.percent ?? 0),
    message: progress.message,
    processedRows: Math.max(0, Math.round(progress.processedRows ?? 0)),
    totalRows: Math.max(0, Math.round(progress.totalRows ?? 0)),
    savedRecords: Math.max(0, Math.round(progress.savedRecords ?? 0)),
    createdFines: Math.max(0, Math.round(progress.createdFines ?? 0)),
  });
}

function getAttendanceRowSaveProgressPercent(
  processedRows: number,
  totalRows: number,
) {
  if (totalRows <= 0) return 85;
  return 25 + (processedRows / totalRows) * 60;
}

const HEADER_ALIASES = {
  eventName: [
    "event",
    "event name",
    "event_name",
    "activity",
    "activity name",
    "occasion",
  ],
  eventStartAt: [
    "event start at",
    "event_start_at",
    "event start",
    "event_start",
    "start at",
    "start date",
    "start time",
    "started at",
  ],
  eventEndAt: [
    "event end at",
    "event_end_at",
    "event end",
    "event_end",
    "end at",
    "end date",
    "end time",
    "ended at",
  ],
  scannedAt: [
    "scanned at",
    "scanned_at",
    "scan time",
    "scan date",
    "date scanned",
    "time scanned",
    "timestamp",
  ],
  studentId: [
    "studentid",
    "student id",
    "student_id",
    "student no",
    "student no.",
    "id number",
    "id",
    "school id",
  ],
  name: ["name", "full name", "student name", "learner name"],
  yearLevel: [
    "yearlevel",
    "year level",
    "year_level",
    "grade",
    "grade level",
    "level",
  ],
  college: ["college", "department"],
  program: ["program", "course", "strand"],
  institution: ["institution", "school", "campus"],
  noOfAbsences: [
    "noofabsences",
    "no of absences",
    "no. of absences",
    "number of absences",
    "absences",
    "absence",
    "total absences",
  ],
  remarks: ["remarks", "remark", "notes", "note", "comment", "comments"],
} as const;

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_]+/g, " ")
    .replace(/[^a-z0-9. ]+/g, "")
    .trim();
}

function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

const ATTENDANCE_RECORD_SELECT = `
  ar.id,
  ar.import_id,
  ar.event_id,
  ae.name AS event_name,
  COALESCE(NULLIF(TRIM(s.student_id), ''), ar.student_id) AS student_id,
  COALESCE(NULLIF(TRIM(s.name), ''), ar.name) AS name,
  COALESCE(NULLIF(TRIM(s.year_level), ''), ar.year_level) AS year_level,
  COALESCE(NULLIF(TRIM(s.college), ''), ar.college) AS college,
  COALESCE(NULLIF(TRIM(s.program), ''), ar.program) AS program,
  COALESCE(NULLIF(TRIM(s.institution), ''), ar.institution) AS institution,
  ar.no_of_absences,
  ar.remarks,
  ar.scanned_at,
  ar.created_at,
  ar.updated_at
`;

function isNumericDateCandidate(value: string) {
  return /^\d+(?:\.\d+)?$/.test(value.trim());
}

function parseExcelSerialDate(value: string) {
  const serial = Number(value);
  if (!Number.isFinite(serial) || serial <= 0 || serial > 100000) return null;

  const wholeDays = Math.floor(serial);
  const timeFraction = serial - wholeDays;
  const milliseconds = Math.round(
    (wholeDays - 25569) * 86400000 + timeFraction * 86400000,
  );
  const date = new Date(milliseconds);

  return Number.isNaN(date.getTime()) ? null : date;
}

function getFileExtension(fileName: string) {
  return path.extname(fileName || "").toLowerCase();
}

function ensureSupportedFile(fileName: string) {
  const extension = getFileExtension(fileName);

  if (!ACCEPTED_ATTENDANCE_EXTENSIONS.includes(extension as any)) {
    throw new Error(
      `Unsupported file type. Accepted files: ${ACCEPTED_ATTENDANCE_EXTENSIONS.join(", ")}`,
    );
  }

  return extension;
}

function loadRequiredModule<T = any>(packageName: string): T {
  try {
    return require(packageName) as T;
  } catch {
    throw new Error(
      `Missing dependency "${packageName}". Please install it before using this file reader.`,
    );
  }
}

function parseDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === delimiter && !quoted) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function scoreDelimiter(line: string, delimiter: string) {
  return parseDelimitedLine(line, delimiter).length;
}

function detectDelimiter(line: string) {
  const delimiters = [",", "\t", ";", "|"];
  return delimiters
    .map((delimiter) => ({ delimiter, score: scoreDelimiter(line, delimiter) }))
    .sort((a, b) => b.score - a.score)[0].delimiter;
}

function textToRows(text: string) {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) return [];

  const delimiter = detectDelimiter(lines[0]);
  const headerCells = parseDelimitedLine(lines[0], delimiter);
  const normalizedHeaders = headerCells.map(normalizeHeader);
  const hasNamedHeaders =
    normalizedHeaders.some((header) =>
      HEADER_ALIASES.studentId.includes(header as any),
    ) &&
    normalizedHeaders.some((header) =>
      HEADER_ALIASES.name.includes(header as any),
    );

  if (!hasNamedHeaders) {
    return lines.map((line) => {
      const cells = parseDelimitedLine(line, delimiter);
      return {
        studentId: cells[0] ?? "",
        name: cells[1] ?? "",
        yearLevel: cells[2] ?? "",
        college: cells[3] ?? "",
        program: cells[4] ?? "",
        institution: cells[5] ?? "",
        noOfAbsences: cells[6] ?? "",
        remarks: cells.slice(7).join(" "),
      };
    });
  }

  return lines.slice(1).map((line) => {
    const cells = parseDelimitedLine(line, delimiter);
    return headerCells.reduce<RawImportRow>((row, header, index) => {
      row[header] = cells[index] ?? "";
      return row;
    }, {});
  });
}

function getByAliases(row: RawImportRow, aliases: readonly string[]) {
  const entries = Object.entries(row ?? {});

  for (const [key, value] of entries) {
    const normalizedKey = normalizeHeader(key);
    if (aliases.includes(normalizedKey as any)) return value;
  }

  return "";
}

function parseOptionalAbsences(value: unknown) {
  const text = cleanText(value).toLowerCase();
  if (!text) return 0;

  const normalizedText = text.replace(/,/g, "").replace(/\s+/g, " ").trim();
  const rangedAbsenceMatch = normalizedText.match(
    /^(\d+)\s*(?:absences?\s*)?(?:\+|plus|or more(?: absences?)?|and above(?: absences?)?|or above(?: absences?)?|and up(?: absences?)?|or higher(?: absences?)?|and higher(?: absences?)?)$/,
  );

  if (rangedAbsenceMatch) {
    const rangedValue = Number(rangedAbsenceMatch[1]);
    return Number.isInteger(rangedValue) && rangedValue >= 0
      ? rangedValue
      : null;
  }

  const parsed = Number(normalizedText);
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed))
    return null;

  return parsed;
}

function normalizeImportRows(
  rows: RawImportRow[] | ParsedAttendanceRow[],
): ParsedAttendanceRow[] {
  return rows.map((inputRow, index) => {
    const raw = (inputRow as ParsedAttendanceRow).raw ?? inputRow;
    const rowNumber = Number(
      (inputRow as ParsedAttendanceRow).rowNumber ?? index + 2,
    );

    const eventName = cleanText(
      (inputRow as ParsedAttendanceRow).eventName ??
        getByAliases(raw, HEADER_ALIASES.eventName),
    );
    const eventStartAtInput =
      (inputRow as ParsedAttendanceRow).eventStartAt ??
      getByAliases(raw, HEADER_ALIASES.eventStartAt);
    const eventEndAtInput =
      (inputRow as ParsedAttendanceRow).eventEndAt ??
      getByAliases(raw, HEADER_ALIASES.eventEndAt);
    const scannedAtInput =
      (inputRow as ParsedAttendanceRow).scannedAt ??
      getByAliases(raw, HEADER_ALIASES.scannedAt);
    const studentId = cleanText(
      (inputRow as ParsedAttendanceRow).studentId ??
        getByAliases(raw, HEADER_ALIASES.studentId),
    );
    const name = cleanText(
      (inputRow as ParsedAttendanceRow).name ??
        getByAliases(raw, HEADER_ALIASES.name),
    );
    const yearLevel = cleanText(
      (inputRow as ParsedAttendanceRow).yearLevel ??
        getByAliases(raw, HEADER_ALIASES.yearLevel),
    );
    const college = cleanText(
      (inputRow as ParsedAttendanceRow).college ??
        getByAliases(raw, HEADER_ALIASES.college),
    );
    const program = cleanText(
      (inputRow as ParsedAttendanceRow).program ??
        getByAliases(raw, HEADER_ALIASES.program),
    );
    const institution = cleanText(
      (inputRow as ParsedAttendanceRow).institution ??
        getByAliases(raw, HEADER_ALIASES.institution),
    );
    const remarks = cleanText(
      (inputRow as ParsedAttendanceRow).remarks ??
        getByAliases(raw, HEADER_ALIASES.remarks),
    );
    const absencesInput =
      (inputRow as ParsedAttendanceRow).noOfAbsences ??
      getByAliases(raw, HEADER_ALIASES.noOfAbsences);
    const noOfAbsences = parseOptionalAbsences(absencesInput);
    const eventStartAt = normalizeOptionalTimestamp(
      eventStartAtInput,
      "Event start at",
    );
    const eventEndAt = normalizeOptionalTimestamp(
      eventEndAtInput,
      "Event end at",
    );
    const scannedAt = normalizeOptionalTimestamp(scannedAtInput, "Scanned at");

    const errors: string[] = [];
    if (!studentId) errors.push("Student ID is required.");
    if (!name) errors.push("Name is required.");
    if (noOfAbsences === null)
      errors.push("No. of Absences must be a whole number.");
    if (eventStartAt.error) errors.push(eventStartAt.error);
    if (eventEndAt.error) errors.push(eventEndAt.error);
    if (scannedAt.error) errors.push(scannedAt.error);
    if (
      eventStartAt.value &&
      eventEndAt.value &&
      new Date(eventEndAt.value).getTime() <
        new Date(eventStartAt.value).getTime()
    ) {
      errors.push("Event end at must be after event start at.");
    }

    return {
      rowNumber,
      eventName,
      eventStartAt: eventStartAt.value ?? undefined,
      eventEndAt: eventEndAt.value ?? undefined,
      scannedAt: scannedAt.value ?? undefined,
      studentId,
      name,
      yearLevel,
      college,
      program,
      institution,
      noOfAbsences: noOfAbsences ?? 0,
      remarks,
      errors,
      raw,
    };
  });
}

function buildPreview(
  fileName: string,
  fileType: string,
  rawRows: RawImportRow[] | ParsedAttendanceRow[],
): AttendancePreviewResult {
  const rows = normalizeImportRows(rawRows);
  const rowsValid = rows.filter((row) => row.errors.length === 0).length;
  const rowsInvalid = rows.length - rowsValid;

  return {
    fileName,
    fileType,
    rowsTotal: rows.length,
    rowsValid,
    rowsInvalid,
    rows,
  };
}

async function parseExcelFile(file: UploadedAttendanceFile) {
  const XLSX = loadRequiredModule<any>("xlsx");
  const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
  const firstSheetName = workbook.SheetNames?.[0];

  if (!firstSheetName) return [];

  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(worksheet, {
    defval: "",
    raw: false,
  }) as RawImportRow[];
}

async function parseDocxFile(file: UploadedAttendanceFile) {
  const mammoth = loadRequiredModule<any>("mammoth");
  const result = await mammoth.extractRawText({ buffer: file.buffer });
  return textToRows(result.value ?? "");
}

function parseLegacyDocFallback(file: UploadedAttendanceFile) {
  const text = file.buffer
    .toString("utf8")
    .replace(/[\x00-\x08\x0E-\x1F]+/g, " ")
    .replace(/\s{2,}/g, " ");

  return textToRows(text);
}

async function parseFileToRawRows(file: UploadedAttendanceFile) {
  const extension = ensureSupportedFile(file.originalname);

  if (extension === ".xlsx" || extension === ".xls") {
    return parseExcelFile(file);
  }

  if (extension === ".docx") {
    return parseDocxFile(file);
  }

  if (extension === ".doc") {
    return parseLegacyDocFallback(file);
  }

  return textToRows(file.buffer.toString("utf8"));
}

function getParsedAttendanceRowTime(row: ParsedAttendanceRow) {
  const value = row.scannedAt;
  const time = value ? new Date(value).getTime() : 0;

  return Number.isNaN(time) ? 0 : time;
}

function getAttendanceRowMergeKey(
  row: ParsedAttendanceRow,
  input: SaveRowsInput,
) {
  const eventKey =
    cleanText(row.eventName) ||
    cleanText(input.eventId) ||
    cleanText(input.eventName) ||
    "no-event";
  return `${normalizeHeader(eventKey)}:${cleanText(row.studentId).toLowerCase()}`;
}

function mergeAttendanceImportRowsByStudentAndEvent(
  rows: ParsedAttendanceRow[],
  input: SaveRowsInput,
) {
  const mergedRows = new Map<string, ParsedAttendanceRow>();

  rows.forEach((row) => {
    const key = getAttendanceRowMergeKey(row, input);
    const current = mergedRows.get(key);

    if (!current) {
      mergedRows.set(key, { ...row });
      return;
    }

    const currentTime = getParsedAttendanceRowTime(current);
    const rowTime = getParsedAttendanceRowTime(row);
    const latestRow = rowTime >= currentTime ? row : current;
    const oldestRow = latestRow === row ? current : row;
    const remarks = Array.from(
      new Set([current.remarks, row.remarks].map(cleanText).filter(Boolean)),
    ).join("; ");

    mergedRows.set(key, {
      ...current,
      eventName:
        latestRow.eventName || oldestRow.eventName || current.eventName,
      eventStartAt: latestRow.eventStartAt || oldestRow.eventStartAt,
      eventEndAt: latestRow.eventEndAt || oldestRow.eventEndAt,
      scannedAt: latestRow.scannedAt || oldestRow.scannedAt,
      studentId: latestRow.studentId || oldestRow.studentId,
      name: latestRow.name || oldestRow.name,
      yearLevel: latestRow.yearLevel || oldestRow.yearLevel,
      college: latestRow.college || oldestRow.college,
      program: latestRow.program || oldestRow.program,
      institution: latestRow.institution || oldestRow.institution,
      noOfAbsences: Math.max(current.noOfAbsences ?? 0, row.noOfAbsences ?? 0),
      remarks,
      raw: { ...current.raw, ...row.raw },
      errors: [],
    });
  });

  return Array.from(mergedRows.values());
}

function createValidationError(message: string, statusCode = 400) {
  const error = new Error(message);
  (error as any).statusCode = statusCode;
  return error;
}

function normalizeOptionalTimestamp(value: unknown, label = "Date and time") {
  const text = cleanText(value);
  if (!text) return { value: null as string | null, error: "" };

  const serialDate = isNumericDateCandidate(text)
    ? parseExcelSerialDate(text)
    : null;
  const date = serialDate ?? new Date(text);

  if (Number.isNaN(date.getTime())) {
    return {
      value: null as string | null,
      error: `${label} must be a valid date and time.`,
    };
  }

  return { value: date.toISOString(), error: "" };
}

function getEventInput(
  input: AttendanceEventInput | SaveRowsInput | RawImportRow,
) {
  const eventStartAt = normalizeOptionalTimestamp(
    (input as AttendanceEventInput).eventStartAt ??
      (input as AttendanceEventInput).event_start_at ??
      (input as AttendanceEventInput).eventDate ??
      (input as AttendanceEventInput).event_date,
    "Event start at",
  );
  const eventEndAt = normalizeOptionalTimestamp(
    (input as AttendanceEventInput).eventEndAt ??
      (input as AttendanceEventInput).event_end_at,
    "Event end at",
  );

  if (eventStartAt.error) throw createValidationError(eventStartAt.error);
  if (eventEndAt.error) throw createValidationError(eventEndAt.error);
  if (
    eventStartAt.value &&
    eventEndAt.value &&
    new Date(eventEndAt.value).getTime() <
      new Date(eventStartAt.value).getTime()
  ) {
    throw createValidationError("Event end at must be after event start at.");
  }

  return {
    id: cleanText((input as SaveRowsInput).eventId),
    name: cleanText(
      (input as AttendanceEventInput).name ||
        (input as AttendanceEventInput).eventName,
    ),
    eventStartAt: eventStartAt.value,
    eventEndAt: eventEndAt.value,
    description: cleanOptionalText(
      (input as AttendanceEventInput).description ??
        (input as AttendanceEventInput).eventDescription,
    ),
  };
}

async function getAttendanceEventById(client: PoolClient, id: string) {
  const result = await client.query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      WHERE e.id = $1
      GROUP BY e.id
      LIMIT 1
    `,
    [id],
  );

  return result.rows[0] ?? null;
}

async function findOrCreateAttendanceEvent(
  client: PoolClient,
  input: AttendanceEventInput | SaveRowsInput | RawImportRow,
  fallbackName = "",
) {
  const eventInput = getEventInput(input);

  if (eventInput.id) {
    const event = await getAttendanceEventById(client, eventInput.id);
    if (!event) throw createValidationError("Attendance event not found.", 404);
    return event;
  }

  const name = eventInput.name || cleanText(fallbackName);
  if (!name) return null;

  const existingResult = await client.query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      WHERE LOWER(TRIM(e.name)) = LOWER(TRIM($1))
      GROUP BY e.id
      ORDER BY e.created_at DESC
      LIMIT 1
    `,
    [name],
  );

  if (existingResult.rows[0]) return existingResult.rows[0];

  const createdResult = await client.query<AttendanceEventRecord>(
    `
      INSERT INTO attendance_events (name, event_start_at, event_end_at, description)
      VALUES ($1, $2, $3, $4)
      RETURNING *, 0::INT AS attendees_count
    `,
    [
      name,
      eventInput.eventStartAt,
      eventInput.eventEndAt,
      eventInput.description,
    ],
  );

  return createdResult.rows[0];
}

async function upsertStudent(client: PoolClient, row: ParsedAttendanceRow) {
  await client.query(
    `
      INSERT INTO students (student_id, name, year_level, college, program, institution)
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
      row.studentId,
      row.name,
      row.yearLevel ?? "",
      row.college ?? "",
      row.program ?? "",
      row.institution ?? "",
    ],
  );
}

async function insertAttendanceRecord(
  client: PoolClient,
  importId: string | null,
  eventId: string | null,
  row: ParsedAttendanceRow,
) {
  const result = await client.query<AttendanceRecord>(
    `
      INSERT INTO attendance_records (
        import_id,
        event_id,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        no_of_absences,
        scanned_at,
        remarks
      )
      VALUES ($1, $2, $3, $4, NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), $9, $10::TIMESTAMPTZ, NULLIF($11, ''))
      RETURNING *
    `,
    [
      importId,
      eventId,
      row.studentId,
      row.name,
      row.yearLevel ?? "",
      row.college ?? "",
      row.program ?? "",
      row.institution ?? "",
      row.noOfAbsences ?? 0,
      row.scannedAt ?? null,
      row.remarks ?? "",
    ],
  );

  return result.rows[0];
}

function validateAttendanceInput(input: RawImportRow) {
  const preview = buildPreview("manual-attendance", "manual", [input]);
  const row = preview.rows[0];

  if (!row || row.errors.length > 0) {
    throw createValidationError(
      row?.errors.join(" ") || "Please provide a valid attendance record.",
    );
  }

  return row;
}

async function findMatchingPenalty(client: PoolClient, noOfAbsences: number) {
  const penaltyResult = await client.query(
    `
      SELECT *
      FROM penalties
      WHERE no_of_absences <= $1
      ORDER BY no_of_absences DESC
      LIMIT 1
    `,
    [noOfAbsences],
  );

  return penaltyResult.rows[0] ?? null;
}

async function syncFineForAttendanceRecord(
  client: PoolClient,
  record: AttendanceRecord,
) {
  if (!record.no_of_absences || record.no_of_absences <= 0) {
    await client.query("DELETE FROM fines WHERE attendance_record_id = $1", [
      record.id,
    ]);
    return null;
  }

  const penalty = await findMatchingPenalty(client, record.no_of_absences);
  const penaltyText =
    penalty?.prescribed_penalty ?? "No prescribed penalty configured.";

  const existingFineResult = await client.query<FineRecord>(
    "SELECT * FROM fines WHERE attendance_record_id = $1 LIMIT 1",
    [record.id],
  );
  const existingFine = existingFineResult.rows[0];

  if (existingFine) {
    const fineResult = await client.query<FineRecord>(
      `
        UPDATE fines
        SET
          penalty_id = $2,
          student_id = $3,
          name = $4,
          no_of_absences = $5,
          prescribed_penalty = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        existingFine.id,
        penalty?.id ?? null,
        record.student_id,
        record.name,
        record.no_of_absences,
        penaltyText,
      ],
    );

    return fineResult.rows[0];
  }

  const fineResult = await client.query<FineRecord>(
    `
      INSERT INTO fines (
        attendance_record_id,
        penalty_id,
        student_id,
        name,
        no_of_absences,
        prescribed_penalty,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid')
      RETURNING *
    `,
    [
      record.id,
      penalty?.id ?? null,
      record.student_id,
      record.name,
      record.no_of_absences,
      penaltyText,
    ],
  );

  return fineResult.rows[0];
}

async function insertFineIfNeeded(
  client: PoolClient,
  record: AttendanceRecord,
) {
  return syncFineForAttendanceRecord(client, record);
}

type AttendanceStudentScope = {
  student_id: string;
};

async function getAttendanceStudentScopes(
  client: PoolClient,
  studentIds: string[] = [],
) {
  const uniqueStudentIds = Array.from(
    new Set(
      studentIds
        .map((studentId) => cleanText(studentId).toLowerCase())
        .filter(Boolean),
    ),
  );
  const params: unknown[] = [];
  const clauses = ["event_id IS NOT NULL"];

  if (uniqueStudentIds.length) {
    params.push(uniqueStudentIds);
    clauses.push(`LOWER(TRIM(student_id)) = ANY($${params.length}::TEXT[])`);
  }

  const result = await client.query<AttendanceStudentScope>(
    `
      SELECT DISTINCT student_id
      FROM attendance_records
      WHERE ${clauses.join(" AND ")}
    `,
    params,
  );

  return result.rows;
}

async function countAttendanceEvents(client: PoolClient) {
  const result = await client.query<{ total: string }>(
    `
      SELECT COUNT(DISTINCT event_id)::TEXT AS total
      FROM attendance_records
      WHERE event_id IS NOT NULL
    `,
  );

  return Number(result.rows[0]?.total ?? 0);
}

async function countStudentAttendanceEvents(
  client: PoolClient,
  studentId: string,
) {
  const result = await client.query<{ total: string }>(
    `
      SELECT COUNT(DISTINCT event_id)::TEXT AS total
      FROM attendance_records
      WHERE event_id IS NOT NULL
        AND LOWER(TRIM(student_id)) = LOWER(TRIM($1))
    `,
    [studentId],
  );

  return Number(result.rows[0]?.total ?? 0);
}

async function syncAbsencesForStudents(
  client: PoolClient,
  studentIds: string[],
) {
  const scopes = await getAttendanceStudentScopes(client, studentIds);
  const totalEvents = await countAttendanceEvents(client);
  const records: AttendanceRecord[] = [];
  const fines: FineRecord[] = [];

  for (const scope of scopes) {
    const attendedEvents = await countStudentAttendanceEvents(
      client,
      scope.student_id,
    );
    const noOfAbsences = Math.max(totalEvents - attendedEvents, 0);

    const updatedResult = await client.query<AttendanceRecord>(
      `
        UPDATE attendance_records
        SET no_of_absences = $2, updated_at = NOW()
        WHERE event_id IS NOT NULL
          AND LOWER(TRIM(student_id)) = LOWER(TRIM($1))
        RETURNING *
      `,
      [scope.student_id, noOfAbsences],
    );

    for (const record of updatedResult.rows) {
      records.push(record);
      const fine = await syncFineForAttendanceRecord(client, record);
      if (fine) fines.push(fine);
    }
  }

  return { records, fines };
}

async function syncAllEventAbsences(client: PoolClient) {
  const scopes = await getAttendanceStudentScopes(client);
  return syncAbsencesForStudents(
    client,
    scopes.map((scope) => scope.student_id),
  );
}

async function listRecordsByIds(client: PoolClient, ids: string[]) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
  if (!uniqueIds.length) return [];

  const result = await client.query<AttendanceRecord>(
    `
      SELECT ${ATTENDANCE_RECORD_SELECT}
      FROM attendance_records ar
      LEFT JOIN attendance_events ae ON ae.id = ar.event_id
      LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
      WHERE ar.id = ANY($1::uuid[])
      ORDER BY ar.created_at DESC
    `,
    [uniqueIds],
  );

  return result.rows;
}

async function getAttendanceImportById(client: PoolClient, importId: string) {
  const result = await client.query<AttendanceImportRecord>(
    `
      SELECT ai.*, ae.name AS event_name
      FROM attendance_imports ai
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      WHERE ai.id = $1
      LIMIT 1
    `,
    [importId],
  );

  return result.rows[0] ?? null;
}

async function getStudentIdsAffectedByImports(
  client: PoolClient,
  importIds: string[],
) {
  const uniqueImportIds = Array.from(new Set(importIds.filter(Boolean)));
  if (!uniqueImportIds.length) return [];

  const result = await client.query<{ student_id: string }>(
    `
      SELECT DISTINCT student_id
      FROM attendance_records
      WHERE import_id = ANY($1::uuid[]) AND event_id IS NOT NULL
    `,
    [uniqueImportIds],
  );

  return result.rows.map((row) => row.student_id);
}

async function deleteAttendanceImportRecords(
  client: PoolClient,
  importIds: string[],
) {
  const uniqueImportIds = Array.from(new Set(importIds.filter(Boolean)));
  if (!uniqueImportIds.length) return;

  await client.query(
    `
      DELETE FROM fines
      WHERE attendance_record_id IN (
        SELECT id FROM attendance_records WHERE import_id = ANY($1::uuid[])
      )
    `,
    [uniqueImportIds],
  );

  await client.query(
    "DELETE FROM attendance_records WHERE import_id = ANY($1::uuid[])",
    [uniqueImportIds],
  );
  await client.query(
    "DELETE FROM attendance_imports WHERE id = ANY($1::uuid[])",
    [uniqueImportIds],
  );
}

export async function previewAttendanceFile(
  file: UploadedAttendanceFile,
): Promise<AttendancePreviewResult> {
  if (!file?.buffer?.length) {
    throw new Error("Please upload a valid Excel, text, or document file.");
  }

  const extension = getFileExtension(file.originalname);
  const rawRows = await parseFileToRawRows(file);
  return buildPreview(
    file.originalname,
    extension.replace(".", "") || file.mimetype || "unknown",
    rawRows,
  );
}

export async function saveAttendanceRows(
  input: SaveRowsInput,
): Promise<SavedAttendanceImportResult> {
  assertAttendanceImportNotCancelled(input);

  await emitAttendanceImportProgress(input.onProgress, {
    stage: "validating",
    percent: 10,
    message: input.resumeImportId
      ? "Validating remaining attendance rows..."
      : "Validating attendance rows...",
    processedRows: 0,
    totalRows: Array.isArray(input.rows) ? input.rows.length : 0,
  });

  const preview = buildPreview(
    input.fileName ?? "manual-import",
    input.fileType ?? "json",
    input.rows,
  );
  const validRows = preview.rows.filter((row) => row.errors.length === 0);
  const hasEventContext = Boolean(
    cleanText(input.eventId) ||
    cleanText(input.eventName) ||
    cleanText(input.resumeImportId) ||
    validRows.some((row) => row.eventName),
  );

  if (!hasEventContext) {
    throw createValidationError(
      "Event name is required when saving an uploaded attendance file.",
    );
  }

  const result = await withTransaction(async (client) => {
    assertAttendanceImportNotCancelled(input);

    const existingImport = input.resumeImportId
      ? await getAttendanceImportById(client, input.resumeImportId)
      : null;

    if (input.resumeImportId && !existingImport) {
      throw createValidationError(
        "The resumable attendance import could not be found. Please start the import again.",
        404,
      );
    }

    const defaultEvent =
      cleanText(input.eventId) || cleanText(input.eventName)
        ? await findOrCreateAttendanceEvent(client, input)
        : existingImport?.event_id
          ? await getAttendanceEventById(client, existingImport.event_id)
          : null;

    const importRecord = existingImport
      ? (
          await client.query<AttendanceImportRecord>(
            `
              UPDATE attendance_imports
              SET
                event_id = COALESCE(event_id, $2),
                rows_total = rows_total + $3,
                rows_valid = rows_valid + $4,
                rows_invalid = rows_invalid + $5,
                status = 'saved'
              WHERE id = $1
              RETURNING *
            `,
            [
              existingImport.id,
              defaultEvent?.id ?? null,
              preview.rowsTotal,
              preview.rowsValid,
              preview.rowsInvalid,
            ],
          )
        ).rows[0]
      : (
          await client.query<AttendanceImportRecord>(
            `
              INSERT INTO attendance_imports (event_id, file_name, file_type, rows_total, rows_valid, rows_invalid, status)
              VALUES ($1, $2, $3, $4, $5, $6, 'saved')
              RETURNING *
            `,
            [
              defaultEvent?.id ?? null,
              preview.fileName,
              preview.fileType,
              preview.rowsTotal,
              preview.rowsValid,
              preview.rowsInvalid,
            ],
          )
        ).rows[0];

    const importId = importRecord.id;
    const savedRecordIds: string[] = [];
    const affectedStudentIds: string[] = [];
    const rowsToSave = mergeAttendanceImportRowsByStudentAndEvent(
      validRows,
      input,
    );

    await emitAttendanceImportProgress(input.onProgress, {
      stage: "saving",
      percent: 25,
      message: input.resumeImportId
        ? "Saving remaining attendance records..."
        : "Saving attendance records...",
      processedRows: 0,
      totalRows: rowsToSave.length,
      savedRecords: 0,
    });

    for (const [index, row] of rowsToSave.entries()) {
      assertAttendanceImportNotCancelled(input);

      const event = row.eventName
        ? await findOrCreateAttendanceEvent(
            client,
            {
              ...input,
              eventName: row.eventName,
              eventStartAt: row.eventStartAt ?? input.eventStartAt,
              eventEndAt: row.eventEndAt ?? input.eventEndAt,
            },
            row.eventName,
          )
        : defaultEvent;

      if (!event) {
        throw createValidationError(
          "Event name is required when saving an uploaded attendance file.",
        );
      }

      await upsertStudent(client, row);
      const record = await insertAttendanceRecord(
        client,
        importId,
        event.id,
        row,
      );
      savedRecordIds.push(record.id);
      affectedStudentIds.push(record.student_id);

      await emitAttendanceImportProgress(input.onProgress, {
        stage: "saving",
        percent: getAttendanceRowSaveProgressPercent(
          index + 1,
          rowsToSave.length,
        ),
        message: input.resumeImportId
          ? "Saving remaining attendance records..."
          : "Saving attendance records...",
        processedRows: index + 1,
        totalRows: rowsToSave.length,
        savedRecords: savedRecordIds.length,
      });
    }

    assertAttendanceImportNotCancelled(input);

    await emitAttendanceImportProgress(input.onProgress, {
      stage: "syncing",
      percent: 90,
      message: "Syncing absences and fines...",
      processedRows: rowsToSave.length,
      totalRows: rowsToSave.length,
      savedRecords: savedRecordIds.length,
    });

    const synced = await syncAbsencesForStudents(client, affectedStudentIds);
    const savedRecords = await listRecordsByIds(client, savedRecordIds);

    await emitAttendanceImportProgress(input.onProgress, {
      stage: "syncing",
      percent: 96,
      message: "Finalizing attendance import...",
      processedRows: rowsToSave.length,
      totalRows: rowsToSave.length,
      savedRecords: savedRecords.length,
      createdFines: synced.fines.length,
    });

    return {
      ...preview,
      importId,
      event: defaultEvent,
      savedRecords,
      createdFines: synced.fines,
    };
  });

  await emitAttendanceImportProgress(input.onProgress, {
    stage: "completed",
    percent: 100,
    message: input.resumeImportId
      ? "Attendance import resumed and completed."
      : "Attendance import completed.",
    processedRows: result.savedRecords.length,
    totalRows: result.savedRecords.length,
    savedRecords: result.savedRecords.length,
    createdFines: result.createdFines.length,
  });

  return result;
}

export async function saveAttendanceFile(
  file: UploadedAttendanceFile,
  options: Omit<SaveRowsInput, "rows" | "fileName" | "fileType"> = {},
  onProgress?: AttendanceImportProgressCallback,
): Promise<SavedAttendanceImportResult> {
  assertAttendanceImportNotCancelled(options);

  await emitAttendanceImportProgress(onProgress ?? options.onProgress, {
    stage: "parsing",
    percent: 5,
    message: "Reading uploaded attendance file...",
    processedRows: 0,
    totalRows: 0,
  });

  const preview = await previewAttendanceFile(file);

  assertAttendanceImportNotCancelled(options);

  await emitAttendanceImportProgress(onProgress ?? options.onProgress, {
    stage: "validating",
    percent: 15,
    message: "Preparing parsed attendance rows...",
    processedRows: 0,
    totalRows: preview.rows.length,
  });

  return saveAttendanceRows({
    ...options,
    onProgress: onProgress ?? options.onProgress,
    fileName: preview.fileName,
    fileType: preview.fileType,
    rows: preview.rows,
  });
}

export async function saveManualAttendanceRecord(input: RawImportRow) {
  const row = validateAttendanceInput(input);

  return withTransaction(async (client) => {
    const event = await findOrCreateAttendanceEvent(client, input);

    await upsertStudent(client, row);
    const record = await insertAttendanceRecord(
      client,
      null,
      event?.id ?? null,
      row,
    );

    if (event) {
      const synced = await syncAbsencesForStudents(client, [record.student_id]);
      const updatedRecord =
        (await listRecordsByIds(client, [record.id]))[0] ?? record;
      const fine =
        synced.fines.find((item) => item.attendance_record_id === record.id) ??
        null;

      return {
        event,
        record: updatedRecord,
        fine,
      };
    }

    const fine = await insertFineIfNeeded(client, record);

    return {
      event,
      record,
      fine,
    };
  });
}

export async function updateAttendanceRecord(id: string, input: RawImportRow) {
  const row = validateAttendanceInput(input);

  return withTransaction(async (client) => {
    const existingResult = await client.query<AttendanceRecord>(
      "SELECT * FROM attendance_records WHERE id = $1 LIMIT 1",
      [id],
    );
    const existingRecord = existingResult.rows[0];

    if (!existingRecord) {
      throw createValidationError("Attendance record not found.", 404);
    }

    const event = await findOrCreateAttendanceEvent(client, input);
    await upsertStudent(client, row);

    const updatedResult = await client.query<AttendanceRecord>(
      `
        UPDATE attendance_records
        SET
          event_id = $2,
          student_id = $3,
          name = $4,
          year_level = NULLIF($5, ''),
          college = NULLIF($6, ''),
          program = NULLIF($7, ''),
          institution = NULLIF($8, ''),
          no_of_absences = $9,
          scanned_at = $10::TIMESTAMPTZ,
          remarks = NULLIF($11, ''),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        event?.id ?? null,
        row.studentId,
        row.name,
        row.yearLevel ?? "",
        row.college ?? "",
        row.program ?? "",
        row.institution ?? "",
        row.noOfAbsences ?? 0,
        row.scannedAt ?? null,
        row.remarks ?? "",
      ],
    );

    const record = updatedResult.rows[0];
    const affectedStudentIds = [existingRecord.student_id, record.student_id];

    if (existingRecord.event_id || record.event_id) {
      const synced = await syncAbsencesForStudents(client, affectedStudentIds);
      const updatedRecord =
        (await listRecordsByIds(client, [record.id]))[0] ?? record;
      const fine =
        synced.fines.find((item) => item.attendance_record_id === record.id) ??
        null;

      return {
        event,
        record: updatedRecord,
        fine,
      };
    }

    const fine = await syncFineForAttendanceRecord(client, record);

    return {
      event,
      record,
      fine,
    };
  });
}

export async function deleteAttendanceRecord(id: string) {
  return withTransaction(async (client) => {
    const existingResult = await client.query<AttendanceRecord>(
      "SELECT * FROM attendance_records WHERE id = $1 LIMIT 1",
      [id],
    );
    const record = existingResult.rows[0];

    if (!record) {
      throw createValidationError("Attendance record not found.", 404);
    }

    await client.query("DELETE FROM fines WHERE attendance_record_id = $1", [
      id,
    ]);
    await client.query("DELETE FROM attendance_records WHERE id = $1", [id]);

    if (record.event_id) {
      await syncAbsencesForStudents(client, [record.student_id]);
    }

    return record;
  });
}

export async function deleteAttendanceImport(importId: string) {
  return withTransaction(async (client) => {
    const importRecord = await getAttendanceImportById(client, importId);

    if (!importRecord) {
      throw createValidationError("Attendance import not found.", 404);
    }

    const affectedStudentIds = await getStudentIdsAffectedByImports(client, [
      importId,
    ]);

    await deleteAttendanceImportRecords(client, [importId]);

    if (affectedStudentIds.length) {
      await syncAbsencesForStudents(client, affectedStudentIds);
    }

    return importRecord;
  });
}

export async function deleteAttendanceImports(): Promise<DeletedAttendanceImportsResult> {
  return withTransaction(async (client) => {
    const importsResult = await client.query<AttendanceImportRecord>(
      `
        SELECT ai.*, ae.name AS event_name
        FROM attendance_imports ai
        LEFT JOIN attendance_events ae ON ae.id = ai.event_id
        ORDER BY ai.created_at DESC
      `,
    );

    const deletedImports = importsResult.rows;
    const importIds = deletedImports.map((record) => record.id);

    if (!importIds.length) {
      return {
        deletedCount: 0,
        deletedImports: [],
      };
    }

    const affectedStudentIds = await getStudentIdsAffectedByImports(
      client,
      importIds,
    );

    await deleteAttendanceImportRecords(client, importIds);

    if (affectedStudentIds.length) {
      await syncAbsencesForStudents(client, affectedStudentIds);
    }

    return {
      deletedCount: deletedImports.length,
      deletedImports,
    };
  });
}

export async function listAttendanceEvents(limit = 100, offset = 0) {
  const result = await query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      GROUP BY e.id
      ORDER BY COALESCE(e.event_start_at, e.event_end_at, e.created_at) DESC, e.created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );

  return result.rows;
}

export async function createAttendanceEvent(input: AttendanceEventInput) {
  const eventInput = getEventInput(input);

  if (!eventInput.name) {
    throw createValidationError("Event name is required.");
  }

  return withTransaction(async (client) => {
    const result = await client.query<AttendanceEventRecord>(
      `
        INSERT INTO attendance_events (name, event_start_at, event_end_at, description)
        VALUES ($1, $2, $3, $4)
        RETURNING *, 0::INT AS attendees_count
      `,
      [
        eventInput.name,
        eventInput.eventStartAt,
        eventInput.eventEndAt,
        eventInput.description,
      ],
    );

    await syncAllEventAbsences(client);
    return result.rows[0];
  });
}

export async function updateAttendanceEvent(
  id: string,
  input: AttendanceEventInput,
) {
  const eventInput = getEventInput(input);

  if (!eventInput.name) {
    throw createValidationError("Event name is required.");
  }

  return withTransaction(async (client) => {
    const existing = await getAttendanceEventById(client, id);
    if (!existing)
      throw createValidationError("Attendance event not found.", 404);

    const result = await client.query<AttendanceEventRecord>(
      `
        UPDATE attendance_events
        SET name = $2, event_start_at = $3, event_end_at = $4, description = $5, updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        eventInput.name,
        eventInput.eventStartAt,
        eventInput.eventEndAt,
        eventInput.description,
      ],
    );

    return (
      (await getAttendanceEventById(client, result.rows[0].id)) ??
      result.rows[0]
    );
  });
}

export async function deleteAttendanceEvent(id: string) {
  return withTransaction(async (client) => {
    const existing = await getAttendanceEventById(client, id);
    if (!existing)
      throw createValidationError("Attendance event not found.", 404);

    await client.query(
      `
        DELETE FROM fines
        WHERE attendance_record_id IN (
          SELECT id FROM attendance_records WHERE event_id = $1
        )
      `,
      [id],
    );
    await client.query("DELETE FROM attendance_records WHERE event_id = $1", [
      id,
    ]);
    await client.query(
      "UPDATE attendance_imports SET event_id = NULL WHERE event_id = $1",
      [id],
    );
    await client.query("DELETE FROM attendance_events WHERE id = $1", [id]);
    await syncAllEventAbsences(client);

    return existing;
  });
}

export async function listAttendanceRecords(
  limit = 100,
  offset = 0,
  studentId?: string,
  eventId?: string,
  college?: string,
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (studentId) {
    params.push(studentId);
    clauses.push(`LOWER(TRIM(ar.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  if (eventId) {
    params.push(eventId);
    clauses.push(`ar.event_id = $${params.length}`);
  }

  if (college) {
    params.push(college);
    clauses.push(
      `LOWER(TRIM(COALESCE(NULLIF(TRIM(s.college), ''), ar.college, ''))) = LOWER(TRIM($${params.length}))`,
    );
  }

  params.push(limit);
  const limitPosition = params.length;

  params.push(offset);
  const offsetPosition = params.length;

  const result = await query<AttendanceRecord>(
    `
      SELECT ${ATTENDANCE_RECORD_SELECT}
      FROM attendance_records ar
      LEFT JOIN attendance_events ae ON ae.id = ar.event_id
      LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY COALESCE(ar.scanned_at, ar.created_at) DESC, ar.created_at DESC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}

export async function listAttendanceImports(limit = 50, offset = 0) {
  const result = await query<AttendanceImportRecord>(
    `
      SELECT ai.*, ae.name AS event_name
      FROM attendance_imports ai
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      ORDER BY ai.created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset],
  );

  return result.rows;
}

export async function getAttendanceImport(importId: string) {
  const importResult = await query<AttendanceImportRecord>(
    `
      SELECT ai.*, ae.name AS event_name
      FROM attendance_imports ai
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      WHERE ai.id = $1
      LIMIT 1
    `,
    [importId],
  );

  if (!importResult.rows[0]) return null;

  const recordsResult = await query<AttendanceRecord>(
    `
      SELECT ${ATTENDANCE_RECORD_SELECT}
      FROM attendance_records ar
      LEFT JOIN attendance_events ae ON ae.id = ar.event_id
      LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
      WHERE ar.import_id = $1
      ORDER BY ar.created_at ASC
    `,
    [importId],
  );

  return {
    import: importResult.rows[0],
    records: recordsResult.rows,
  };
}