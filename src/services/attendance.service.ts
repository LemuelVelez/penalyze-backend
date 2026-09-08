import path from "path";
import { PoolClient } from "pg";

import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceDetectedEventMetadata,
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

const ZERO_ATTENDANCE_REMARK =
  "Zero attendance registration from landing page.";

declare const require: any;

export type UploadedAttendanceFile = {
  originalname: string;
  mimetype?: string;
  buffer: Buffer;
  size?: number;
};

type RawImportRow = Record<string, unknown>;
type CalculationSourceType = "imported" | "manual" | "zero_attendance";

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

export type DeletedAttendanceFinalResultsResult = {
  deletedCount: number;
  deletedRecords: AttendanceFinalResultRecord[];
};

export type DeletedCalculationResultsResult = {
  deletedCount: number;
  deletedRecords: CalculationResultRecord[];
};

export type DeletedManualAttendanceRecordsResult = {
  deletedCount: number;
  deletedRecords: ManualAttendanceRecord[];
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
    "first scan at",
    "first_scan_at",
    "last scan at",
    "last_scan_at",
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

type AttendanceMetadataKey = keyof AttendanceDetectedEventMetadata;

const ATTENDANCE_METADATA_ALIASES: Record<
  AttendanceMetadataKey,
  readonly string[]
> = {
  eventName: ["event", "event name", "activity", "activity name"],
  eventStartAt: [
    "start",
    "start date/time",
    "start datetime",
    "start date time",
    "event start",
    "event start at",
    "event start date",
    "event start date time",
    "start date",
    "date start",
  ],
  eventEndAt: [
    "end",
    "end date/time",
    "end datetime",
    "end date time",
    "event end",
    "event end at",
    "event end date",
    "event end date time",
    "end date",
    "date end",
  ],
  schoolYearLabel: [
    "s.y.",
    "s.y",
    "sy",
    "school year",
    "schoolyear",
    "academic year",
  ],
};

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
    .replace(/[\u00A0\u202F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanOptionalText(value: unknown) {
  const text = cleanText(value);
  return text || null;
}

function normalizeAttendanceEventName(value: unknown) {
  return cleanText(value)
    .replace(/\s*\([^()]*\)\s*$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function createEmptyDetectedAttendanceEvent(): AttendanceDetectedEventMetadata {
  return {
    eventName: null,
    eventStartAt: null,
    eventEndAt: null,
    schoolYearLabel: null,
  };
}

function getAttendanceMetadataKey(value: unknown): AttendanceMetadataKey | "" {
  const normalizedValue = normalizeHeader(value).replace(/[.:]+$/, "");

  for (const [key, aliases] of Object.entries(
    ATTENDANCE_METADATA_ALIASES,
  ) as [AttendanceMetadataKey, readonly string[]][]) {
    if (
      aliases.some(
        (alias) => normalizeHeader(alias).replace(/[.:]+$/, "") === normalizedValue,
      )
    ) {
      return key;
    }
  }

  return "";
}

function setDetectedAttendanceEventValue(
  metadata: AttendanceDetectedEventMetadata,
  key: AttendanceMetadataKey,
  value: unknown,
) {
  if (metadata[key] || !cleanText(value)) return;

  if (key === "eventStartAt" || key === "eventEndAt") {
    const normalized = normalizeOptionalTimestamp(
      value,
      key === "eventStartAt" ? "Event start at" : "Event end at",
    );

    if (!normalized.error && normalized.value) {
      metadata[key] = normalized.value;
    }
    return;
  }

  metadata[key] = cleanText(value);
}

function mergeDetectedAttendanceEvents(
  primary: AttendanceDetectedEventMetadata,
  fallback: AttendanceDetectedEventMetadata,
): AttendanceDetectedEventMetadata {
  return {
    eventName: primary.eventName || fallback.eventName,
    eventStartAt: primary.eventStartAt || fallback.eventStartAt,
    eventEndAt: primary.eventEndAt || fallback.eventEndAt,
    schoolYearLabel: primary.schoolYearLabel || fallback.schoolYearLabel,
  };
}

function getDetectedAttendanceEventFromRows(
  rows: ParsedAttendanceRow[],
): AttendanceDetectedEventMetadata {
  const metadata = createEmptyDetectedAttendanceEvent();
  const metadataRow =
    rows.find(
      (row) =>
        row.errors.length === 0 &&
        (row.eventName || row.eventStartAt || row.eventEndAt),
    ) ?? rows.find((row) => row.eventName || row.eventStartAt || row.eventEndAt);

  if (!metadataRow) return metadata;

  metadata.eventName = cleanOptionalText(metadataRow.eventName);
  metadata.eventStartAt = cleanOptionalText(metadataRow.eventStartAt);
  metadata.eventEndAt = cleanOptionalText(metadataRow.eventEndAt);
  return metadata;
}

function findAttendanceStudentHeaderRowIndex(rows: unknown[][]) {
  return rows.findIndex((row) => {
    const headers = row.map(normalizeHeader).filter(Boolean);
    return hasAttendanceStudentHeaders(headers);
  });
}

function detectAttendanceWorksheetMetadata(
  rows: unknown[][],
  studentHeaderRowIndex: number,
) {
  const metadata = createEmptyDetectedAttendanceEvent();
  const metadataRowCount =
    studentHeaderRowIndex >= 0
      ? studentHeaderRowIndex
      : Math.min(rows.length, 80);

  for (let rowIndex = 0; rowIndex < metadataRowCount; rowIndex += 1) {
    const row = rows[rowIndex] ?? [];
    const nextRow = rows[rowIndex + 1] ?? [];
    const rowKeys = row.map(getAttendanceMetadataKey);

    row.forEach((cell, cellIndex) => {
      const cellText = cleanText(cell);
      const keyValueMatch = cellText.match(/^([^:=]+?)\s*[:=]\s*(.+)$/);

      if (keyValueMatch) {
        const inlineKey = getAttendanceMetadataKey(keyValueMatch[1]);
        if (inlineKey) {
          setDetectedAttendanceEventValue(
            metadata,
            inlineKey,
            keyValueMatch[2],
          );
          return;
        }
      }

      const key = rowKeys[cellIndex];
      if (!key) return;

      const adjacentValue = row[cellIndex + 1];
      if (
        cleanText(adjacentValue) &&
        !getAttendanceMetadataKey(adjacentValue)
      ) {
        setDetectedAttendanceEventValue(metadata, key, adjacentValue);
      }
    });

    rowKeys.forEach((key, cellIndex) => {
      if (!key) return;

      const valueBelow = nextRow[cellIndex];
      if (cleanText(valueBelow) && !getAttendanceMetadataKey(valueBelow)) {
        setDetectedAttendanceEventValue(metadata, key, valueBelow);
      }
    });
  }

  return metadata;
}

function getFileNameWithoutExtension(fileName: string) {
  const extension = path.extname(fileName || "");
  return path.basename(fileName || "", extension).trim();
}

function getFileExtension(fileName: string) {
  return path.extname(fileName || "").toLowerCase();
}

function ensureSupportedFile(fileName: string) {
  const extension = getFileExtension(fileName);

  if (!ACCEPTED_ATTENDANCE_EXTENSIONS.includes(extension as any)) {
    throw new Error("Unsupported file. Please upload an .xlsx file.");
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

function hasAttendanceStudentHeaders(headers: string[]) {
  return (
    headers.some((header) =>
      HEADER_ALIASES.studentId.includes(header as any),
    ) && headers.some((header) => HEADER_ALIASES.name.includes(header as any))
  );
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
  detectedEvent: AttendanceDetectedEventMetadata =
    createEmptyDetectedAttendanceEvent(),
): AttendancePreviewResult {
  const rows = normalizeImportRows(rawRows);
  const rowsValid = rows.filter((row) => row.errors.length === 0).length;
  const rowsInvalid = rows.length - rowsValid;
  const rowDetectedEvent = getDetectedAttendanceEventFromRows(rows);

  return {
    fileName,
    fileType,
    rowsTotal: rows.length,
    rowsValid,
    rowsInvalid,
    rows,
    detectedEvent: mergeDetectedAttendanceEvents(
      detectedEvent,
      rowDetectedEvent,
    ),
  };
}

function getRawImportRowHeaders(rows: RawImportRow[]) {
  const headers = new Set<string>();

  rows.forEach((row) => {
    Object.keys(row ?? {}).forEach((key) => {
      const header = normalizeHeader(key);
      if (header) headers.add(header);
    });
  });

  return Array.from(headers);
}

function getAttendanceSheetPriority(sheetName: string) {
  const normalizedName = normalizeHeader(sheetName);

  if (/^raw\s*scans?$/.test(normalizedName)) return 1;
  if (/^student\s*totals?$/.test(normalizedName)) return 2;
  if (normalizedName.includes("raw") && normalizedName.includes("scan"))
    return 1;
  if (normalizedName.includes("student") && normalizedName.includes("total")) {
    return 2;
  }

  return 3;
}

function scoreAttendanceSheetRows(sheetName: string, rows: RawImportRow[]) {
  const headers = getRawImportRowHeaders(rows);

  if (!hasAttendanceStudentHeaders(headers)) return 0;

  const hasScannedAt = headers.some((header) =>
    HEADER_ALIASES.scannedAt.includes(header as any),
  );
  const hasEventName = headers.some((header) =>
    HEADER_ALIASES.eventName.includes(header as any),
  );
  const priority = getAttendanceSheetPriority(sheetName);
  const priorityScore = priority === 1 ? 30000 : priority === 2 ? 20000 : 10000;

  return (
    priorityScore +
    (hasScannedAt ? 5000 : 0) +
    (hasEventName ? 1000 : 0) +
    rows.length
  );
}

async function parseExcelFile(file: UploadedAttendanceFile) {
  const XLSX = loadRequiredModule<any>("xlsx");
  const workbook = XLSX.read(file.buffer, { type: "buffer", cellDates: false });
  const sheetNames = workbook.SheetNames ?? [];

  if (!sheetNames.length) {
    return {
      rawRows: [] as RawImportRow[],
      detectedEvent: createEmptyDetectedAttendanceEvent(),
    };
  }

  const parsedSheets = sheetNames
    .map((sheetName: string) => {
      const worksheet = workbook.Sheets[sheetName];
      const worksheetRows = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        defval: "",
        raw: true,
        blankrows: false,
      }) as unknown[][];
      const studentHeaderRowIndex =
        findAttendanceStudentHeaderRowIndex(worksheetRows);
      const rows = XLSX.utils.sheet_to_json(worksheet, {
        defval: "",
        raw: false,
        blankrows: false,
        ...(studentHeaderRowIndex >= 0
          ? { range: studentHeaderRowIndex }
          : {}),
      }) as RawImportRow[];

      return {
        sheetName,
        priority: getAttendanceSheetPriority(sheetName),
        score: scoreAttendanceSheetRows(sheetName, rows),
        rows,
        detectedEvent: detectAttendanceWorksheetMetadata(
          worksheetRows,
          studentHeaderRowIndex,
        ),
      };
    })
    .filter(
      (sheet: { score: number; rows: RawImportRow[] }) =>
        sheet.score > 0 && sheet.rows.length > 0,
    )
    .sort(
      (
        left: { priority: number; score: number },
        right: { priority: number; score: number },
      ) => left.priority - right.priority || right.score - left.score,
    );

  if (!parsedSheets.length) {
    const firstSheetName = sheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const worksheetRows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      raw: true,
      blankrows: false,
    }) as unknown[][];
    const studentHeaderRowIndex =
      findAttendanceStudentHeaderRowIndex(worksheetRows);

    return {
      rawRows: XLSX.utils.sheet_to_json(worksheet, {
        defval: "",
        raw: false,
        blankrows: false,
        ...(studentHeaderRowIndex >= 0
          ? { range: studentHeaderRowIndex }
          : {}),
      }) as RawImportRow[],
      detectedEvent: detectAttendanceWorksheetMetadata(
        worksheetRows,
        studentHeaderRowIndex,
      ),
    };
  }

  const bestPriority = parsedSheets[0].priority;
  const selectedSheets = parsedSheets.filter(
    (sheet: { priority: number }) => sheet.priority === bestPriority,
  );

  return {
    rawRows: selectedSheets.flatMap(
      (sheet: { rows: RawImportRow[] }) => sheet.rows,
    ),
    detectedEvent: selectedSheets.reduce(
      (
        metadata: AttendanceDetectedEventMetadata,
        sheet: { detectedEvent: AttendanceDetectedEventMetadata },
      ) => mergeDetectedAttendanceEvents(metadata, sheet.detectedEvent),
      createEmptyDetectedAttendanceEvent(),
    ),
  };
}

async function parseFileToRawRows(file: UploadedAttendanceFile) {
  ensureSupportedFile(file.originalname);
  return parseExcelFile(file);
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

async function ensureSchoolYearForDate(
  client: PoolClient,
  values: unknown[] = [],
) {
  const range = getSchoolYearRangeFromDate(getFirstValidSchoolYearDate(values));
  const existing = await client.query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      WHERE name = $1
      ORDER BY is_active DESC, semester ASC
    `,
    [range.name],
  );

  if (existing.rows.length === 1) return existing.rows[0];
  if (existing.rows.length > 1) {
    const active = existing.rows.find((row) => row.is_active);
    if (active) return active;
    throw createValidationError(
      "Active school year / semester is required when multiple semesters exist.",
    );
  }

  const result = await client.query<SchoolYearRecord>(
    `
      INSERT INTO school_years (name, semester, starts_at, ends_at)
      VALUES ($1, 'first_semester', $2, $3)
      ON CONFLICT (name, semester)
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

function normalizeAttendanceMetadataIdentity(value: unknown) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getSchoolYearMetadataLabels(schoolYear: SchoolYearRecord) {
  const semesterLabel =
    schoolYear.semester === "second_semester"
      ? "Second Semester"
      : "First Semester";

  return [
    schoolYear.id,
    schoolYear.name,
    `${schoolYear.name} / ${semesterLabel}`,
    `${schoolYear.name} ${semesterLabel}`,
  ];
}

async function findSchoolYearIdFromAttendanceMetadata(value: unknown) {
  const label = cleanText(value);
  if (!label) return "";

  const result = await query<SchoolYearRecord>(
    `
      SELECT *
      FROM school_years
      ORDER BY is_active DESC, starts_at DESC, semester ASC
    `,
  );
  const normalizedLabel = normalizeAttendanceMetadataIdentity(label);
  const exactMatch = result.rows.find((schoolYear) =>
    getSchoolYearMetadataLabels(schoolYear).some(
      (candidate) =>
        normalizeAttendanceMetadataIdentity(candidate) === normalizedLabel,
    ),
  );

  if (exactMatch) return exactMatch.id;

  const years = label.match(/\d{4}/g) ?? [];
  if (!years.length) return "";

  const requestedSemester = normalizedLabel.includes("second")
    ? "second_semester"
    : normalizedLabel.includes("first")
      ? "first_semester"
      : "";
  const yearMatches = result.rows.filter((schoolYear) => {
    const normalizedName = schoolYear.name.toLowerCase();
    return (
      years.every((year) => normalizedName.includes(year)) &&
      (!requestedSemester || schoolYear.semester === requestedSemester)
    );
  });

  return yearMatches.length === 1 ? yearMatches[0].id : "";
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
    schoolYearId: cleanText(
      eventInput.schoolYearId ?? eventInput.school_year_id,
    ),
    eventId: cleanText(eventInput.eventId ?? eventInput.event_id),
    eventName: cleanText(eventInput.eventName ?? eventInput.event_name),
    eventStartAt:
      eventInput.eventStartAt ??
      eventInput.event_start_at ??
      eventInput.eventDate ??
      eventInput.event_date,
    eventEndAt: eventInput.eventEndAt ?? eventInput.event_end_at,
    eventDescription:
      eventInput.eventDescription ??
      eventInput.event_description ??
      eventInput.description,
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

function getAttendanceEventDateTimeKey(value: unknown) {
  const normalized = normalizeOptionalTimestamp(value);
  return normalized.error || !normalized.value
    ? ""
    : normalized.value.slice(0, 16);
}

async function findMatchingAttendanceEventFromFile(props: {
  metadata: AttendanceDetectedEventMetadata;
  schoolYearId?: string;
}) {
  const eventName = cleanText(props.metadata.eventName);
  const normalizedEventName = normalizeAttendanceEventName(eventName);
  const eventStartAtKey = getAttendanceEventDateTimeKey(
    props.metadata.eventStartAt,
  );
  const eventEndAtKey = getAttendanceEventDateTimeKey(props.metadata.eventEndAt);

  if (!eventName && !eventStartAtKey && !eventEndAtKey) return null;
  if (!props.schoolYearId && eventName && !eventStartAtKey && !eventEndAtKey) {
    return null;
  }

  const conditions: string[] = [];
  const values: unknown[] = [];

  if (props.schoolYearId) {
    values.push(props.schoolYearId);
    conditions.push(`e.school_year_id = $${values.length}`);
  }

  const result = await query<AttendanceEventRecord>(
    `
      SELECT e.*, 0::INT AS attendees_count
      FROM attendance_events e
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY e.event_order ASC NULLS LAST, e.created_at DESC
      LIMIT 500
    `,
    values,
  );

  if (!result.rows.length) return null;

  const nameMatchedEvents = eventName
    ? result.rows.filter(
        (event) =>
          normalizeAttendanceEventName(event.name) === normalizedEventName,
      )
    : result.rows;

  if (!nameMatchedEvents.length) return null;

  const dateMatchedEvents = nameMatchedEvents.filter((event) => {
    const startMatches =
      !eventStartAtKey ||
      getAttendanceEventDateTimeKey(event.event_start_at) === eventStartAtKey;
    const endMatches =
      !eventEndAtKey ||
      getAttendanceEventDateTimeKey(event.event_end_at) === eventEndAtKey;
    return startMatches && endMatches;
  });

  if (dateMatchedEvents.length) return dateMatchedEvents[0];
  if (eventName) return nameMatchedEvents[0];
  return nameMatchedEvents.length === 1 ? nameMatchedEvents[0] : null;
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

  const schoolYearId = await resolveSchoolYearId(
    client,
    eventInput.schoolYearId,
    [eventInput.eventStartAt, eventInput.eventEndAt],
  );
  const normalizedEventName = normalizeAttendanceEventName(name);

  const existingResult = await client.query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT ar.student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN attendance_records ar ON ar.event_id = e.id
      WHERE e.school_year_id = $1
      GROUP BY e.id
      ORDER BY e.created_at DESC
    `,
    [schoolYearId],
  );

  const existingEvent = existingResult.rows.find(
    (event) =>
      normalizeAttendanceEventName(event.name) === normalizedEventName,
  );

  if (existingEvent) return existingEvent;

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

type AttendanceRecordWithEventRosterScope = AttendanceRecord & {
  attendance_event_roster_college_key: string | null;
  attendance_school_year_id: string | null;
};

function getAttendanceRecordEventRosterCollegeSql(recordAlias: string) {
  return `
    LOWER(TRIM(COALESCE(
      (
        SELECT NULLIF(TRIM(scope_student.college), '')
        FROM students scope_student
        WHERE LOWER(TRIM(scope_student.student_id)) = LOWER(TRIM(${recordAlias}.student_id))
        LIMIT 1
      ),
      NULLIF(TRIM(${recordAlias}.college), ''),
      ''
    )))
  `;
}

function getAttendanceRecordSortTime(record: AttendanceRecord) {
  const value = record.scanned_at ?? record.created_at;
  const time = value ? new Date(value).getTime() : 0;

  return Number.isNaN(time) ? 0 : time;
}

const ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL =
  getAttendanceRecordEventRosterCollegeSql("ar");
const ATTENDANCE_EVENT_PARTICIPATION_CTE_SQL = `
  event_participation AS (
    SELECT DISTINCT
      ar.school_year_id,
      ar.event_id,
      LOWER(TRIM(ar.student_id)) AS normalized_student_id
    FROM attendance_records ar
    WHERE ar.event_id IS NOT NULL
      AND NULLIF(TRIM(ar.student_id), '') IS NOT NULL
  )
`;
const ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL = `
  event_roster_scope AS (
    SELECT DISTINCT
      ar.school_year_id,
      ar.event_id,
      ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} AS college_key
    FROM attendance_records ar
    WHERE ar.event_id IS NOT NULL
  )
`;
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

function uniqueCleanTextValues(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.map((value) => cleanText(value)).filter(Boolean)),
  );
}

function uniqueAttendanceEventRosterCollegeKeys(
  values: Array<string | null | undefined>,
) {
  return Array.from(new Set(values.map((value) => cleanText(value))));
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

async function getAttendanceRecordEventRosterCollegeKeys(
  client: PoolClient,
  recordIds: string[],
) {
  const uniqueRecordIds = uniqueCleanTextValues(recordIds);
  if (!uniqueRecordIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.id = ANY($1::uuid[])
        AND ar.event_id IS NOT NULL
    `,
    [uniqueRecordIds],
  );

  return uniqueAttendanceEventRosterCollegeKeys(
    result.rows.map((row) => row.college_key),
  );
}

async function getAttendanceImportEventRosterCollegeKeys(
  client: PoolClient,
  importIds: string[],
) {
  const uniqueImportIds = uniqueCleanTextValues(importIds);
  if (!uniqueImportIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.import_id = ANY($1::uuid[])
        AND ar.event_id IS NOT NULL
    `,
    [uniqueImportIds],
  );

  return uniqueAttendanceEventRosterCollegeKeys(
    result.rows.map((row) => row.college_key),
  );
}

async function getAttendanceEventRosterCollegeKeys(
  client: PoolClient,
  eventIds: string[],
) {
  const uniqueEventIds = uniqueCleanTextValues(eventIds);
  if (!uniqueEventIds.length) return [];

  const result = await client.query<{ college_key: string }>(
    `
      SELECT DISTINCT
        ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} AS college_key
      FROM attendance_records ar
      WHERE ar.event_id = ANY($1::uuid[])
    `,
    [uniqueEventIds],
  );

  return uniqueAttendanceEventRosterCollegeKeys(
    result.rows.map((row) => row.college_key),
  );
}

async function getAttendanceStudentIdsByEventRosterCollegeKeys(
  client: PoolClient,
  eventRosterCollegeKeys: string[],
) {
  const uniqueEventRosterCollegeKeys =
    uniqueAttendanceEventRosterCollegeKeys(eventRosterCollegeKeys);
  if (!uniqueEventRosterCollegeKeys.length) return [];

  const result = await client.query<{ student_id: string }>(
    `
      SELECT DISTINCT ar.student_id
      FROM attendance_records ar
      WHERE ar.event_id IS NOT NULL
        AND ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} = ANY($1::TEXT[])
    `,
    [uniqueEventRosterCollegeKeys],
  );

  return uniqueCleanTextValues(result.rows.map((row) => row.student_id));
}

async function syncAbsencesForAttendanceEventRosterColleges(
  client: PoolClient,
  eventRosterCollegeKeys: string[],
) {
  const uniqueEventRosterCollegeKeys =
    uniqueAttendanceEventRosterCollegeKeys(eventRosterCollegeKeys);
  const studentIds = await getAttendanceStudentIdsByEventRosterCollegeKeys(
    client,
    uniqueEventRosterCollegeKeys,
  );

  return syncAbsencesForStudents(client, studentIds);
}

export async function syncAbsencesForAttendanceRecordIds(
  client: PoolClient,
  recordIds: string[],
) {
  const eventRosterCollegeKeys = await getAttendanceRecordEventRosterCollegeKeys(
    client,
    recordIds,
  );

  return syncAbsencesForAttendanceEventRosterColleges(
    client,
    eventRosterCollegeKeys,
  );
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

  const updatedResult = await client.query<AttendanceRecordWithEventRosterScope>(
    `
      WITH ${ATTENDANCE_EVENT_PARTICIPATION_CTE_SQL},
      ${ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL},
      student_scope AS (
        SELECT DISTINCT
          LOWER(TRIM(ar.student_id)) AS student_key,
          ar.school_year_id,
          ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} AS college_key
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
            COUNT(DISTINCT roster.event_id)::INT -
              COUNT(DISTINCT attended.event_id)::INT,
            0
          ) AS no_of_absences
        FROM student_scope ss
        LEFT JOIN event_roster_scope roster
          ON roster.college_key = ss.college_key
         AND roster.school_year_id IS NOT DISTINCT FROM ss.school_year_id
        LEFT JOIN event_participation attended
          ON attended.normalized_student_id = ss.student_key
          AND attended.event_id = roster.event_id
          AND attended.school_year_id IS NOT DISTINCT FROM ss.school_year_id
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
         AND ${ATTENDANCE_RECORD_EVENT_ROSTER_COLLEGE_SQL} = sa.college_key
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
      RETURNING ar.*, target.college_key AS attendance_event_roster_college_key, target.school_year_id AS attendance_school_year_id
    `,
    [uniqueStudentIds],
  );

  const records = updatedResult.rows;
  const fines: FineRecord[] = [];

  if (!records.length) {
    return { records, fines };
  }

  const existingFineResult = await client.query<{
    attendance_record_id: string;
  }>(
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
    AttendanceRecordWithEventRosterScope[]
  >();

  records.forEach((record) => {
    const scopeKey = [
      cleanText(record.student_id).toLowerCase(),
      cleanText(record.attendance_event_roster_college_key),
      cleanText(record.attendance_school_year_id),
    ].join(":");
    const scopeRecords = recordsByStudentScope.get(scopeKey) ?? [];

    scopeRecords.push(record);
    recordsByStudentScope.set(scopeKey, scopeRecords);
  });

  const recordIdsToRemoveFinesFrom: string[] = [];
  const recordsToSyncFine: AttendanceRecordWithEventRosterScope[] = [];

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

async function findDuplicateAttendanceImport(
  client: PoolClient,
  input: {
    fileName: string;
    schoolYearId?: string | null;
    eventId?: string | null;
    eventName?: string | null;
  },
) {
  const fileName = cleanText(input.fileName);
  const schoolYearId = cleanText(input.schoolYearId) || null;
  const eventId = cleanText(input.eventId) || null;
  const eventName = cleanText(input.eventName);

  if (!fileName) return null;

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
      WHERE LOWER(TRIM(ai.file_name)) = LOWER(TRIM($1))
        AND ($2::uuid IS NULL OR ai.school_year_id = $2::uuid)
        AND (
          ($3::uuid IS NOT NULL AND ai.event_id = $3::uuid)
          OR (
            $3::uuid IS NULL
            AND $4::TEXT <> ''
            AND LOWER(TRIM(COALESCE(ae.name, ''))) = LOWER(TRIM($4::TEXT))
          )
          OR ($3::uuid IS NULL AND $4::TEXT = '')
        )
        AND ai.status = 'saved'
      ORDER BY ai.created_at DESC
      LIMIT 1
    `,
    [fileName, schoolYearId, eventId, eventName],
  );

  return result.rows[0] ?? null;
}

async function deleteAttendanceImportRecords(
  client: PoolClient,
  importIds: string[],
) {
  const uniqueImportIds = uniqueCleanTextValues(importIds);
  if (!uniqueImportIds.length) return;

  const finalResultIdsResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM attendance_final_results
      WHERE import_id = ANY($1::uuid[])
    `,
    [uniqueImportIds],
  );
  const finalResultIds = finalResultIdsResult.rows.map((row) => row.id);

  const calculationResultIdsResult = await client.query<{ id: string }>(
    `
      SELECT id
      FROM calculation_results
      WHERE import_ids && $1::uuid[]
    `,
    [uniqueImportIds],
  );
  const calculationResultIds = calculationResultIdsResult.rows.map(
    (row) => row.id,
  );

  if (finalResultIds.length || calculationResultIds.length) {
    await client.query(
      `
        DELETE FROM penalty_results
        WHERE (
            source_table = 'attendance_final_results'
            AND source_record_id::TEXT = ANY($1::TEXT[])
          )
          OR (
            source_table = 'calculation_results'
            AND source_record_id::TEXT = ANY($2::TEXT[])
          )
      `,
      [finalResultIds, calculationResultIds],
    );
  }

  await client.query(
    `
      DELETE FROM attendance_final_results
      WHERE import_id = ANY($1::uuid[])
    `,
    [uniqueImportIds],
  );

  await client.query(
    `
      DELETE FROM calculation_results
      WHERE import_ids && $1::uuid[]
    `,
    [uniqueImportIds],
  );

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
    throw createValidationError("Please upload a valid .xlsx file.");
  }

  const extension = getFileExtension(file.originalname);
  const parsedFile = await parseFileToRawRows(file);
  const preview = buildPreview(
    file.originalname,
    extension.replace(".", "") || file.mimetype || "unknown",
    parsedFile.rawRows,
    parsedFile.detectedEvent,
  );

  if (!preview.rowsValid) {
    throw createValidationError(
      "No parseable attendance rows were found in the uploaded .xlsx file.",
    );
  }

  return preview;
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

  if (!validRows.length) {
    throw createValidationError(
      "No parseable attendance rows were found in the uploaded .xlsx file.",
    );
  }

  const fallbackEventName = getFileNameWithoutExtension(input.fileName ?? "");
  const hasExplicitOrRowEventContext = Boolean(
    cleanText(input.eventId) ||
    cleanText(input.eventName) ||
    cleanText(input.resumeImportId) ||
    validRows.some((row) => row.eventName),
  );

  if (!hasExplicitOrRowEventContext && fallbackEventName) {
    input = { ...input, eventName: fallbackEventName };
  }

  const hasEventContext = Boolean(
    cleanText(input.eventId) ||
    cleanText(input.eventName) ||
    cleanText(input.resumeImportId) ||
    validRows.some((row) => row.eventName),
  );

  if (!hasEventContext) {
    throw createValidationError(
      "Unable to determine an event for this attendance import.",
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
    const resolvedSchoolYearId =
      defaultEvent?.school_year_id ??
      (await resolveSchoolYearId(client, input.schoolYearId, [
        input.eventStartAt,
        input.eventEndAt,
      ]));

    if (!existingImport) {
      const duplicateImport = await findDuplicateAttendanceImport(client, {
        fileName: preview.fileName,
        schoolYearId: resolvedSchoolYearId,
        eventId: defaultEvent?.id ?? input.eventId,
        eventName: defaultEvent?.name ?? input.eventName,
      });

      if (duplicateImport) {
        throw createValidationError(
          `The attendance file "${preview.fileName}" has already been uploaded for this event. Delete the existing uploaded file before uploading it again.`,
          409,
        );
      }
    }

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
              resolvedSchoolYearId,
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
              resolvedSchoolYearId,
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

  const hasRequestedEventContext = Boolean(
    cleanText(options.eventId) || cleanText(options.eventName),
  );
  let resolvedOptions = options;

  if (!hasRequestedEventContext) {
    const detectedSchoolYearId = cleanText(options.schoolYearId)
      ? cleanText(options.schoolYearId)
      : await findSchoolYearIdFromAttendanceMetadata(
          preview.detectedEvent.schoolYearLabel,
        );
    const matchedEvent = await findMatchingAttendanceEventFromFile({
      metadata: preview.detectedEvent,
      schoolYearId: detectedSchoolYearId || undefined,
    });
    const fallbackEventName = getFileNameWithoutExtension(file.originalname);

    resolvedOptions = {
      ...options,
      schoolYearId:
        detectedSchoolYearId || matchedEvent?.school_year_id || undefined,
      eventId: matchedEvent?.id || undefined,
      eventName:
        preview.detectedEvent.eventName ||
        matchedEvent?.name ||
        fallbackEventName ||
        undefined,
      eventStartAt:
        preview.detectedEvent.eventStartAt ||
        cleanOptionalText(matchedEvent?.event_start_at) ||
        undefined,
      eventEndAt:
        preview.detectedEvent.eventEndAt ||
        cleanOptionalText(matchedEvent?.event_end_at) ||
        undefined,
    };
  }

  return saveAttendanceRows({
    ...resolvedOptions,
    onProgress: onProgress ?? resolvedOptions.onProgress,
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
    !cleanText(
      (input as Record<string, unknown>).eventId ??
        (input as Record<string, unknown>).event_id,
    ) &&
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

function manualRecordToAttendanceRecord(
  record: ManualAttendanceRecord,
): AttendanceRecord {
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

  throw createValidationError(
    "Please select an existing attendance event for manual attendance.",
  );
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

async function getPenaltyForAbsenceCount(
  client: PoolClient,
  noOfAbsences: number,
) {
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
    attendance_remarks:
      record.source_table === "manual_attendance_records"
        ? "Manual attendance result"
        : "Final attendance result",
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
        WHERE school_year_id IS NOT DISTINCT FROM $1
          AND LOWER(TRIM(student_id)) = LOWER(TRIM($2))
          AND source_table = 'manual_attendance_records'
          AND source_record_id = $3
      `,
      [record.school_year_id, record.student_id, record.id],
    );
    return null;
  }

  const penalty = await getPenaltyForAbsenceCount(client, noOfAbsences);
  const prescribedPenalty =
    penalty?.prescribed_penalty ?? "No prescribed penalty configured.";
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
    const noOfAbsences = Math.max(0, Number(row.noOfAbsences ?? 0));

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
    const penaltyResult = await upsertPenaltyResultForManualRecord(
      client,
      manualRecord,
    );

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

    const existingEventRosterCollegeKeys =
      await getAttendanceRecordEventRosterCollegeKeys(client, uniqueIds);
    const event = await findOrCreateAttendanceEvent(
      client,
      getManualAttendanceEventInput(input),
    );
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
        event?.school_year_id ??
          (await resolveSchoolYearId(
            client,
            (input as Record<string, unknown>).schoolYearId ??
              (input as Record<string, unknown>).school_year_id,
            [row.scannedAt],
          )),
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
    const updatedEventRosterCollegeKeys =
      await getAttendanceRecordEventRosterCollegeKeys(
        client,
        updatedRecordIds,
      );
    const attendanceSyncEventRosterCollegeKeys =
      uniqueAttendanceEventRosterCollegeKeys([
        ...existingEventRosterCollegeKeys,
        ...updatedEventRosterCollegeKeys,
      ]);

    if (attendanceSyncEventRosterCollegeKeys.length) {
      const attendanceSynced = await syncAbsencesForAttendanceEventRosterColleges(
        client,
        attendanceSyncEventRosterCollegeKeys,
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
      updatedRecords.map((record) =>
        syncFineForAttendanceRecord(client, record),
      ),
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
  const noOfAbsences = Math.max(
    0,
    Number(row.noOfAbsences ?? existingRecord.no_of_absences ?? 0),
  );

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
  const penaltyResult = await upsertPenaltyResultForManualRecord(
    client,
    manualRecord,
  );

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

    const existingEventRosterCollegeKeys = existingRecord.event_id
      ? await getAttendanceRecordEventRosterCollegeKeys(client, [
          existingRecord.id,
        ])
      : [];
    const event = await findOrCreateAttendanceEvent(
      client,
      getManualAttendanceEventInput(input),
    );
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
        event?.school_year_id ??
          existingRecord.school_year_id ??
          (await resolveSchoolYearId(
            client,
            (input as Record<string, unknown>).schoolYearId ??
              (input as Record<string, unknown>).school_year_id,
            [row.scannedAt],
          )),
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

    const updatedEventRosterCollegeKeys = record.event_id
      ? await getAttendanceRecordEventRosterCollegeKeys(client, [record.id])
      : [];
    const attendanceSyncEventRosterCollegeKeys =
      uniqueAttendanceEventRosterCollegeKeys([
        ...existingEventRosterCollegeKeys,
        ...updatedEventRosterCollegeKeys,
      ]);

    if (attendanceSyncEventRosterCollegeKeys.length) {
      const attendanceSynced = await syncAbsencesForAttendanceEventRosterColleges(
        client,
        attendanceSyncEventRosterCollegeKeys,
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

    if (record) {
      const eventRosterCollegeKeys = record.event_id
        ? await getAttendanceRecordEventRosterCollegeKeys(client, [record.id])
        : [];

      await client.query("DELETE FROM fines WHERE attendance_record_id = $1", [
        id,
      ]);
      await client.query("DELETE FROM attendance_records WHERE id = $1", [id]);

      if (record.event_id) {
        await syncAbsencesForAttendanceEventRosterColleges(
          client,
          eventRosterCollegeKeys,
        );
      }

      return record;
    }

    const manualResult = await client.query<ManualAttendanceRecord>(
      `
        SELECT ${getManualRecordSelectSql()}
        FROM manual_attendance_records mar
        LEFT JOIN attendance_events ae ON ae.id = mar.event_id
        WHERE mar.id = $1
        LIMIT 1
      `,
      [id],
    );
    const manualRecord = manualResult.rows[0];

    if (!manualRecord) {
      throw createValidationError("Attendance record not found.", 404);
    }

    await client.query(
      `
        DELETE FROM penalty_results
        WHERE source_table = 'manual_attendance_records'
          AND source_record_id = $1
      `,
      [id],
    );
    await client.query("DELETE FROM manual_attendance_records WHERE id = $1", [
      id,
    ]);

    return manualRecordToAttendanceRecord(manualRecord);
  });
}

export async function deleteAttendanceImport(importId: string) {
  return withTransaction(async (client) => {
    const importRecord = await getAttendanceImportById(client, importId);

    if (!importRecord) {
      throw createValidationError("Attendance import not found.", 404);
    }

    const eventRosterCollegeKeys =
      await getAttendanceImportEventRosterCollegeKeys(client, [importId]);

    await deleteAttendanceImportRecords(client, [importId]);
    await syncAbsencesForAttendanceEventRosterColleges(
      client,
      eventRosterCollegeKeys,
    );

    return importRecord;
  });
}

export async function deleteAttendanceImportsByIds(
  importIds: string[],
): Promise<DeletedAttendanceImportsResult> {
  return withTransaction(async (client) => {
    const uniqueImportIds = uniqueCleanTextValues(importIds);

    if (!uniqueImportIds.length) {
      return {
        deletedCount: 0,
        deletedImports: [],
      };
    }

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
        WHERE ai.id = ANY($1::uuid[])
        ORDER BY ai.created_at DESC
      `,
      [uniqueImportIds],
    );

    const deletedImports = importsResult.rows;
    const idsToDelete = deletedImports.map((record) => record.id);

    if (!idsToDelete.length) {
      return {
        deletedCount: 0,
        deletedImports: [],
      };
    }

    const eventRosterCollegeKeys =
      await getAttendanceImportEventRosterCollegeKeys(client, idsToDelete);

    await deleteAttendanceImportRecords(client, idsToDelete);
    await syncAbsencesForAttendanceEventRosterColleges(
      client,
      eventRosterCollegeKeys,
    );

    return {
      deletedCount: deletedImports.length,
      deletedImports,
    };
  });
}

export async function deleteAttendanceImports(
  schoolYearId?: string,
): Promise<DeletedAttendanceImportsResult> {
  return withTransaction(async (client) => {
    const scopedSchoolYearId = cleanOptionalText(schoolYearId);
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
        ${scopedSchoolYearId ? "WHERE ai.school_year_id = $1" : ""}
        ORDER BY ai.created_at DESC
      `,
      scopedSchoolYearId ? [scopedSchoolYearId] : [],
    );

    const deletedImports = importsResult.rows;
    const importIds = deletedImports.map((record) => record.id);

    if (!importIds.length) {
      return {
        deletedCount: 0,
        deletedImports: [],
      };
    }

    const eventRosterCollegeKeys =
      await getAttendanceImportEventRosterCollegeKeys(client, importIds);

    await deleteAttendanceImportRecords(client, importIds);
    await syncAbsencesForAttendanceEventRosterColleges(
      client,
      eventRosterCollegeKeys,
    );

    return {
      deletedCount: deletedImports.length,
      deletedImports,
    };
  });
}

