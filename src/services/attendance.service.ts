import path from "path";
import { PoolClient } from "pg";

import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceImportRecord,
  AttendancePreviewResult,
  AttendanceRecord,
  FineRecord,
  ParsedAttendanceRow,
  SavedAttendanceImportResult
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
  fileName?: string;
  fileType?: string;
  rows: RawImportRow[] | ParsedAttendanceRow[];
};

const HEADER_ALIASES = {
  studentId: ["studentid", "student id", "student_id", "student no", "student no.", "id number", "id", "school id"],
  name: ["name", "full name", "student name", "learner name"],
  yearLevel: ["yearlevel", "year level", "year_level", "grade", "grade level", "level"],
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
    "total absences"
  ],
  remarks: ["remarks", "remark", "notes", "note", "comment", "comments"]
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

function getFileExtension(fileName: string) {
  return path.extname(fileName || "").toLowerCase();
}

function ensureSupportedFile(fileName: string) {
  const extension = getFileExtension(fileName);

  if (!ACCEPTED_ATTENDANCE_EXTENSIONS.includes(extension as any)) {
    throw new Error(`Unsupported file type. Accepted files: ${ACCEPTED_ATTENDANCE_EXTENSIONS.join(", ")}`);
  }

  return extension;
}

function loadRequiredModule<T = any>(packageName: string): T {
  try {
    return require(packageName) as T;
  } catch {
    throw new Error(`Missing dependency "${packageName}". Please install it before using this file reader.`);
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
    normalizedHeaders.some((header) => HEADER_ALIASES.studentId.includes(header as any)) &&
    normalizedHeaders.some((header) => HEADER_ALIASES.name.includes(header as any));

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
        remarks: cells.slice(7).join(" ")
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
  const text = cleanText(value);
  if (!text) return 0;

  const parsed = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return null;

  return parsed;
}

function normalizeImportRows(rows: RawImportRow[] | ParsedAttendanceRow[]): ParsedAttendanceRow[] {
  return rows.map((inputRow, index) => {
    const raw = (inputRow as ParsedAttendanceRow).raw ?? inputRow;
    const rowNumber = Number((inputRow as ParsedAttendanceRow).rowNumber ?? index + 2);

    const studentId = cleanText((inputRow as ParsedAttendanceRow).studentId ?? getByAliases(raw, HEADER_ALIASES.studentId));
    const name = cleanText((inputRow as ParsedAttendanceRow).name ?? getByAliases(raw, HEADER_ALIASES.name));
    const yearLevel = cleanText((inputRow as ParsedAttendanceRow).yearLevel ?? getByAliases(raw, HEADER_ALIASES.yearLevel));
    const college = cleanText((inputRow as ParsedAttendanceRow).college ?? getByAliases(raw, HEADER_ALIASES.college));
    const program = cleanText((inputRow as ParsedAttendanceRow).program ?? getByAliases(raw, HEADER_ALIASES.program));
    const institution = cleanText(
      (inputRow as ParsedAttendanceRow).institution ?? getByAliases(raw, HEADER_ALIASES.institution)
    );
    const remarks = cleanText((inputRow as ParsedAttendanceRow).remarks ?? getByAliases(raw, HEADER_ALIASES.remarks));
    const absencesInput = (inputRow as ParsedAttendanceRow).noOfAbsences ?? getByAliases(raw, HEADER_ALIASES.noOfAbsences);
    const noOfAbsences = parseOptionalAbsences(absencesInput);

    const errors: string[] = [];
    if (!studentId) errors.push("Student ID is required.");
    if (!name) errors.push("Name is required.");
    if (noOfAbsences === null) errors.push("No. of Absences must be a whole number.");

    return {
      rowNumber,
      studentId,
      name,
      yearLevel,
      college,
      program,
      institution,
      noOfAbsences: noOfAbsences ?? 0,
      remarks,
      errors,
      raw
    };
  });
}

function buildPreview(fileName: string, fileType: string, rawRows: RawImportRow[] | ParsedAttendanceRow[]): AttendancePreviewResult {
  const rows = normalizeImportRows(rawRows);
  const rowsValid = rows.filter((row) => row.errors.length === 0).length;
  const rowsInvalid = rows.length - rowsValid;

  return {
    fileName,
    fileType,
    rowsTotal: rows.length,
    rowsValid,
    rowsInvalid,
    rows
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
    raw: false
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
    [row.studentId, row.name, row.yearLevel ?? "", row.college ?? "", row.program ?? "", row.institution ?? ""]
  );
}

async function insertAttendanceRecord(client: PoolClient, importId: string, row: ParsedAttendanceRow) {
  const result = await client.query<AttendanceRecord>(
    `
      INSERT INTO attendance_records (
        import_id,
        student_id,
        name,
        year_level,
        college,
        program,
        institution,
        no_of_absences,
        remarks
      )
      VALUES ($1, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), NULLIF($7, ''), $8, NULLIF($9, ''))
      RETURNING *
    `,
    [
      importId,
      row.studentId,
      row.name,
      row.yearLevel ?? "",
      row.college ?? "",
      row.program ?? "",
      row.institution ?? "",
      row.noOfAbsences ?? 0,
      row.remarks ?? ""
    ]
  );

  return result.rows[0];
}

async function insertFineIfNeeded(client: PoolClient, record: AttendanceRecord) {
  if (!record.no_of_absences || record.no_of_absences <= 0) return null;

  const penaltyResult = await client.query(
    `
      SELECT *
      FROM penalties
      WHERE no_of_absences <= $1
      ORDER BY no_of_absences DESC
      LIMIT 1
    `,
    [record.no_of_absences]
  );

  const penalty = penaltyResult.rows[0];
  const penaltyText = penalty?.prescribed_penalty ?? "No prescribed penalty configured.";

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
    [record.id, penalty?.id ?? null, record.student_id, record.name, record.no_of_absences, penaltyText]
  );

  return fineResult.rows[0];
}

