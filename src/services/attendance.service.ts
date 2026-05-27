import path from "path";
import { PoolClient } from "pg";

import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceEventRecord,
  AttendanceFinalResultRecord,
  AttendanceImportProgress,
  AttendanceImportRecord,
  AttendancePreviewResult,
  CalculationResultRecord,
  AttendanceRecord,
  FineRecord,
  ManualAttendanceRecord,
  ParsedAttendanceRow,
  PenaltyResultRecord,
  SavedAttendanceImportResult,
  SchoolYearRecord,
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
  schoolYearId?: string;
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
  schoolYearId?: string;
  school_year_id?: string;
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
  eventOrder?: string | number;
  event_order?: string | number;
};

export type UpdatedAttendanceRecordsResult = {
  event: AttendanceEventRecord | null;
  records: AttendanceRecord[];
  updatedRecordIds: string[];
  fines: FineRecord[];
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
  ar.school_year_id,
  ar.import_id,
  ar.event_id,
  ae.name AS event_name,
  ae.event_order,
  ae.event_start_at,
  ae.event_end_at,
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
  const collegeKey = cleanText(row.college) || "no-college";

  return `${normalizeHeader(eventKey)}:${normalizeHeader(collegeKey)}:${cleanText(row.studentId).toLowerCase()}`;
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

function normalizeOptionalPositiveInteger(value: unknown, label = "Order") {
  const text = cleanText(value);
  if (!text) return { value: null as number | null, error: "" };

  const parsedValue = Number(text);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    return {
      value: null as number | null,
      error: `${label} must be a positive whole number.`,
    };
  }

  return { value: parsedValue, error: "" };
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
  const eventOrder = normalizeOptionalPositiveInteger(
    (input as AttendanceEventInput).eventOrder ??
      (input as AttendanceEventInput).event_order,
    "Event order",
  );

  if (eventStartAt.error) throw createValidationError(eventStartAt.error);
  if (eventEndAt.error) throw createValidationError(eventEndAt.error);
  if (eventOrder.error) throw createValidationError(eventOrder.error);
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
    schoolYearId: cleanText(
      (input as AttendanceEventInput).schoolYearId ??
        (input as AttendanceEventInput).school_year_id,
    ),
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
    eventOrder: eventOrder.value,
  };
}


function getSchoolYearRangeFromDate(value: Date = new Date()) {
  const year = value.getFullYear();
  const month = value.getMonth() + 1;
  const startYear = month >= 6 ? year : year - 1;
  const endYear = startYear + 1;

  return {
    name: `${startYear}-${endYear}`,
    startsAt: `${startYear}-06-01`,
    endsAt: `${endYear}-05-31`,
  };
}

function getFirstValidSchoolYearDate(values: unknown[]) {
  for (const value of values) {
    const text = cleanText(value);
    if (!text) continue;

    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
  }

  return new Date();
}

async function ensureSchoolYearForDate(client: PoolClient, values: unknown[] = []) {
  const range = getSchoolYearRangeFromDate(getFirstValidSchoolYearDate(values));
  const result = await client.query<SchoolYearRecord>(
    `
      INSERT INTO school_years (name, starts_at, ends_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (name)
      DO UPDATE SET
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        updated_at = NOW()
      RETURNING *
    `,
    [range.name, range.startsAt, range.endsAt],
  );

  return result.rows[0];
}

async function resolveSchoolYearId(
  client: PoolClient,
  requestedSchoolYearId: unknown,
  dateValues: unknown[] = [],
) {
  const cleanSchoolYearId = cleanText(requestedSchoolYearId);

  if (cleanSchoolYearId) {
    const result = await client.query<SchoolYearRecord>(
      `
        SELECT *
        FROM school_years
        WHERE id = $1
        LIMIT 1
      `,
      [cleanSchoolYearId],
    );

    if (!result.rows[0]) {
      throw createValidationError("School year not found.", 404);
    }

    return result.rows[0].id;
  }

  return (await ensureSchoolYearForDate(client, dateValues)).id;
}

async function getNextAttendanceEventOrder(
  client: PoolClient,
  schoolYearId: string | null,
) {
  const result = await client.query<{ next_order: number }>(
    `
      SELECT COALESCE(MAX(event_order), 0) + 1 AS next_order
      FROM attendance_events
      WHERE school_year_id IS NOT DISTINCT FROM $1
    `,
    [schoolYearId],
  );

  return Number(result.rows[0]?.next_order ?? 1);
}

async function getAttendanceEventCount(
  client: PoolClient,
  schoolYearId: string | null,
) {
  const result = await client.query<{ total: string | number }>(
    `
      SELECT COUNT(*) AS total
      FROM attendance_events
      WHERE school_year_id IS NOT DISTINCT FROM $1
    `,
    [schoolYearId],
  );

  return Number(result.rows[0]?.total ?? 0);
}

async function shiftAttendanceEventOrderForInsert(
  client: PoolClient,
  schoolYearId: string | null,
  eventOrder: number,
) {
  await client.query(
    `
      UPDATE attendance_events
      SET event_order = COALESCE(event_order, 0) + 1,
          updated_at = NOW()
      WHERE school_year_id IS NOT DISTINCT FROM $1
        AND event_order >= $2
    `,
    [schoolYearId, eventOrder],
  );
}

async function moveAttendanceEventOrder(
  client: PoolClient,
  props: {
    eventId: string;
    schoolYearId: string | null;
    currentOrder: number | null;
    nextOrder: number;
  },
) {
  const currentOrder = Number(props.currentOrder ?? 0);

  if (currentOrder > 0 && props.nextOrder < currentOrder) {
    await client.query(
      `
        UPDATE attendance_events
        SET event_order = COALESCE(event_order, 0) + 1,
            updated_at = NOW()
        WHERE school_year_id IS NOT DISTINCT FROM $1
          AND id <> $2
          AND event_order >= $3
          AND event_order < $4
      `,
      [props.schoolYearId, props.eventId, props.nextOrder, currentOrder],
    );
    return;
  }

  if (currentOrder > 0 && props.nextOrder > currentOrder) {
    await client.query(
      `
        UPDATE attendance_events
        SET event_order = GREATEST(1, COALESCE(event_order, 1) - 1),
            updated_at = NOW()
        WHERE school_year_id IS NOT DISTINCT FROM $1
          AND id <> $2
          AND event_order > $3
          AND event_order <= $4
      `,
      [props.schoolYearId, props.eventId, currentOrder, props.nextOrder],
    );
  }
}


async function resequenceAttendanceEvents(
  client: PoolClient,
  schoolYearId: string | null,
) {
  await client.query(
    `
      WITH ordered_events AS (
        SELECT
          id,
          ROW_NUMBER() OVER (
            ORDER BY
              event_order ASC NULLS LAST,
              COALESCE(event_start_at, event_end_at, created_at) ASC,
              created_at ASC,
              id ASC
          ) AS next_order
        FROM attendance_events
        WHERE school_year_id IS NOT DISTINCT FROM $1
      )
      UPDATE attendance_events event
      SET event_order = ordered_events.next_order,
          updated_at = NOW()
      FROM ordered_events
      WHERE event.id = ordered_events.id
    `,
    [schoolYearId],
  );
}