export async function listAttendanceEvents(
  limit = 100,
  offset = 0,
  schoolYearId?: string,
) {
  const result = await query<AttendanceEventRecord>(
    `
      SELECT
        e.*,
        COUNT(DISTINCT attendee.normalized_student_id)::INT AS attendees_count
      FROM attendance_events e
      LEFT JOIN LATERAL (
        SELECT LOWER(TRIM(ar.student_id)) AS normalized_student_id
        FROM attendance_records ar
        WHERE ar.event_id = e.id
        UNION
        SELECT LOWER(TRIM(mar.student_id)) AS normalized_student_id
        FROM manual_attendance_records mar
        WHERE mar.event_id = e.id
          AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
      ) attendee ON TRUE
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
    const schoolYearId = await resolveSchoolYearId(
      client,
      eventInput.schoolYearId,
      [eventInput.eventStartAt, eventInput.eventEndAt],
    );
    const eventCount = await getAttendanceEventCount(client, schoolYearId);
    const eventOrder = eventInput.eventOrder
      ? Math.min(eventInput.eventOrder, eventCount + 1)
      : eventCount + 1;

    if (eventInput.eventOrder) {
      await shiftAttendanceEventOrderForInsert(
        client,
        schoolYearId,
        eventOrder,
      );
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

    return (
      (await getAttendanceEventById(client, result.rows[0].id)) ??
      result.rows[0]
    );
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
    const maxOrder = schoolYearChanged
      ? eventCount + 1
      : Math.max(1, eventCount);
    const requestedOrder = eventInput.eventOrder
      ? Math.min(eventInput.eventOrder, maxOrder)
      : null;
    const nextOrder =
      requestedOrder ??
      (schoolYearChanged ? eventCount + 1 : (currentOrder ?? eventCount + 1));

    if (schoolYearChanged) {
      await shiftAttendanceEventOrderForInsert(
        client,
        nextSchoolYearId,
        nextOrder,
      );
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

    const eventRosterCollegeKeys =
      await getAttendanceEventRosterCollegeKeys(client, [id]);

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
    await syncAbsencesForAttendanceEventRosterColleges(
      client,
      eventRosterCollegeKeys,
    );

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
  importIds: string[] = [],
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

  const cleanImportIds = uniqueCleanTextValues(importIds);
  if (cleanImportIds.length) {
    params.push(cleanImportIds);
    clauses.push(`ar.import_id = ANY($${params.length}::uuid[])`);
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

export async function listAttendanceImports(
  limit = 50,
  offset = 0,
  schoolYearId?: string,
) {
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
  sourceTypes?: CalculationSourceType[];
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

const ATTENDANCE_EVENT_KEY_SQL = (
  recordAlias: "ar" | "mar",
  eventAlias = "ae",
) => `COALESCE(
  ${recordAlias}.event_id::TEXT,
  NULLIF(
    LOWER(
      REGEXP_REPLACE(
        TRIM(${eventAlias}.name),
        '[[:space:]]+',
        ' ',
        'g'
      )
    ),
    ''
  )
)`;

const CALCULATION_SOURCE_TYPE_ORDER: CalculationSourceType[] = [
  "imported",
  "manual",
  "zero_attendance",
];

function normalizeCalculationSourceTypes(value: unknown) {
  const values = Array.isArray(value) ? value : [value];
  const selectedSourceTypes = Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => cleanText(item))
        .filter((item): item is CalculationSourceType =>
          CALCULATION_SOURCE_TYPE_ORDER.includes(item as CalculationSourceType),
        ),
    ),
  );

  if (!selectedSourceTypes.length) return CALCULATION_SOURCE_TYPE_ORDER;

  return CALCULATION_SOURCE_TYPE_ORDER.filter((sourceType) =>
    selectedSourceTypes.includes(sourceType),
  );
}

function getCalculationScopeKey(
  importIds: string[],
  sourceTypes?: CalculationSourceType[],
) {
  const normalizedImportIds = normalizeImportIds(importIds);
  const normalizedSourceTypes = normalizeCalculationSourceTypes(sourceTypes ?? []);

  if (
    !normalizedImportIds.length &&
    normalizedSourceTypes.length === CALCULATION_SOURCE_TYPE_ORDER.length
  ) {
    return "school_year";
  }

  return [
    `sources:${normalizedSourceTypes.join(",") || "none"}`,
    `imports:${normalizedImportIds.join(",") || "all"}`,
  ].join("|");
}

function getCalculationSourceFlags(sourceTypes?: CalculationSourceType[]) {
  const selectedSourceTypes = new Set(
    normalizeCalculationSourceTypes(sourceTypes ?? []),
  );

  return {
    includeImported: selectedSourceTypes.has("imported"),
    includeManual: selectedSourceTypes.has("manual"),
    includeZeroAttendance: selectedSourceTypes.has("zero_attendance"),
  };
}

async function refreshCalculationResultsWithClient(
  client: PoolClient,
  options: Pick<CalculationResultsFilter, "schoolYearId" | "importIds" | "sourceTypes"> = {},
) {
  const schoolYearId = cleanText(options.schoolYearId) || null;
  const importIds = normalizeImportIds(options.importIds ?? []);
  const sourceTypes = normalizeCalculationSourceTypes(options.sourceTypes ?? []);
  const sourceFlags = getCalculationSourceFlags(sourceTypes);
  const calculationScopeKey = getCalculationScopeKey(importIds, sourceTypes);

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
      WITH ${ATTENDANCE_EVENT_PARTICIPATION_CTE_SQL},
      ${ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL},
      imported_records AS (
        SELECT
          ar.school_year_id,
          ar.import_id,
          ar.student_id,
          COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(ar.name), ''), ar.student_id) AS name,
          COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(ar.year_level), '')) AS year_level,
          COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')) AS college,
          COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(ar.program), '')) AS program,
          COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(ar.institution), '')) AS institution,
          CASE
            WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER($4::TEXT) THEN NULL
            ELSE ${ATTENDANCE_EVENT_KEY_SQL("ar")}
          END AS event_key,
          GREATEST(0, COALESCE(ar.no_of_absences, 0))::INT AS no_of_absences,
          COALESCE(ar.scanned_at, ar.created_at) AS scanned_at,
          ar.updated_at
        FROM attendance_records ar
        LEFT JOIN attendance_events ae ON ae.id = ar.event_id
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        WHERE (
            (
              $5::BOOLEAN
              AND ar.import_id IS NOT NULL
              AND (
                CARDINALITY($2::uuid[]) = 0
                OR ar.import_id = ANY($2::uuid[])
              )
            )
            OR (
              $7::BOOLEAN
              AND LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER($4::TEXT)
            )
          )
          AND ($1::uuid IS NULL OR ar.school_year_id = $1::uuid)
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
          ARRAY_AGG(DISTINCT import_id) FILTER (WHERE import_id IS NOT NULL) AS import_ids,
          COUNT(DISTINCT event_key)::INT AS attended_events,
          GREATEST(0, MAX(no_of_absences))::INT AS imported_absences,
          COUNT(*)::INT AS imported_record_count,
          MAX(scanned_at) AS latest_scanned_at,
          MAX(updated_at) AS source_updated_at
        FROM imported_records
        GROUP BY school_year_id, LOWER(TRIM(student_id))
      ), manual_records AS (
        SELECT
          mar.school_year_id,
          LOWER(TRIM(mar.student_id)) AS normalized_student_id,
          mar.student_id,
          COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(mar.name), ''), mar.student_id) AS name,
          COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(mar.year_level), '')) AS year_level,
          COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')) AS college,
          COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(mar.program), '')) AS program,
          COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(mar.institution), '')) AS institution,
          CASE
            WHEN (
              mar.attendance_type = 'zero_attendance'
              OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER($4::TEXT)
            ) THEN NULL
            ELSE ${ATTENDANCE_EVENT_KEY_SQL("mar")}
          END AS event_key,
          GREATEST(0, COALESCE(mar.no_of_absences, 0))::INT AS no_of_absences,
          COALESCE(mar.scanned_at, mar.created_at) AS scanned_at,
          mar.updated_at
        FROM manual_attendance_records mar
        LEFT JOIN attendance_events ae ON ae.id = mar.event_id
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
        WHERE ($1::uuid IS NULL OR mar.school_year_id = $1::uuid)
          AND (
            (
              $6::BOOLEAN
              AND COALESCE(mar.attendance_type, 'manual') <> 'zero_attendance'
              AND LOWER(TRIM(COALESCE(mar.remarks, ''))) <> LOWER($4::TEXT)
            )
            OR (
              $7::BOOLEAN
              AND (
                mar.attendance_type = 'zero_attendance'
                OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER($4::TEXT)
              )
            )
          )
      ), manual_totals AS (
        SELECT
          school_year_id,
          normalized_student_id,
          MAX(student_id) AS student_id,
          COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
          COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
          COALESCE(NULLIF(MAX(college), ''), '') AS college,
          COALESCE(NULLIF(MAX(program), ''), '') AS program,
          COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
          GREATEST(0, SUM(no_of_absences))::INT AS manual_absences,
          COUNT(*)::INT AS manual_record_count,
          MAX(scanned_at) AS latest_scanned_at,
          MAX(updated_at) AS source_updated_at
        FROM manual_records
        GROUP BY school_year_id, normalized_student_id
      ), imported_event_scope AS (
        SELECT DISTINCT
          school_year_id,
          event_key
        FROM imported_records
        WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
      ), imported_event_roster_scope AS (
        SELECT DISTINCT
          roster.school_year_id,
          roster.event_id,
          roster.college_key
        FROM event_roster_scope roster
        JOIN imported_event_scope scope
          ON scope.school_year_id IS NOT DISTINCT FROM roster.school_year_id
          AND scope.event_key = roster.event_id::TEXT
      ), imported_event_participation AS (
        SELECT
          ep.school_year_id,
          ep.normalized_student_id,
          ep.event_id::TEXT AS event_key
        FROM event_participation ep
        JOIN imported_event_scope scope
          ON scope.school_year_id IS NOT DISTINCT FROM ep.school_year_id
          AND scope.event_key = ep.event_id::TEXT
      ), event_attendance AS (
        SELECT
          school_year_id,
          normalized_student_id,
          event_key
        FROM imported_event_participation
        UNION
        SELECT
          school_year_id,
          normalized_student_id,
          event_key
        FROM manual_records
        WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
      ), attended_event_totals AS (
        SELECT
          school_year_id,
          normalized_student_id,
          COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events
        FROM event_attendance
        GROUP BY school_year_id, normalized_student_id
      ), student_keys AS (
        SELECT school_year_id, normalized_student_id FROM imported_totals
        UNION
        SELECT school_year_id, normalized_student_id FROM manual_totals
      ), student_event_scope AS (
        SELECT
          keys.school_year_id,
          keys.normalized_student_id,
          LOWER(TRIM(COALESCE(
            NULLIF(imported.college, ''),
            NULLIF(manual.college, ''),
            ''
          ))) AS college_key
        FROM student_keys keys
        LEFT JOIN imported_totals imported
          ON imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND imported.normalized_student_id = keys.normalized_student_id
        LEFT JOIN manual_totals manual
          ON manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND manual.normalized_student_id = keys.normalized_student_id
      ), expected_event_totals AS (
        SELECT
          student.school_year_id,
          student.normalized_student_id,
          COUNT(DISTINCT roster.event_id)::INT AS expected_events
        FROM student_event_scope student
        LEFT JOIN imported_event_roster_scope roster
          ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND roster.college_key = student.college_key
        GROUP BY student.school_year_id, student.normalized_student_id
      ), expected_attended_event_totals AS (
        SELECT
          student.school_year_id,
          student.normalized_student_id,
          COUNT(DISTINCT attended.event_key)::INT AS attended_expected_events
        FROM student_event_scope student
        LEFT JOIN imported_event_roster_scope roster
          ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND roster.college_key = student.college_key
        LEFT JOIN event_attendance attended
          ON attended.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND attended.normalized_student_id = student.normalized_student_id
          AND attended.event_key = roster.event_id::TEXT
        GROUP BY student.school_year_id, student.normalized_student_id
      ), merged AS (
        SELECT
          keys.school_year_id,
          $3::TEXT AS calculation_scope_key,
          COALESCE(imported.import_ids, ARRAY[]::uuid[]) AS import_ids,
          COALESCE(imported.student_id, manual.student_id, keys.normalized_student_id) AS student_id,
          COALESCE(imported.name, manual.name, keys.normalized_student_id) AS name,
          COALESCE(imported.year_level, manual.year_level) AS year_level,
          COALESCE(imported.college, manual.college) AS college,
          COALESCE(imported.program, manual.program) AS program,
          COALESCE(imported.institution, manual.institution) AS institution,
          COALESCE(attended.attended_events, 0)::INT AS attended_events,
          GREATEST(
            COALESCE(imported.imported_absences, 0),
            GREATEST(
              COALESCE(expected.expected_events, 0) -
                COALESCE(expected_attended.attended_expected_events, 0),
              0
            )
          )::INT AS imported_absences,
          COALESCE(manual.manual_absences, 0)::INT AS manual_absences,
          (
            GREATEST(
              COALESCE(imported.imported_absences, 0),
              GREATEST(
                COALESCE(expected.expected_events, 0) -
                  COALESCE(expected_attended.attended_expected_events, 0),
                0
              )
            ) + COALESCE(manual.manual_absences, 0)
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
        LEFT JOIN attended_event_totals attended
          ON attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND attended.normalized_student_id = keys.normalized_student_id
        LEFT JOIN expected_event_totals expected
          ON expected.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND expected.normalized_student_id = keys.normalized_student_id
        LEFT JOIN expected_attended_event_totals expected_attended
          ON expected_attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND expected_attended.normalized_student_id = keys.normalized_student_id
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
    [
      schoolYearId,
      importIds,
      calculationScopeKey,
      ZERO_ATTENDANCE_REMARK,
      sourceFlags.includeImported,
      sourceFlags.includeManual,
      sourceFlags.includeZeroAttendance,
    ],
  );

  return result.rows;
}

export async function refreshCalculationResults(
  options: Pick<CalculationResultsFilter, "schoolYearId" | "importIds" | "sourceTypes"> = {},
) {
  return withTransaction(async (client) => {
    const importIds = normalizeImportIds(options.importIds ?? []);
    const sourceTypes = normalizeCalculationSourceTypes(options.sourceTypes ?? []);
    const rows = await refreshCalculationResultsWithClient(client, {
      schoolYearId: options.schoolYearId,
      importIds,
      sourceTypes,
    });
    await refreshAttendanceFinalResultsWithClient(client, {
      schoolYearId: options.schoolYearId,
    });
    await refreshPenaltyResultsForSchoolYearWithClient(
      client,
      options.schoolYearId,
      getCalculationScopeKey(importIds, sourceTypes),
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
  const sourceTypes = normalizeCalculationSourceTypes(options.sourceTypes ?? []);
  if (importIds.length || options.sourceTypes?.length) {
    params.push(getCalculationScopeKey(importIds, sourceTypes));
    clauses.push(`cr.calculation_scope_key = $${params.length}`);
  }

  if (options.studentId) {
    params.push(options.studentId);
    clauses.push(`LOWER(TRIM(cr.student_id)) = LOWER(TRIM($${params.length}))`);
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(
      `LOWER(TRIM(COALESCE(cr.college, ''))) = LOWER(TRIM($${params.length}))`,
    );
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

export async function deleteCalculationResultsByIds(
  ids: string[],
): Promise<DeletedCalculationResultsResult> {
  return withTransaction(async (client) => {
    const uniqueIds = uniqueCleanTextValues(ids);

    if (!uniqueIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    const recordsResult = await client.query<CalculationResultRecord>(
      `
        SELECT *
        FROM calculation_results
        WHERE id = ANY($1::uuid[])
        ORDER BY calculated_at DESC, updated_at DESC
      `,
      [uniqueIds],
    );
    const records = recordsResult.rows;
    const recordIds = records.map((record) => record.id);

    if (!recordIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    await client.query(
      `
        DELETE FROM penalty_results
        WHERE source_table = 'calculation_results'
          AND source_record_id::TEXT = ANY($1::TEXT[])
      `,
      [recordIds],
    );

    await client.query(
      `
        DELETE FROM calculation_results
        WHERE id = ANY($1::uuid[])
      `,
      [recordIds],
    );

    return {
      deletedCount: records.length,
      deletedRecords: records,
    };
  });
}

export async function deleteCalculationResultsBySchoolYear(
  schoolYearId: string,
): Promise<DeletedCalculationResultsResult> {
  const scopedSchoolYearId = cleanText(schoolYearId);

  if (!scopedSchoolYearId) {
    return {
      deletedCount: 0,
      deletedRecords: [],
    };
  }

  const result = await query<CalculationResultRecord>(
    `
      SELECT *
      FROM calculation_results
      WHERE school_year_id = $1::uuid
    `,
    [scopedSchoolYearId],
  );

  return deleteCalculationResultsByIds(result.rows.map((record) => record.id));
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
  const schoolYearId = cleanText(options.schoolYearId) || null;

  await client.query(
    `
      DELETE FROM attendance_final_results afr
      WHERE ($1::uuid IS NULL OR afr.school_year_id = $1::uuid)
    `,
    [schoolYearId],
  );

  const result = await client.query<AttendanceFinalResultRecord>(
    `
      WITH ${ATTENDANCE_EVENT_PARTICIPATION_CTE_SQL},
      ${ATTENDANCE_EVENT_ROSTER_SCOPE_CTE_SQL},
      imported_records AS (
        SELECT
          ar.school_year_id,
          ar.student_id,
          COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(ar.name), ''), ar.student_id) AS name,
          COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(ar.year_level), '')) AS year_level,
          COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(ar.college), '')) AS college,
          COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(ar.program), '')) AS program,
          COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(ar.institution), '')) AS institution,
          CASE
            WHEN LOWER(TRIM(COALESCE(ar.remarks, ''))) = LOWER($2::TEXT) THEN NULL
            ELSE ${ATTENDANCE_EVENT_KEY_SQL("ar")}
          END AS event_key,
          GREATEST(0, COALESCE(ar.no_of_absences, 0))::INT AS no_of_absences,
          COALESCE(ar.scanned_at, ar.created_at) AS scanned_at,
          ar.updated_at
        FROM attendance_records ar
        LEFT JOIN attendance_events ae ON ae.id = ar.event_id
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(ar.student_id))
        WHERE ($1::uuid IS NULL OR ar.school_year_id = $1::uuid)
      ), imported_totals AS (
        SELECT
          school_year_id,
          LOWER(TRIM(student_id)) AS normalized_student_id,
          MAX(student_id) AS student_id,
          COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
          COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
          COALESCE(NULLIF(MAX(college), ''), '') AS college,
          COALESCE(NULLIF(MAX(program), ''), '') AS program,
          COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
          COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events,
          GREATEST(0, MAX(no_of_absences))::INT AS imported_absences,
          COUNT(*)::INT AS imported_record_count,
          MAX(scanned_at) AS latest_scanned_at,
          MAX(updated_at) AS source_updated_at
        FROM imported_records
        GROUP BY school_year_id, LOWER(TRIM(student_id))
      ), manual_records AS (
        SELECT
          mar.school_year_id,
          LOWER(TRIM(mar.student_id)) AS normalized_student_id,
          mar.student_id,
          COALESCE(NULLIF(TRIM(s.name), ''), NULLIF(TRIM(mar.name), ''), mar.student_id) AS name,
          COALESCE(NULLIF(TRIM(s.year_level), ''), NULLIF(TRIM(mar.year_level), '')) AS year_level,
          COALESCE(NULLIF(TRIM(s.college), ''), NULLIF(TRIM(mar.college), '')) AS college,
          COALESCE(NULLIF(TRIM(s.program), ''), NULLIF(TRIM(mar.program), '')) AS program,
          COALESCE(NULLIF(TRIM(s.institution), ''), NULLIF(TRIM(mar.institution), '')) AS institution,
          CASE
            WHEN (
              mar.attendance_type = 'zero_attendance'
              OR LOWER(TRIM(COALESCE(mar.remarks, ''))) = LOWER($2::TEXT)
            ) THEN NULL
            ELSE ${ATTENDANCE_EVENT_KEY_SQL("mar")}
          END AS event_key,
          GREATEST(0, COALESCE(mar.no_of_absences, 0))::INT AS no_of_absences,
          COALESCE(mar.scanned_at, mar.created_at) AS scanned_at,
          mar.updated_at
        FROM manual_attendance_records mar
        LEFT JOIN attendance_events ae ON ae.id = mar.event_id
        LEFT JOIN students s ON LOWER(TRIM(s.student_id)) = LOWER(TRIM(mar.student_id))
        WHERE ($1::uuid IS NULL OR mar.school_year_id = $1::uuid)
      ), manual_totals AS (
        SELECT
          school_year_id,
          normalized_student_id,
          MAX(student_id) AS student_id,
          COALESCE(NULLIF(MAX(name), ''), MAX(student_id)) AS name,
          COALESCE(NULLIF(MAX(year_level), ''), '') AS year_level,
          COALESCE(NULLIF(MAX(college), ''), '') AS college,
          COALESCE(NULLIF(MAX(program), ''), '') AS program,
          COALESCE(NULLIF(MAX(institution), ''), '') AS institution,
          GREATEST(0, SUM(no_of_absences))::INT AS manual_absences,
          COUNT(*)::INT AS manual_record_count,
          MAX(scanned_at) AS latest_scanned_at,
          MAX(updated_at) AS source_updated_at
        FROM manual_records
        GROUP BY school_year_id, normalized_student_id
      ), imported_event_scope AS (
        SELECT DISTINCT
          school_year_id,
          event_key
        FROM imported_records
        WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
      ), imported_event_participation AS (
        SELECT
          ep.school_year_id,
          ep.normalized_student_id,
          ep.event_id::TEXT AS event_key
        FROM event_participation ep
        JOIN imported_event_scope scope
          ON scope.school_year_id IS NOT DISTINCT FROM ep.school_year_id
          AND scope.event_key = ep.event_id::TEXT
      ), event_attendance AS (
        SELECT
          school_year_id,
          normalized_student_id,
          event_key
        FROM imported_event_participation
        UNION
        SELECT
          school_year_id,
          normalized_student_id,
          event_key
        FROM manual_records
        WHERE NULLIF(TRIM(event_key), '') IS NOT NULL
      ), attended_event_totals AS (
        SELECT
          school_year_id,
          normalized_student_id,
          COUNT(DISTINCT NULLIF(TRIM(event_key), ''))::INT AS attended_events
        FROM event_attendance
        GROUP BY school_year_id, normalized_student_id
      ), student_keys AS (
        SELECT school_year_id, normalized_student_id FROM imported_totals
        UNION
        SELECT school_year_id, normalized_student_id FROM manual_totals
      ), student_event_scope AS (
        SELECT
          keys.school_year_id,
          keys.normalized_student_id,
          LOWER(TRIM(COALESCE(
            NULLIF(imported.college, ''),
            NULLIF(manual.college, ''),
            ''
          ))) AS college_key
        FROM student_keys keys
        LEFT JOIN imported_totals imported
          ON imported.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND imported.normalized_student_id = keys.normalized_student_id
        LEFT JOIN manual_totals manual
          ON manual.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND manual.normalized_student_id = keys.normalized_student_id
      ), expected_event_totals AS (
        SELECT
          student.school_year_id,
          student.normalized_student_id,
          COUNT(DISTINCT roster.event_id)::INT AS expected_events
        FROM student_event_scope student
        LEFT JOIN event_roster_scope roster
          ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND roster.college_key = student.college_key
        GROUP BY student.school_year_id, student.normalized_student_id
      ), expected_attended_event_totals AS (
        SELECT
          student.school_year_id,
          student.normalized_student_id,
          COUNT(DISTINCT attended.event_key)::INT AS attended_expected_events
        FROM student_event_scope student
        LEFT JOIN event_roster_scope roster
          ON roster.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND roster.college_key = student.college_key
        LEFT JOIN event_attendance attended
          ON attended.school_year_id IS NOT DISTINCT FROM student.school_year_id
          AND attended.normalized_student_id = student.normalized_student_id
          AND attended.event_key = roster.event_id::TEXT
        GROUP BY student.school_year_id, student.normalized_student_id
      ), merged AS (
        SELECT
          keys.school_year_id,
          COALESCE(imported.student_id, manual.student_id, keys.normalized_student_id) AS student_id,
          COALESCE(imported.name, manual.name, keys.normalized_student_id) AS name,
          COALESCE(imported.year_level, manual.year_level, '') AS year_level,
          COALESCE(imported.college, manual.college, '') AS college,
          COALESCE(imported.program, manual.program, '') AS program,
          COALESCE(imported.institution, manual.institution, '') AS institution,
          COALESCE(attended.attended_events, 0)::INT AS attended_events,
          (
            GREATEST(
              COALESCE(imported.imported_absences, 0),
              GREATEST(
                COALESCE(expected.expected_events, 0) -
                  COALESCE(expected_attended.attended_expected_events, 0),
                0
              )
            ) + COALESCE(manual.manual_absences, 0)
          )::INT AS total_absences,
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
        LEFT JOIN attended_event_totals attended
          ON attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND attended.normalized_student_id = keys.normalized_student_id
        LEFT JOIN expected_event_totals expected
          ON expected.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND expected.normalized_student_id = keys.normalized_student_id
        LEFT JOIN expected_attended_event_totals expected_attended
          ON expected_attended.school_year_id IS NOT DISTINCT FROM keys.school_year_id
          AND expected_attended.normalized_student_id = keys.normalized_student_id
      )
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
        school_year_id,
        NULL::uuid AS import_id,
        student_id,
        name,
        NULLIF(year_level, ''),
        NULLIF(college, ''),
        NULLIF(program, ''),
        NULLIF(institution, ''),
        attended_events,
        total_absences,
        CASE
          WHEN total_absences <= 0 THEN 'perfect_attendance'
          ELSE 'with_absences'
        END AS attendance_status,
        NULLIF(latest_scanned_at, '-infinity'::timestamptz),
        NULLIF(source_updated_at, '-infinity'::timestamptz)
      FROM merged
      RETURNING *
    `,
    [schoolYearId, ZERO_ATTENDANCE_REMARK],
  );

  return result.rows;
}

async function refreshPenaltyResultsForSchoolYearWithClient(
  client: PoolClient,
  schoolYearId?: string,
  _calculationScopeKey?: string,
) {
  const result = await client.query<PenaltyResultRecord>(
    `
      WITH totals AS (
        SELECT
          afr.school_year_id,
          afr.student_id,
          afr.name,
          afr.total_absences::INT AS no_of_absences,
          penalty.id AS penalty_id,
          COALESCE(penalty.prescribed_penalty, 'No prescribed penalty configured.') AS prescribed_penalty,
          'attendance_final_results'::TEXT AS source_table,
          afr.id AS source_record_id
        FROM attendance_final_results afr
        LEFT JOIN LATERAL (
          SELECT id, prescribed_penalty
          FROM penalties
          WHERE no_of_absences <= afr.total_absences
          ORDER BY no_of_absences DESC
          LIMIT 1
        ) penalty ON afr.total_absences > 0
        WHERE ($1::uuid IS NULL OR afr.school_year_id = $1::uuid)
          AND afr.total_absences > 0
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
    [schoolYearId ?? null],
  );

  await client.query(
    `
      DELETE FROM penalty_results pr
      WHERE ($1::uuid IS NULL OR pr.school_year_id = $1::uuid)
        AND pr.source_table = 'attendance_final_results'
        AND NOT EXISTS (
          SELECT 1
          FROM attendance_final_results afr
          WHERE afr.school_year_id IS NOT DISTINCT FROM pr.school_year_id
            AND LOWER(TRIM(afr.student_id)) = LOWER(TRIM(pr.student_id))
            AND afr.total_absences > 0
        )
    `,
    [schoolYearId ?? null],
  );

  return result.rows;
}