export async function previewAttendanceFile(file: UploadedAttendanceFile): Promise<AttendancePreviewResult> {
  if (!file?.buffer?.length) {
    throw new Error("Please upload a valid Excel, text, or document file.");
  }

  const extension = getFileExtension(file.originalname);
  const rawRows = await parseFileToRawRows(file);
  return buildPreview(file.originalname, extension.replace(".", "") || file.mimetype || "unknown", rawRows);
}

export async function saveAttendanceRows(input: SaveRowsInput): Promise<SavedAttendanceImportResult> {
  const preview = buildPreview(input.fileName ?? "manual-import", input.fileType ?? "json", input.rows);
  const validRows = preview.rows.filter((row) => row.errors.length === 0);

  return withTransaction(async (client) => {
    const importResult = await client.query<AttendanceImportRecord>(
      `
        INSERT INTO attendance_imports (file_name, file_type, rows_total, rows_valid, rows_invalid, status)
        VALUES ($1, $2, $3, $4, $5, 'saved')
        RETURNING *
      `,
      [preview.fileName, preview.fileType, preview.rowsTotal, preview.rowsValid, preview.rowsInvalid]
    );

    const importId = importResult.rows[0].id;
    const savedRecords: AttendanceRecord[] = [];
    const createdFines: FineRecord[] = [];

    for (const row of validRows) {
      await upsertStudent(client, row);
      const record = await insertAttendanceRecord(client, importId, row);
      savedRecords.push(record);

      const fine = await insertFineIfNeeded(client, record);
      if (fine) createdFines.push(fine);
    }

    return {
      ...preview,
      importId,
      savedRecords,
      createdFines
    };
  });
}

export async function saveAttendanceFile(file: UploadedAttendanceFile): Promise<SavedAttendanceImportResult> {
  const preview = await previewAttendanceFile(file);
  return saveAttendanceRows({
    fileName: preview.fileName,
    fileType: preview.fileType,
    rows: preview.rows
  });
}

export async function listAttendanceRecords(limit = 100, offset = 0, studentId?: string) {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (studentId) {
    params.push(studentId);
    clauses.push(`LOWER(TRIM(student_id)) = LOWER(TRIM($${params.length}))`);
  }

  params.push(limit);
  const limitPosition = params.length;

  params.push(offset);
  const offsetPosition = params.length;

  const result = await query<AttendanceRecord>(
    `
      SELECT *
      FROM attendance_records
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC
      LIMIT $${limitPosition} OFFSET $${offsetPosition}
    `,
    params
  );

  return result.rows;
}

export async function listAttendanceImports(limit = 50, offset = 0) {
  const result = await query<AttendanceImportRecord>(
    `
      SELECT *
      FROM attendance_imports
      ORDER BY created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [limit, offset]
  );

  return result.rows;
}

export async function getAttendanceImport(importId: string) {
  const importResult = await query<AttendanceImportRecord>("SELECT * FROM attendance_imports WHERE id = $1 LIMIT 1", [
    importId
  ]);

  if (!importResult.rows[0]) return null;

  const recordsResult = await query<AttendanceRecord>(
    `
      SELECT *
      FROM attendance_records
      WHERE import_id = $1
      ORDER BY created_at ASC
    `,
    [importId]
  );

  return {
    import: importResult.rows[0],
    records: recordsResult.rows
  };
}