function getManualAttendanceEventInput(input: RawImportRow) {
  const eventInput = input as Record<string, unknown>;

  return {
    schoolYearId: cleanText(eventInput.schoolYearId ?? eventInput.school_year_id),
    eventId: cleanText(eventInput.eventId ?? eventInput.event_id),
    eventName: cleanText(eventInput.eventName ?? eventInput.event_name),
    eventStartAt: eventInput.eventStartAt ?? eventInput.event_start_at ?? eventInput.eventDate ?? eventInput.event_date,
    eventEndAt: eventInput.eventEndAt ?? eventInput.event_end_at,
    eventDescription: eventInput.eventDescription ?? eventInput.event_description ?? eventInput.description,
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

  const schoolYearId = await resolveSchoolYearId(client, eventInput.schoolYearId, [
    eventInput.eventStartAt,
    eventInput.eventEndAt,
  ]);

  const existingResult = await client.query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      WHERE LOWER(TRIM(e.name)) = LOWER(TRIM($1))
        AND e.school_year_id = $2
      GROUP BY e.id
      ORDER BY e.created_at DESC
      LIMIT 1
    `,
    [name, schoolYearId],
  );

  if (existingResult.rows[0]) return existingResult.rows[0];

  const createdResult = await client.query<AttendanceEventRecord>(
    `
      INSERT INTO attendance_events (
        school_year_id,
        name,
        event_start_at,
        event_end_at,
        description,
        event_order
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *, 0::INT AS attendees_count
    `,
    [
      schoolYearId,
      name,
      eventInput.eventStartAt,
      eventInput.eventEndAt,
      eventInput.description,
      await getNextAttendanceEventOrder(client, schoolYearId),
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
  schoolYearId: string | null,
  row: ParsedAttendanceRow,
) {
  const result = await client.query<AttendanceRecord>(
    `
      INSERT INTO attendance_records (
        school_year_id,
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
      VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), $10, $11::TIMESTAMPTZ, NULLIF($12, ''))
      RETURNING *
    `,
    [
      schoolYearId,
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

const FINE_RETURNING_COLUMNS_SQL = `
  id,
  school_year_id,
  attendance_record_id,
  penalty_id,
  student_id,
  name,
  prescribed_penalty,
  status,
  created_at,
  updated_at
`;

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
          school_year_id = $2,
          penalty_id = $3,
          student_id = $4,
          name = $5,
          prescribed_penalty = $6,
          updated_at = NOW()
        WHERE id = $1
        RETURNING ${FINE_RETURNING_COLUMNS_SQL}, $7::INT AS no_of_absences
      `,
      [
        existingFine.id,
        record.school_year_id,
        penalty?.id ?? null,
        record.student_id,
        record.name,
        penaltyText,
        record.no_of_absences,
      ],
    );

    return fineResult.rows[0];
  }

  const fineResult = await client.query<FineRecord>(
    `
      INSERT INTO fines (
        school_year_id,
        attendance_record_id,
        penalty_id,
        student_id,
        name,
        prescribed_penalty,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid')
      RETURNING ${FINE_RETURNING_COLUMNS_SQL}, $7::INT AS no_of_absences
    `,
    [
      record.school_year_id,
      record.id,
      penalty?.id ?? null,
      record.student_id,
      record.name,
      penaltyText,
      record.no_of_absences,
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

type AttendanceRecordWithAbsenceScope = AttendanceRecord & {
  attendance_college_scope_key: string | null;
  attendance_school_year_id: string | null;
};

function getAttendanceRecordScopeColumnSql(recordAlias: string, columnName: string) {
  return `
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.${columnName}), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(${recordAlias}.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(${recordAlias}.${columnName}), ''),
      ''
    )))
  `;
}

function getAttendanceRecordCollegeScopeSql(recordAlias: string) {
  return `
    CONCAT_WS(
      '|',
      ${getAttendanceRecordScopeColumnSql(recordAlias, "institution")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "college")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "program")},
      ${getAttendanceRecordScopeColumnSql(recordAlias, "year_level")}
    )
  `;
}

function getAttendanceRecordSortTime(record: AttendanceRecord) {
  const value = record.scanned_at ?? record.created_at;
  const time = value ? new Date(value).getTime() : 0;

  return Number.isNaN(time) ? 0 : time;
}

const ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL =
  getAttendanceRecordCollegeScopeSql("ar");
const ATTENDANCE_ATTENDED_RECORD_COLLEGE_SCOPE_SQL =
  getAttendanceRecordCollegeScopeSql("attended");
const ATTENDANCE_ABSENCE_SYNC_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('penalyze.attendance_absence_sync')::bigint)";

function uniqueAttendanceRecords(records: AttendanceRecord[]) {
  const recordsById = new Map<string, AttendanceRecord>();

  records.forEach((record) => {
    if (record.id) recordsById.set(record.id, record);
  });

  return Array.from(recordsById.values());
}

function uniqueFineRecords(fines: Array<FineRecord | null>) {
  const finesById = new Map<string, FineRecord>();

  fines.forEach((fine) => {
    if (fine?.id) finesById.set(fine.id, fine);
  });

  return Array.from(finesById.values());
}

function uniqueTextValues(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function uniqueCleanTextValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => cleanText(value)).filter(Boolean)),
  );
}

function filterAttendanceFinesByRecordIds(
  fines: Array<FineRecord | null>,
  recordIds: string[],
) {
  const recordIdSet = new Set(recordIds);

  return fines.filter((fine): fine is FineRecord => {
    return Boolean(
      fine?.attendance_record_id &&
        recordIdSet.has(String(fine.attendance_record_id)),
    );
  });
}

async function lockAttendanceAbsenceSync(client: PoolClient) {
  await client.query(ATTENDANCE_ABSENCE_SYNC_LOCK_SQL);
}

async function getAttendanceRecordCollegeScopeKeys(
  client: PoolClient,
  recordIds: string[],
) {
  const uniqueRecordIds = uniqueCleanTextValues(recordIds);
  if (!uniqueRecordIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.id = ANY($1::uuid[])
        AND ar.event_id IS NOT NULL
    `,
    [uniqueRecordIds],
  );

  return uniqueCleanTextValues(result.rows.map((row) => row.college_key));
}

async function getAttendanceImportCollegeScopeKeys(
  client: PoolClient,
  importIds: string[],
) {
  const uniqueImportIds = uniqueCleanTextValues(importIds);
  if (!uniqueImportIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.import_id = ANY($1::uuid[])
        AND ar.event_id IS NOT NULL
    `,
    [uniqueImportIds],
  );

  return uniqueCleanTextValues(result.rows.map((row) => row.college_key));
}