export async function refreshAttendanceFinalResults(
  options: Pick<AttendanceFinalResultsFilter, "schoolYearId" | "importId"> = {},
) {
  return withTransaction(async (client) => {
    const rows = await refreshAttendanceFinalResultsWithClient(client, options);
    await refreshPenaltyResultsForSchoolYearWithClient(
      client,
      options.schoolYearId,
    );
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
    clauses.push(
      `LOWER(TRIM(afr.student_id)) = LOWER(TRIM($${params.length}))`,
    );
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(
      `LOWER(TRIM(COALESCE(afr.college, ''))) = LOWER(TRIM($${params.length}))`,
    );
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
    clauses.push(
      `LOWER(TRIM(mar.student_id)) = LOWER(TRIM($${params.length}))`,
    );
  }

  if (options.college) {
    params.push(options.college);
    clauses.push(
      `LOWER(TRIM(COALESCE(mar.college, ''))) = LOWER(TRIM($${params.length}))`,
    );
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

export async function deleteAttendanceFinalResultsByIds(
  ids: string[],
): Promise<DeletedAttendanceFinalResultsResult> {
  return withTransaction(async (client) => {
    const uniqueIds = uniqueCleanTextValues(ids);

    if (!uniqueIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    const result = await client.query<AttendanceFinalResultRecord>(
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
        WHERE afr.id = ANY($1::uuid[])
        ORDER BY afr.created_at DESC
      `,
      [uniqueIds],
    );
    const records = result.rows;
    const recordIds = records.map((record) => record.id);

    if (!recordIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    await client.query(
      `
        DELETE FROM penalty_results
        WHERE source_table = 'attendance_final_results'
          AND source_record_id::TEXT = ANY($1::TEXT[])
      `,
      [recordIds],
    );

    await client.query(
      "DELETE FROM attendance_final_results WHERE id = ANY($1::uuid[])",
      [recordIds],
    );

    return {
      deletedCount: records.length,
      deletedRecords: records,
    };
  });
}

export async function deleteAttendanceFinalResultsBySchoolYear(
  schoolYearId: string,
): Promise<DeletedAttendanceFinalResultsResult> {
  const records = await listAttendanceFinalResults({
    schoolYearId,
    limit: 100000,
    offset: 0,
  });

  return deleteAttendanceFinalResultsByIds(records.map((record) => record.id));
}

export async function deleteManualAttendanceRecordsByIds(
  ids: string[],
): Promise<DeletedManualAttendanceRecordsResult> {
  return withTransaction(async (client) => {
    const uniqueIds = uniqueCleanTextValues(ids);

    if (!uniqueIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    const result = await client.query<ManualAttendanceRecord>(
      `
        SELECT ${getManualRecordSelectSql()}
        FROM manual_attendance_records mar
        LEFT JOIN attendance_events ae ON ae.id = mar.event_id
        WHERE mar.id = ANY($1::uuid[])
        ORDER BY mar.created_at DESC
      `,
      [uniqueIds],
    );
    const records = result.rows;
    const recordIds = records.map((record) => record.id);

    if (!recordIds.length) {
      return {
        deletedCount: 0,
        deletedRecords: [],
      };
    }

    await client.query(
      `
        DELETE FROM penalty_results
        WHERE source_table = 'manual_attendance_records'
          AND source_record_id::TEXT = ANY($1::TEXT[])
      `,
      [recordIds],
    );

    await client.query(
      "DELETE FROM manual_attendance_records WHERE id = ANY($1::uuid[])",
      [recordIds],
    );

    return {
      deletedCount: records.length,
      deletedRecords: records,
    };
  });
}

export async function deleteManualAttendanceRecordsBySchoolYear(
  schoolYearId: string,
): Promise<DeletedManualAttendanceRecordsResult> {
  const records = await listManualAttendanceRecords({
    schoolYearId,
    limit: 100000,
    offset: 0,
  });

  return deleteManualAttendanceRecordsByIds(records.map((record) => record.id));
}