async function getAttendanceEventCollegeScopeKeys(
  client: PoolClient,
  eventIds: string[],
) {
  const uniqueEventIds = uniqueCleanTextValues(eventIds);
  if (!uniqueEventIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.event_id = ANY($1::uuid[])
    `,
    [uniqueEventIds],
  );

  return uniqueCleanTextValues(result.rows.map((row) => row.college_key));
}

async function getAttendanceStudentIdsByCollegeScopeKeys(
  client: PoolClient,
  collegeKeys: string[],
) {
  const uniqueCollegeKeys = uniqueCleanTextValues(collegeKeys);
  if (!uniqueCollegeKeys.length) return [];

  const result = await client.query<{ student_id: string }>(
    `
      SELECT DISTINCT ar.student_id
      FROM attendance_records ar
      WHERE ar.event_id IS NOT NULL
        AND ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} = ANY($1::TEXT[])
    `,
    [uniqueCollegeKeys],
  );

  return uniqueCleanTextValues(result.rows.map((row) => row.student_id));
}

async function syncAbsencesForAttendanceCollegeScopes(
  client: PoolClient,
  collegeKeys: string[],
) {
  const uniqueCollegeKeys = uniqueCleanTextValues(collegeKeys);
  const studentIds = await getAttendanceStudentIdsByCollegeScopeKeys(
    client,
    uniqueCollegeKeys,
  );

  return syncAbsencesForStudents(client, studentIds);
}

export async function syncAbsencesForAttendanceRecordIds(
  client: PoolClient,
  recordIds: string[],
) {
  const collegeKeys = await getAttendanceRecordCollegeScopeKeys(
    client,
    recordIds,
  );

  return syncAbsencesForAttendanceCollegeScopes(client, collegeKeys);
}

async function syncAbsencesForStudents(
  client: PoolClient,
  studentIds: string[],
) {
  const uniqueStudentIds = Array.from(
    new Set(
      studentIds
        .map((studentId) => cleanText(studentId).toLowerCase())
        .filter(Boolean),
    ),
  );

  if (!uniqueStudentIds.length) {
    return { records: [], fines: [] };
  }

  await lockAttendanceAbsenceSync(client);

  const updatedResult = await client.query<AttendanceRecordWithAbsenceScope>(
    `
      WITH college_event_scope AS (
        SELECT DISTINCT
          ar.event_id,
          ar.school_year_id,
          ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} AS college_key
        FROM attendance_records ar
        WHERE ar.event_id IS NOT NULL
      ),
      student_scope AS (
        SELECT DISTINCT
          LOWER(TRIM(ar.student_id)) AS student_key,
          ar.school_year_id,
          ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} AS college_key
        FROM attendance_records ar
        WHERE ar.event_id IS NOT NULL
          AND LOWER(TRIM(ar.student_id)) = ANY($1::TEXT[])
      ),
      student_absences AS (
        SELECT
          ss.student_key,
          ss.college_key,
          ss.school_year_id,
          GREATEST(
            COUNT(DISTINCT ces.event_id)::INT -
              COUNT(DISTINCT attended.event_id)::INT,
            0
          ) AS no_of_absences
        FROM student_scope ss
        LEFT JOIN college_event_scope ces
          ON ces.college_key = ss.college_key
         AND ces.school_year_id IS NOT DISTINCT FROM ss.school_year_id
        LEFT JOIN attendance_records attended
          ON LOWER(TRIM(attended.student_id)) = ss.student_key
          AND attended.event_id = ces.event_id
          AND attended.school_year_id IS NOT DISTINCT FROM ss.school_year_id
          AND ${ATTENDANCE_ATTENDED_RECORD_COLLEGE_SCOPE_SQL} = ss.college_key
        GROUP BY ss.student_key, ss.college_key, ss.school_year_id
      ),
      target_records AS (
        SELECT
          ar.id,
          sa.college_key,
          sa.no_of_absences,
          sa.school_year_id
        FROM attendance_records ar
        JOIN student_absences sa
          ON LOWER(TRIM(ar.student_id)) = sa.student_key
         AND ${ATTENDANCE_RECORD_COLLEGE_SCOPE_SQL} = sa.college_key
         AND ar.school_year_id IS NOT DISTINCT FROM sa.school_year_id
        WHERE ar.event_id IS NOT NULL
        ORDER BY ar.id
        FOR UPDATE OF ar
      )
      UPDATE attendance_records ar
      SET no_of_absences = target.no_of_absences,
          updated_at = CASE
            WHEN ar.no_of_absences IS DISTINCT FROM target.no_of_absences THEN NOW()
            ELSE ar.updated_at
          END
      FROM target_records target
      WHERE ar.id = target.id
      RETURNING ar.*, target.college_key AS attendance_college_scope_key, target.school_year_id AS attendance_school_year_id
    `,
    [uniqueStudentIds],
  );

  const records = updatedResult.rows;
  const fines: FineRecord[] = [];

  if (!records.length) {
    return { records, fines };
  }

  const existingFineResult = await client.query<{ attendance_record_id: string }>(
    `
      SELECT attendance_record_id
      FROM fines
      WHERE attendance_record_id = ANY($1::uuid[])
    `,
    [records.map((record) => record.id)],
  );
  const recordsWithExistingFine = new Set(
    existingFineResult.rows
      .map((row) => row.attendance_record_id)
      .filter(Boolean),
  );
  const recordsByStudentScope = new Map<
    string,
    AttendanceRecordWithAbsenceScope[]
  >();

  records.forEach((record) => {
    const scopeKey = [
      cleanText(record.student_id).toLowerCase(),
      cleanText(record.attendance_college_scope_key),
      cleanText(record.attendance_school_year_id),
    ].join(":");
    const scopeRecords = recordsByStudentScope.get(scopeKey) ?? [];

    scopeRecords.push(record);
    recordsByStudentScope.set(scopeKey, scopeRecords);
  });

  const recordIdsToRemoveFinesFrom: string[] = [];
  const recordsToSyncFine: AttendanceRecordWithAbsenceScope[] = [];

  recordsByStudentScope.forEach((scopeRecords) => {
    const existingFineRecords = scopeRecords.filter((record) =>
      recordsWithExistingFine.has(record.id),
    );
    const anchorCandidates = existingFineRecords.length
      ? existingFineRecords
      : scopeRecords;
    const anchorRecord = [...anchorCandidates].sort(
      (leftRecord, rightRecord) =>
        getAttendanceRecordSortTime(rightRecord) -
        getAttendanceRecordSortTime(leftRecord),
    )[0];

    if (!anchorRecord) return;

    recordsToSyncFine.push(anchorRecord);

    scopeRecords.forEach((record) => {
      if (record.id !== anchorRecord.id) {
        recordIdsToRemoveFinesFrom.push(record.id);
      }
    });
  });

  if (recordIdsToRemoveFinesFrom.length) {
    await client.query(
      `
        DELETE FROM fines
        WHERE attendance_record_id = ANY($1::uuid[])
      `,
      [recordIdsToRemoveFinesFrom],
    );
  }

  for (const record of recordsToSyncFine) {
    const fine = await syncFineForAttendanceRecord(client, record);
    if (fine) fines.push(fine);
  }

  return { records, fines };
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
      SELECT
        ai.*,
        ae.name AS event_name,
        ae.event_order,
        ae.event_start_at,
        ae.event_end_at
      FROM attendance_imports ai
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      WHERE ai.id = $1
      LIMIT 1
    `,
    [importId],
  );

  return result.rows[0] ?? null;
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
                school_year_id = COALESCE(school_year_id, $6),
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
              defaultEvent?.school_year_id ?? await resolveSchoolYearId(client, input.schoolYearId, [input.eventStartAt, input.eventEndAt]),
            ],
          )
        ).rows[0]
      : (
          await client.query<AttendanceImportRecord>(
            `
              INSERT INTO attendance_imports (school_year_id, event_id, file_name, file_type, rows_total, rows_valid, rows_invalid, status)
              VALUES ($1, $2, $3, $4, $5, $6, $7, 'saved')
              RETURNING *
            `,
            [
              defaultEvent?.school_year_id ?? await resolveSchoolYearId(client, input.schoolYearId, [input.eventStartAt, input.eventEndAt]),
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
        event.school_year_id ?? importRecord.school_year_id,
        row,
      );
      savedRecordIds.push(record.id);

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

    const synced = await syncAbsencesForAttendanceRecordIds(
      client,
      savedRecordIds,
    );
    const savedRecords = await listRecordsByIds(client, savedRecordIds);

    await refreshAttendanceFinalResultsWithClient(client, {
      schoolYearId: importRecord.school_year_id ?? undefined,
      importId,
    });

    await refreshPenaltyResultsForSchoolYearWithClient(
      client,
      importRecord.school_year_id ?? undefined,
    );

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

function getManualAttendanceType(input: RawImportRow) {
  const value = cleanText(
    (input as Record<string, unknown>).attendanceType ??
      (input as Record<string, unknown>).attendance_type,
  );

  if (value === "zero_attendance") return "zero_attendance";

  if (
    !cleanText((input as Record<string, unknown>).eventId ?? (input as Record<string, unknown>).event_id) &&
    cleanText((input as Record<string, unknown>).remarks)
      .toLowerCase()
      .includes("zero attendance")
  ) {
    return "zero_attendance";
  }

  return "manual";
}

function getManualRecordSelectSql() {
  return `
    mar.id,
    mar.school_year_id,
    mar.event_id,
    ae.name AS event_name,
    ae.event_order,
    ae.event_start_at,
    ae.event_end_at,
    mar.attendance_type,
    mar.student_id,
    mar.name,
    mar.year_level,
    mar.college,
    mar.program,
    mar.institution,
    mar.no_of_absences,
    mar.remarks,
    mar.scanned_at,
    mar.created_at,
    mar.updated_at
  `;
}

function manualRecordToAttendanceRecord(record: ManualAttendanceRecord): AttendanceRecord {
  return {
    id: record.id,
    school_year_id: record.school_year_id,
    import_id: null,
    event_id: record.event_id,
    event_name: record.event_name ?? null,
    event_order: record.event_order ?? null,
    event_start_at: record.event_start_at ?? null,
    event_end_at: record.event_end_at ?? null,
    student_id: record.student_id,
    name: record.name,
    year_level: record.year_level,
    college: record.college,
    program: record.program,
    institution: record.institution,
    no_of_absences: record.no_of_absences,
    remarks: record.remarks,
    scanned_at: record.scanned_at,
    created_at: record.created_at as Date,
    updated_at: record.updated_at as Date,
  };
}

async function getManualAttendanceEvent(
  client: PoolClient,
  input: RawImportRow,
  attendanceType: "manual" | "zero_attendance",
) {
  if (attendanceType === "zero_attendance") return null;

  const eventId = cleanText(
    (input as Record<string, unknown>).eventId ??
      (input as Record<string, unknown>).event_id,
  );

  if (eventId) {
    const event = await getAttendanceEventById(client, eventId);
    if (!event) throw createValidationError("Attendance event not found.", 404);
    return event;
  }

  throw createValidationError("Please select an existing attendance event for manual attendance.");
}

async function countCollegeEventsForManualRecord(
  client: PoolClient,
  row: ParsedAttendanceRow,
  schoolYearId: string,
) {
  const scopedCount = await client.query<{ total: number }>(
    `
      SELECT COUNT(DISTINCT ae.id)::INT AS total
      FROM attendance_events ae
      WHERE ae.school_year_id = $1
        AND EXISTS (
          SELECT 1
          FROM attendance_records ar
          WHERE ar.event_id = ae.id
            AND LOWER(TRIM(COALESCE(ar.college, ''))) = LOWER(TRIM(COALESCE($2, '')))
            AND LOWER(TRIM(COALESCE(ar.program, ''))) = LOWER(TRIM(COALESCE($3, ar.program, '')))
        )
    `,
    [schoolYearId, row.college ?? "", row.program ?? ""],
  );

  const total = Number(scopedCount.rows[0]?.total ?? 0);
  if (total > 0) return total;

  const fallbackCount = await client.query<{ total: number }>(
    `
      SELECT COUNT(*)::INT AS total
      FROM attendance_events
      WHERE school_year_id = $1
    `,
    [schoolYearId],
  );

  return Number(fallbackCount.rows[0]?.total ?? 0);
}

async function getPenaltyForAbsenceCount(client: PoolClient, noOfAbsences: number) {
  const result = await client.query<{ id: string; prescribed_penalty: string }>(
    `
      SELECT id, prescribed_penalty
      FROM penalties
      WHERE no_of_absences <= $1
      ORDER BY no_of_absences DESC
      LIMIT 1
    `,
    [noOfAbsences],
  );

  return result.rows[0] ?? null;
}

function penaltyResultToFine(record: PenaltyResultRecord): FineRecord {
  return {
    id: record.id,
    school_year_id: record.school_year_id,
    attendance_record_id: null,
    penalty_id: record.penalty_id,
    student_id: record.student_id,
    name: record.name,
    no_of_absences: record.no_of_absences,
    prescribed_penalty: record.prescribed_penalty,
    status: record.status,
    attendance_event_id: null,
    attendance_remarks: record.source_table === "manual_attendance_records" ? "Manual attendance result" : "Final attendance result",
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

async function upsertPenaltyResultForManualRecord(
  client: PoolClient,
  record: ManualAttendanceRecord,
) {
  const noOfAbsences = Number(record.no_of_absences || 0);

  if (noOfAbsences <= 0) {
    await client.query(
      `
        DELETE FROM penalty_results
        WHERE school_year_id = $1
          AND LOWER(TRIM(student_id)) = LOWER(TRIM($2))
      `,
      [record.school_year_id, record.student_id],
    );
    return null;
  }

  const penalty = await getPenaltyForAbsenceCount(client, noOfAbsences);
  const prescribedPenalty = penalty?.prescribed_penalty ?? "No prescribed penalty configured.";
  const result = await client.query<PenaltyResultRecord>(
    `
      INSERT INTO penalty_results (
        school_year_id,
        student_id,
        name,
        no_of_absences,
        penalty_id,
        prescribed_penalty,
        status,
        source_table,
        source_record_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', 'manual_attendance_records', $7)
      ON CONFLICT (school_year_id, (LOWER(TRIM(student_id))))
      DO UPDATE SET
        name = EXCLUDED.name,
        no_of_absences = EXCLUDED.no_of_absences,
        penalty_id = EXCLUDED.penalty_id,
        prescribed_penalty = EXCLUDED.prescribed_penalty,
        source_table = EXCLUDED.source_table,
        source_record_id = EXCLUDED.source_record_id,
        updated_at = NOW()
      RETURNING *
    `,
    [
      record.school_year_id,
      record.student_id,
      record.name,
      noOfAbsences,
      penalty?.id ?? null,
      prescribedPenalty,
      record.id,
    ],
  );

  return result.rows[0];
}

export async function saveManualAttendanceRecord(input: RawImportRow) {
  const row = validateAttendanceInput(input);
  const attendanceType = getManualAttendanceType(input);

  return withTransaction(async (client) => {
    const event = await getManualAttendanceEvent(client, input, attendanceType);
    const schoolYearId =
      event?.school_year_id ??
      (await resolveSchoolYearId(
        client,
        (input as Record<string, unknown>).schoolYearId ??
          (input as Record<string, unknown>).school_year_id,
        [row.scannedAt],
      ));
    const noOfAbsences =
      attendanceType === "zero_attendance"
        ? await countCollegeEventsForManualRecord(client, row, schoolYearId)
        : Math.max(0, Number(row.noOfAbsences ?? 0));

    await upsertStudent(client, {
      ...row,
      noOfAbsences,
    });

    const result = await client.query<ManualAttendanceRecord>(
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
        VALUES ($1, $2, $3, $4, $5, NULLIF($6, ''), NULLIF($7, ''), NULLIF($8, ''), NULLIF($9, ''), $10, NULLIF($11, ''), $12::TIMESTAMPTZ)
        RETURNING *
      `,
      [
        schoolYearId,
        event?.id ?? null,
        attendanceType,
        row.studentId,
        row.name,
        row.yearLevel ?? "",
        row.college ?? "",
        row.program ?? "",
        row.institution ?? "",
        noOfAbsences,
        row.remarks ?? "",
        row.scannedAt ?? null,
      ],
    );
    const manualRecord = result.rows[0];
    const record = manualRecordToAttendanceRecord({
      ...manualRecord,
      event_name: event?.name ?? null,
    });
    const penaltyResult = await upsertPenaltyResultForManualRecord(client, manualRecord);

    return {
      event,
      manualRecord: {
        ...manualRecord,
        event_name: event?.name ?? null,
      },
      record,
      records: [record],
      fine: penaltyResult ? penaltyResultToFine(penaltyResult) : null,
    };
  });
}

export async function updateAttendanceRecords(
  ids: string[],
  input: RawImportRow,
): Promise<UpdatedAttendanceRecordsResult> {
  const row = validateAttendanceInput(input);
  const uniqueIds = uniqueCleanTextValues(ids);

  if (!uniqueIds.length) {
    throw createValidationError("Attendance record IDs are required.");
  }

  return withTransaction(async (client) => {
    const existingResult = await client.query<AttendanceRecord>(
      `
        SELECT *
        FROM attendance_records
        WHERE id = ANY($1::uuid[])
        ORDER BY id
        FOR UPDATE
      `,
      [uniqueIds],
    );
    const existingRecords = existingResult.rows;

    if (existingRecords.length !== uniqueIds.length) {
      throw createValidationError(
        "One or more attendance records were not found.",
        404,
      );
    }

    const existingCollegeScopeKeys = await getAttendanceRecordCollegeScopeKeys(
      client,
      uniqueIds,
    );
    const event = await findOrCreateAttendanceEvent(client, getManualAttendanceEventInput(input));
    await upsertStudent(client, row);

    const updatedResult = await client.query<AttendanceRecord>(
      `
        UPDATE attendance_records
        SET
          school_year_id = $2,
          event_id = $3,
          student_id = $4,
          name = $5,
          year_level = NULLIF($6, ''),
          college = NULLIF($7, ''),
          program = NULLIF($8, ''),
          institution = NULLIF($9, ''),
          no_of_absences = $10,
          scanned_at = $11::TIMESTAMPTZ,
          remarks = NULLIF($12, ''),
          updated_at = NOW()
        WHERE id = ANY($1::uuid[])
        RETURNING *
      `,
      [
        uniqueIds,
        event?.school_year_id ?? await resolveSchoolYearId(client, (input as Record<string, unknown>).schoolYearId ?? (input as Record<string, unknown>).school_year_id, [row.scannedAt]),
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
    const updatedRecords = updatedResult.rows;
    const updatedRecordIds = updatedRecords.map((record) => record.id);
    const updatedCollegeScopeKeys = await getAttendanceRecordCollegeScopeKeys(
      client,
      updatedRecordIds,
    );
    const attendanceSyncCollegeKeys = uniqueTextValues([
      ...existingCollegeScopeKeys,
      ...updatedCollegeScopeKeys,
    ]);

    if (attendanceSyncCollegeKeys.length) {
      const attendanceSynced = await syncAbsencesForAttendanceCollegeScopes(
        client,
        attendanceSyncCollegeKeys,
      );
      const directUpdatedFines = await Promise.all(
        updatedRecords
          .filter((record) => !record.event_id)
          .map((record) => syncFineForAttendanceRecord(client, record)),
      );
      const syncedRecords = uniqueAttendanceRecords(attendanceSynced.records);
      const syncedFines = uniqueFineRecords([
        ...attendanceSynced.fines,
        ...directUpdatedFines,
      ]);
      const refreshedRecordIds = Array.from(
        new Set([
          ...updatedRecordIds,
          ...syncedRecords.map((record) => record.id),
        ]),
      );
      const records = await listRecordsByIds(client, refreshedRecordIds);

      return {
        event,
        records,
        updatedRecordIds,
        fines: filterAttendanceFinesByRecordIds(
          syncedFines,
          refreshedRecordIds,
        ),
      };
    }

    const fines = await Promise.all(
      updatedRecords.map((record) => syncFineForAttendanceRecord(client, record)),
    );
    const records = await listRecordsByIds(client, updatedRecordIds);

    return {
      event,
      records,
      updatedRecordIds,
      fines: filterAttendanceFinesByRecordIds(fines, updatedRecordIds),
    };
  });
}

async function updateManualAttendanceRecord(
  client: PoolClient,
  id: string,
  input: RawImportRow,
) {
  const row = validateAttendanceInput(input);
  const existingResult = await client.query<ManualAttendanceRecord>(
    `
      SELECT ${getManualRecordSelectSql()}
      FROM manual_attendance_records mar
      LEFT JOIN attendance_events ae ON ae.id = mar.event_id
      WHERE mar.id = $1
      LIMIT 1
    `,
    [id],
  );
  const existingRecord = existingResult.rows[0];

  if (!existingRecord) {
    throw createValidationError("Attendance record not found.", 404);
  }

  const attendanceType = existingRecord.attendance_type;
  const event = await getManualAttendanceEvent(client, input, attendanceType);
  const schoolYearId =
    event?.school_year_id ??
    (await resolveSchoolYearId(
      client,
      (input as Record<string, unknown>).schoolYearId ??
        (input as Record<string, unknown>).school_year_id ??
        existingRecord.school_year_id,
      [row.scannedAt, existingRecord.scanned_at],
    ));
  const noOfAbsences = Math.max(0, Number(row.noOfAbsences ?? existingRecord.no_of_absences ?? 0));

  await upsertStudent(client, {
    ...row,
    noOfAbsences,
  });

  const updatedResult = await client.query<ManualAttendanceRecord>(
    `
      UPDATE manual_attendance_records
      SET
        school_year_id = $2,
        event_id = $3,
        student_id = $4,
        name = $5,
        year_level = NULLIF($6, ''),
        college = NULLIF($7, ''),
        program = NULLIF($8, ''),
        institution = NULLIF($9, ''),
        no_of_absences = $10,
        remarks = NULLIF($11, ''),
        scanned_at = $12::TIMESTAMPTZ,
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `,
    [
      id,
      schoolYearId,
      event?.id ?? existingRecord.event_id ?? null,
      row.studentId,
      row.name,
      row.yearLevel ?? "",
      row.college ?? "",
      row.program ?? "",
      row.institution ?? "",
      noOfAbsences,
      row.remarks ?? "",
      row.scannedAt ?? existingRecord.scanned_at ?? null,
    ],
  );
  const manualRecord = updatedResult.rows[0];
  const penaltyResult = await upsertPenaltyResultForManualRecord(client, manualRecord);

  return {
    event,
    manualRecord: {
      ...manualRecord,
      event_name: event?.name ?? existingRecord.event_name ?? null,
    },
    record: manualRecordToAttendanceRecord({
      ...manualRecord,
      event_name: event?.name ?? existingRecord.event_name ?? null,
    }),
    records: [
      manualRecordToAttendanceRecord({
        ...manualRecord,
        event_name: event?.name ?? existingRecord.event_name ?? null,
      }),
    ],
    fine: penaltyResult ? penaltyResultToFine(penaltyResult) : null,
  };
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
      return updateManualAttendanceRecord(client, id, input);
    }

    const existingCollegeScopeKeys = existingRecord.event_id
      ? await getAttendanceRecordCollegeScopeKeys(client, [existingRecord.id])
      : [];
    const event = await findOrCreateAttendanceEvent(client, getManualAttendanceEventInput(input));
    await upsertStudent(client, row);

    const updatedResult = await client.query<AttendanceRecord>(
      `
        UPDATE attendance_records
        SET
          school_year_id = $2,
          event_id = $3,
          student_id = $4,
          name = $5,
          year_level = NULLIF($6, ''),
          college = NULLIF($7, ''),
          program = NULLIF($8, ''),
          institution = NULLIF($9, ''),
          no_of_absences = $10,
          scanned_at = $11::TIMESTAMPTZ,
          remarks = NULLIF($12, ''),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        event?.school_year_id ?? existingRecord.school_year_id ?? await resolveSchoolYearId(client, (input as Record<string, unknown>).schoolYearId ?? (input as Record<string, unknown>).school_year_id, [row.scannedAt]),
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

    const updatedCollegeScopeKeys = record.event_id
      ? await getAttendanceRecordCollegeScopeKeys(client, [record.id])
      : [];
    const attendanceSyncCollegeKeys = uniqueTextValues([
      ...existingCollegeScopeKeys,
      ...updatedCollegeScopeKeys,
    ]);

    if (attendanceSyncCollegeKeys.length) {
      const attendanceSynced = await syncAbsencesForAttendanceCollegeScopes(
        client,
        attendanceSyncCollegeKeys,
      );
      const directUpdatedFine = !record.event_id
        ? await syncFineForAttendanceRecord(client, record)
        : null;
      const syncedFines = uniqueFineRecords([
        ...attendanceSynced.fines,
        directUpdatedFine,
      ]);
      const updatedRecord =
        (await listRecordsByIds(client, [record.id]))[0] ?? record;
      const fine =
        syncedFines.find((item) => item.attendance_record_id === record.id) ??
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

    const collegeScopeKeys = record.event_id
      ? await getAttendanceRecordCollegeScopeKeys(client, [record.id])
      : [];

    await client.query("DELETE FROM fines WHERE attendance_record_id = $1", [
      id,
    ]);
    await client.query("DELETE FROM attendance_records WHERE id = $1", [id]);

    if (record.event_id) {
      await syncAbsencesForAttendanceCollegeScopes(client, collegeScopeKeys);
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

    const collegeScopeKeys = await getAttendanceImportCollegeScopeKeys(client, [
      importId,
    ]);

    await deleteAttendanceImportRecords(client, [importId]);
    await syncAbsencesForAttendanceCollegeScopes(client, collegeScopeKeys);

    return importRecord;
  });
}

export async function deleteAttendanceImports(): Promise<DeletedAttendanceImportsResult> {
  return withTransaction(async (client) => {
    const importsResult = await client.query<AttendanceImportRecord>(
      `
        SELECT
          ai.*,
          ae.name AS event_name,
          ae.event_order,
          ae.event_start_at,
          ae.event_end_at
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

    const collegeScopeKeys = await getAttendanceImportCollegeScopeKeys(
      client,
      importIds,
    );

    await deleteAttendanceImportRecords(client, importIds);
    await syncAbsencesForAttendanceCollegeScopes(client, collegeScopeKeys);

    return {
      deletedCount: deletedImports.length,
      deletedImports,
    };
  });
}

export async function listAttendanceEvents(limit = 100, offset = 0, schoolYearId?: string) {
  const result = await query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      ${schoolYearId ? "WHERE e.school_year_id = $3" : ""}
      GROUP BY e.id
      ORDER BY e.event_order ASC NULLS LAST, COALESCE(e.event_start_at, e.event_end_at, e.created_at) ASC, e.created_at ASC
      LIMIT $1 OFFSET $2
    `,
    schoolYearId ? [limit, offset, schoolYearId] : [limit, offset],
  );

  return result.rows;
}

export async function createAttendanceEvent(input: AttendanceEventInput) {
  const eventInput = getEventInput(input);

  if (!eventInput.name) {
    throw createValidationError("Event name is required.");
  }

  return withTransaction(async (client) => {
    const schoolYearId = await resolveSchoolYearId(client, eventInput.schoolYearId, [
      eventInput.eventStartAt,
      eventInput.eventEndAt,
    ]);
    const eventCount = await getAttendanceEventCount(client, schoolYearId);
    const eventOrder = eventInput.eventOrder
      ? Math.min(eventInput.eventOrder, eventCount + 1)
      : eventCount + 1;

    if (eventInput.eventOrder) {
      await shiftAttendanceEventOrderForInsert(client, schoolYearId, eventOrder);
    }

    const result = await client.query<AttendanceEventRecord>(
      `
        INSERT INTO attendance_events (
          school_year_id,
          name,
          event_start_at,
          event_end_at,
          description,
          event_order
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *, 0::INT AS attendees_count
      `,
      [
        schoolYearId,
        eventInput.name,
        eventInput.eventStartAt,
        eventInput.eventEndAt,
        eventInput.description,
        eventOrder,
      ],
    );

    await resequenceAttendanceEvents(client, schoolYearId);

    return (await getAttendanceEventById(client, result.rows[0].id)) ?? result.rows[0];
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

    const nextSchoolYearId = eventInput.schoolYearId
      ? await resolveSchoolYearId(client, eventInput.schoolYearId, [
          eventInput.eventStartAt,
          eventInput.eventEndAt,
        ])
      : existing.school_year_id;
    const schoolYearChanged = nextSchoolYearId !== existing.school_year_id;
    const eventCount = await getAttendanceEventCount(client, nextSchoolYearId);
    const currentOrder = Number(existing.event_order || 0) || null;
    const maxOrder = schoolYearChanged ? eventCount + 1 : Math.max(1, eventCount);
    const requestedOrder = eventInput.eventOrder
      ? Math.min(eventInput.eventOrder, maxOrder)
      : null;
    const nextOrder = requestedOrder ?? (schoolYearChanged ? eventCount + 1 : currentOrder ?? eventCount + 1);

    if (schoolYearChanged) {
      await shiftAttendanceEventOrderForInsert(client, nextSchoolYearId, nextOrder);
    } else if (requestedOrder && requestedOrder !== currentOrder) {
      await moveAttendanceEventOrder(client, {
        eventId: id,
        schoolYearId: nextSchoolYearId,
        currentOrder,
        nextOrder: requestedOrder,
      });
    }

    const result = await client.query<AttendanceEventRecord>(
      `
        UPDATE attendance_events
        SET
          school_year_id = $2,
          name = $3,
          event_start_at = $4,
          event_end_at = $5,
          description = $6,
          event_order = $7,
          updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `,
      [
        id,
        nextSchoolYearId,
        eventInput.name,
        eventInput.eventStartAt,
        eventInput.eventEndAt,
        eventInput.description,
        nextOrder,
      ],
    );

    if (schoolYearChanged) {
      await resequenceAttendanceEvents(client, existing.school_year_id);
    }

    await resequenceAttendanceEvents(client, nextSchoolYearId);

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

    const collegeScopeKeys = await getAttendanceEventCollegeScopeKeys(client, [
      id,
    ]);

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
    await resequenceAttendanceEvents(client, existing.school_year_id);
    await syncAbsencesForAttendanceCollegeScopes(client, collegeScopeKeys);

    return existing;
  });
}

export async function listAttendanceRecords(
  limit = 100,
  offset = 0,
  studentId?: string,
  eventId?: string,
  college?: string,
  schoolYearId?: string,
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

  if (schoolYearId) {
    params.push(schoolYearId);
    clauses.push(`ar.school_year_id = $${params.length}`);
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
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, ar.scanned_at, ar.created_at) ASC,
        COALESCE(ar.scanned_at, ar.created_at) ASC,
        ar.created_at ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}

export async function listAttendanceImports(limit = 50, offset = 0, schoolYearId?: string) {
  const result = await query<AttendanceImportRecord>(
    `
      SELECT
        ai.*,
        ae.name AS event_name,
        ae.event_order,
        ae.event_start_at,
        ae.event_end_at
      FROM attendance_imports ai
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      ${schoolYearId ? "WHERE ai.school_year_id = $3" : ""}
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, ai.created_at) ASC,
        ai.created_at ASC
      LIMIT $1 OFFSET $2
    `,
    schoolYearId ? [limit, offset, schoolYearId] : [limit, offset],
  );

  return result.rows;
}

export async function getAttendanceImport(importId: string) {
  const importResult = await query<AttendanceImportRecord>(
    `
      SELECT
        ai.*,
        ae.name AS event_name,
        ae.event_order,
        ae.event_start_at,
        ae.event_end_at
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
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, ar.scanned_at, ar.created_at) ASC,
        COALESCE(ar.scanned_at, ar.created_at) ASC,
        ar.created_at ASC
    `,
    [importId],
  );

  return {
    import: importResult.rows[0],
    records: recordsResult.rows,
  };
}



type CalculationResultsFilter = {
  schoolYearId?: string;
  importIds?: string[];
  studentId?: string;
  college?: string;
  limit?: number;
  offset?: number;
};

function normalizeImportIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

function getCalculationScopeKey(importIds: string[]) {
  return importIds.length ? importIds.join(":") : "all_imports";
}

async function refreshCalculationResultsWithClient(
  client: PoolClient,
  options: Pick<CalculationResultsFilter, "schoolYearId" | "importIds"> = {},
) {
  const schoolYearId = cleanText(options.schoolYearId) || null;
  const importIds = normalizeImportIds(options.importIds ?? []);
  const calculationScopeKey = getCalculationScopeKey(importIds);

  await client.query(
    `
      DELETE FROM calculation_results
      WHERE ($1::uuid IS NULL OR school_year_id = $1::uuid)
        AND calculation_scope_key = $2::TEXT
    `,
    [schoolYearId, calculationScopeKey],
  );

  const result = await client.query<CalculationResultRecord>(
    `
      WITH imported_records AS (
        SELECT
          ar.school_year_id,
          ar.import_id,
          ar.student_id,
          COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(ar.name), ''), ar.student_id) AS name,
          COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(ar.year_level), '')) AS year_level,
          COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')) AS college,
          COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(ar.program), '')) AS program,
          COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(ar.institution), '')) AS institution,
          COALESCE(ar.event_id::TEXT, NULLIF(TRIM(ae.name), ''), ar.id::TEXT) AS event_key,
          GREATEST(0, COALESCE(ar.no_of_absences, 0))::INT AS no_of_absences,
          COALESCE(ar.scanned_at, ar.created_at) AS scanned_at,
          ar.updated_at
        FROM attendance_records ar
        LEFT JOIN attendance_events ae ON ae.id = ar.event_id
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        WHERE ar.import_id IS NOT NULL
          AND ($1::uuid IS NULL OR ar.school_year_id = $1::uuid)
          AND (
            cardinality($2::uuid[]) = 0
            OR ar.import_id = ANY($2::uuid[])
          )
      ), imported_totals AS (
        SELECT
          school_year_id,
          LOWER(TRIM(student_id)) AS normalized_student_id,
          MAX(student_id) AS student_id,
          MAX(name) AS name,
          MAX(year_level) AS year_level,
          MAX(college) AS college,
          MAX(program) AS program,
          MAX(institution) AS institution,
          COUNT(DISTINCT event_key)::INT AS attended_events,
          GREATEST(0, MAX(no_of_absences))::INT AS imported_absences,
          COUNT(*)::INT AS imported_record_count,
          MAX(scanned_at) AS latest_scanned_at,
          MAX(updated_at) AS source_updated_at
        FROM imported_records
        GROUP BY school_year_id, LOWER(TRIM(student_id))
      ), manual_totals AS (
        SELECT
          mar.school_year_id,
          LOWER(TRIM(mar.student_id)) AS normalized_student_id,
          MAX(mar.student_id) AS student_id,
          COALESCE(NULLIF(MAX(s.name), ''), NULLIF(MAX(mar.name), ''), MAX(mar.student_id)) AS name,
          COALESCE(NULLIF(MAX(s.year_level), ''), NULLIF(MAX(mar.year_level), '')) AS year_level,
          COALESCE(NULLIF(MAX(s.college), ''), NULLIF(MAX(mar.college), '')) AS college,
          COALESCE(NULLIF(MAX(s.program), ''), NULLIF(MAX(mar.program), '')) AS program,
          COALESCE(NULLIF(MAX(s.institution), ''), NULLIF(MAX(mar.institution), '')) AS institution,
          GREATEST(0, SUM(COALESCE(mar.no_of_absences, 0)))::INT AS manual_absences,
          COUNT(*)::INT AS manual_record_count,
          MAX(COALESCE(mar.scanned_at, mar.created_at)) AS latest_scanned_at,
          MAX(mar.updated_at) AS source_updated_at
        FROM manual_attendance_records mar
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
        WHERE ($1::uuid IS NULL OR mar.school_year_id = $1::uuid)
        GROUP BY mar.school_year_id, LOWER(TRIM(mar.student_id))
      ), student_keys AS (
        SELECT school_year_id, normalized_student_id FROM imported_totals
        UNION
        SELECT school_year_id, normalized_student_id FROM manual_totals
      ), merged AS (
        SELECT
          keys.school_year_id,
          $3::TEXT AS calculation_scope_key,
          $2::uuid[] AS import_ids,
          COALESCE(imported.student_id, manual.student_id, keys.normalized_student_id) AS student_id,
          COALESCE(imported.name, manual.name, keys.normalized_student_id) AS name,
          COALESCE(imported.year_level, manual.year_level) AS year_level,
          COALESCE(imported.college, manual.college) AS college,
          COALESCE(imported.program, manual.program) AS program,
          COALESCE(imported.institution, manual.institution) AS institution,
          COALESCE(imported.attended_events, 0)::INT AS attended_events,
          COALESCE(imported.imported_absences, 0)::INT AS imported_absences,
          COALESCE(manual.manual_absences, 0)::INT AS manual_absences,
          (
            COALESCE(imported.imported_absences, 0) +
            COALESCE(manual.manual_absences, 0)
          )::INT AS total_absences,
          (
            COALESCE(imported.imported_record_count, 0) +
            COALESCE(manual.manual_record_count, 0)
          )::INT AS source_record_count,
          GREATEST(
            COALESCE(imported.latest_scanned_at, '-infinity'::timestamptz),
            COALESCE(manual.latest_scanned_at, '-infinity'::timestamptz)
          ) AS latest_scanned_at,
          GREATEST(
            COALESCE(imported.source_updated_at, '-infinity'::timestamptz),
            COALESCE(manual.source_updated_at, '-infinity'::timestamptz)
          ) AS source_updated_at
        FROM student_keys keys
        LEFT JOIN imported_totals imported
          ON imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND imported.normalized_student_id = keys.normalized_student_id
        LEFT JOIN manual_totals manual
          ON manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND manual.normalized_student_id = keys.normalized_student_id
      ), matched AS (
        SELECT
          merged.*,
          penalty.id AS penalty_id,
          penalty.prescribed_penalty
        FROM merged
        LEFT JOIN LATERAL (
          SELECT id, prescribed_penalty
          FROM penalties
          WHERE no_of_absences <= merged.total_absences
          ORDER BY no_of_absences DESC
          LIMIT 1
        ) penalty ON merged.total_absences > 0
      )
      INSERT INTO calculation_results (
        school_year_id,
        calculation_scope_key,
        import_ids,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        attended_events,
        imported_absences,
        manual_absences,
        total_absences,
        attendance_status,
        penalty_id,
        prescribed_penalty,
        source_record_count,
        latest_scanned_at,
        source_updated_at,
        calculated_at
      )
      SELECT
        school_year_id,
        calculation_scope_key,
        import_ids,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        attended_events,
        imported_absences,
        manual_absences,
        total_absences,
        CASE
          WHEN total_absences <= 0 THEN 'perfect_attendance'
          ELSE 'with_absences'
        END,
        penalty_id,
        CASE
          WHEN total_absences <= 0 THEN NULL
          ELSE COALESCE(prescribed_penalty, 'No prescribed penalty configured.')
        END,
        source_record_count,
        NULLIF(latest_scanned_at, '-infinity'::timestamptz),
        NULLIF(source_updated_at, '-infinity'::timestamptz),
        NOW()
      FROM matched
      ON CONFLICT (school_year_id, calculation_scope_key, (LOWER(TRIM(student_id))))
      DO UPDATE SET
        import_ids = EXCLUDED.import_ids,
        name = EXCLUDED.name,
        year_level = EXCLUDED.year_level,
        college = EXCLUDED.college,
        program = EXCLUDED.program,
        institution = EXCLUDED.institution,
        attended_events = EXCLUDED.attended_events,
        imported_absences = EXCLUDED.imported_absences,
        manual_absences = EXCLUDED.manual_absences,
        total_absences = EXCLUDED.total_absences,
        attendance_status = EXCLUDED.attendance_status,
        penalty_id = EXCLUDED.penalty_id,
        prescribed_penalty = EXCLUDED.prescribed_penalty,
        source_record_count = EXCLUDED.source_record_count,
        latest_scanned_at = EXCLUDED.latest_scanned_at,
        source_updated_at = EXCLUDED.source_updated_at,
        calculated_at = NOW(),
        updated_at = NOW()
      RETURNING *
    `,
    [schoolYearId, importIds, calculationScopeKey],
  );

  return result.rows;
}

export async function refreshCalculationResults(
  options: Pick<CalculationResultsFilter, "schoolYearId" | "importIds"> = {},
) {
  return withTransaction(async (client) => {
    const importIds = normalizeImportIds(options.importIds ?? []);
    const rows = await refreshCalculationResultsWithClient(client, {
      schoolYearId: options.schoolYearId,
      importIds,
    });
    await refreshPenaltyResultsForSchoolYearWithClient(
      client,
      options.schoolYearId,
      getCalculationScopeKey(importIds),
    );

    return rows;
  });
}

export async function listCalculationResults(
  options: CalculationResultsFilter = {},
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`cr.school_year_id = $${params.length}`);
  }

  const importIds = normalizeImportIds(options.importIds ?? []);
  if (importIds.length) {
    params.push(getCalculationScopeKey(importIds));
    clauses.push(`cr.calculation_scope_key = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(cr.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(`LOWER(TRIM(COALESCE(cr.college, ''))) = LOWER(TRIM($${params.length}))`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<CalculationResultRecord>(
    `
      SELECT
        cr.*,
        event_scope.event_order,
        event_scope.event_start_at,
        event_scope.event_end_at
      FROM calculation_results cr
      LEFT JOIN LATERAL (
        SELECT
          MIN(ae.event_order) AS event_order,
          MIN(ae.event_start_at) AS event_start_at,
          MIN(ae.event_end_at) AS event_end_at,
          MIN(COALESCE(ae.event_start_at, ae.event_end_at, ai.created_at)) AS event_sort_at
        FROM attendance_imports ai
        LEFT JOIN attendance_events ae ON ae.id = ai.event_id
        WHERE ai.id = ANY(cr.import_ids)
      ) event_scope ON TRUE
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        event_scope.event_order ASC NULLS LAST,
        event_scope.event_sort_at ASC NULLS LAST,
        cr.calculated_at DESC,
        cr.updated_at DESC,
        cr.student_id ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}


type AttendanceFinalResultsFilter = {
  schoolYearId?: string;
  importId?: string;
  studentId?: string;
  college?: string;
  limit?: number;
  offset?: number;
};

async function refreshAttendanceFinalResultsWithClient(
  client: PoolClient,
  options: Pick<AttendanceFinalResultsFilter, "schoolYearId" | "importId"> = {},
) {
  const clauses: string[] = ["ar.import_id IS NOT NULL"];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`ar.school_year_id = $${params.length}`);
  }

  if (options.importId) {
    params.push(options.importId);
    clauses.push(`ar.import_id = $${params.length}`);
  }

  const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  await client.query(
    `
      DELETE FROM attendance_final_results afr
      WHERE EXISTS (
        SELECT 1
        FROM attendance_records ar
        ${whereSql}
          AND ar.school_year_id IS NOT DISTINCT FROM afr.school_year_id
          AND ar.import_id IS NOT DISTINCT FROM afr.import_id
      )
    `,
    params,
  );

  const result = await client.query<AttendanceFinalResultRecord>(
    `
      INSERT INTO attendance_final_results (
        school_year_id,
        import_id,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        attended_events,
        total_absences,
        attendance_status,
        latest_scanned_at,
        source_updated_at
      )
      SELECT
        ar.school_year_id,
        ar.import_id,
        ar.student_id,
        COALESCE(NULLIF(MAX(s.name), ''), NULLIF(MAX(ar.name), ''), ar.student_id) AS name,
        COALESCE(NULLIF(MAX(s.year_level), ''), NULLIF(MAX(ar.year_level), '')) AS year_level,
        COALESCE(NULLIF(MAX(s.college), ''), NULLIF(MAX(ar.college), '')) AS college,
        COALESCE(NULLIF(MAX(s.program), ''), NULLIF(MAX(ar.program), '')) AS program,
        COALESCE(NULLIF(MAX(s.institution), ''), NULLIF(MAX(ar.institution), '')) AS institution,
        COUNT(DISTINCT COALESCE(ar.event_id::TEXT, NULLIF(TRIM(ae.name), ''), ar.id::TEXT))::INT AS attended_events,
        GREATEST(0, MAX(COALESCE(ar.no_of_absences, 0)))::INT AS total_absences,
        CASE
          WHEN GREATEST(0, MAX(COALESCE(ar.no_of_absences, 0)))::INT <= 0 THEN 'perfect_attendance'
          ELSE 'with_absences'
        END AS attendance_status,
        MAX(COALESCE(ar.scanned_at, ar.created_at)) AS latest_scanned_at,
        MAX(ar.updated_at) AS source_updated_at
      FROM attendance_records ar
      LEFT JOIN attendance_events ae ON ae.id = ar.event_id
      LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
      ${whereSql}
      GROUP BY ar.school_year_id, ar.import_id, ar.student_id
      ON CONFLICT (school_year_id, import_id, (LOWER(TRIM(student_id))))
      DO UPDATE SET
        name = EXCLUDED.name,
        year_level = EXCLUDED.year_level,
        college = EXCLUDED.college,
        program = EXCLUDED.program,
        institution = EXCLUDED.institution,
        attended_events = EXCLUDED.attended_events,
        total_absences = EXCLUDED.total_absences,
        attendance_status = EXCLUDED.attendance_status,
        latest_scanned_at = EXCLUDED.latest_scanned_at,
        source_updated_at = EXCLUDED.source_updated_at,
        updated_at = NOW()
      RETURNING *
    `,
    params,
  );

  return result.rows;
}

async function refreshPenaltyResultsForSchoolYearWithClient(
  client: PoolClient,
  schoolYearId?: string,
  calculationScopeKey?: string,
) {
  const result = await client.query<PenaltyResultRecord>(
    `
      WITH totals AS (
        SELECT
          school_year_id,
          student_id,
          name,
          total_absences::INT AS no_of_absences,
          penalty_id,
          COALESCE(prescribed_penalty, 'No prescribed penalty configured.') AS prescribed_penalty,
          'calculation_results'::TEXT AS source_table,
          id AS source_record_id
        FROM calculation_results
        WHERE ($1::uuid IS NULL OR school_year_id = $1::uuid)
          AND ($2::TEXT IS NULL OR calculation_scope_key = $2::TEXT)
          AND total_absences > 0
      )
      INSERT INTO penalty_results (
        school_year_id,
        student_id,
        name,
        no_of_absences,
        penalty_id,
        prescribed_penalty,
        status,
        source_table,
        source_record_id
      )
      SELECT
        school_year_id,
        student_id,
        name,
        no_of_absences,
        penalty_id,
        prescribed_penalty,
        'unpaid',
        source_table,
        source_record_id
      FROM totals
      ON CONFLICT (school_year_id, (LOWER(TRIM(student_id))))
      DO UPDATE SET
        name = EXCLUDED.name,
        no_of_absences = EXCLUDED.no_of_absences,
        penalty_id = EXCLUDED.penalty_id,
        prescribed_penalty = EXCLUDED.prescribed_penalty,
        source_table = EXCLUDED.source_table,
        source_record_id = EXCLUDED.source_record_id,
        updated_at = NOW()
      RETURNING *
    `,
    [schoolYearId ?? null, calculationScopeKey ?? null],
  );

  await client.query(
    `
      DELETE FROM penalty_results pr
      WHERE ($1::uuid IS NULL OR pr.school_year_id = $1::uuid)
        AND pr.source_table = 'calculation_results'
        AND NOT EXISTS (
          SELECT 1
          FROM calculation_results cr
          WHERE cr.school_year_id IS NOT DISTINCT FROM pr.school_year_id
            AND LOWER(TRIM(cr.student_id)) = LOWER(TRIM(pr.student_id))
            AND cr.total_absences > 0
            AND ($2::TEXT IS NULL OR cr.calculation_scope_key = $2::TEXT)
        )
    `,
    [schoolYearId ?? null, calculationScopeKey ?? null],
  );

  return result.rows;
}

export async function refreshAttendanceFinalResults(
  options: Pick<AttendanceFinalResultsFilter, "schoolYearId" | "importId"> = {},
) {
  return withTransaction(async (client) => {
    const rows = await refreshAttendanceFinalResultsWithClient(client, options);
    await refreshPenaltyResultsForSchoolYearWithClient(client, options.schoolYearId);
    return rows;
  });
}

export async function listAttendanceFinalResults(
  options: AttendanceFinalResultsFilter = {},
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`afr.school_year_id = $${params.length}`);
  }

  if (options.importId) {
    params.push(options.importId);
    clauses.push(`afr.import_id = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(afr.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(`LOWER(TRIM(COALESCE(afr.college, ''))) = LOWER(TRIM($${params.length}))`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<AttendanceFinalResultRecord>(
    `
      SELECT
        afr.*,
        ai.event_id,
        ae.name AS event_name,
        ae.event_order,
        ae.event_start_at,
        ae.event_end_at
      FROM attendance_final_results afr
      LEFT JOIN attendance_imports ai ON ai.id = afr.import_id
      LEFT JOIN attendance_events ae ON ae.id = ai.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, afr.latest_scanned_at, afr.created_at) ASC,
        afr.student_id ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}

export async function listManualAttendanceRecords(
  options: AttendanceFinalResultsFilter & { eventId?: string } = {},
) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (options.schoolYearId) {
    params.push(options.schoolYearId);
    clauses.push(`mar.school_year_id = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(mar.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(`LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($${params.length}))`);
  }

  if (options.eventId) {
    params.push(options.eventId);
    clauses.push(`mar.event_id = $${params.length}`);
  }

  params.push(options.limit ?? 100);
  const limitPosition = params.length;

  params.push(options.offset ?? 0);
  const offsetPosition = params.length;

  const result = await query<ManualAttendanceRecord>(
    `
      SELECT ${getManualRecordSelectSql()}
      FROM manual_attendance_records mar
      LEFT JOIN attendance_events ae ON ae.id = mar.event_id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY
        ae.event_order ASC NULLS LAST,
        COALESCE(ae.event_start_at, ae.event_end_at, mar.scanned_at, mar.created_at) ASC,
        COALESCE(mar.scanned_at, mar.created_at) ASC,
        mar.created_at ASC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params,
  );

  return result.rows;
}