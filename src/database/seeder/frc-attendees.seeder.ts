import "dotenv/config";

import fs from "fs";
import path from "path";

import { query } from "../../lib/db";
import {
  saveAttendanceFiles,
  saveAttendanceRows,
  type AttendanceFileSaveOption,
  type UploadedAttendanceFile,
} from "../../services/attendance.service";

const FRC_EVENT_NAME = "Flag Raising Ceremony";
const FRC_DATA_DIRECTORY = path.join(
  __dirname,
  "data",
  "september-01-frc",
);

const FRC_SCANNER_FILES = [
  "FRC ATTENDANCE (BSCS) SEPTEMBER 1, 2026.csv",
  "FRC ATTENDANCE (BSIS) Sep,1 2026.csv",
] as const;
const FRC_NO_QR_FILE = "no QR during flag raising.txt";
const FRC_IMPORT_FILES = [...FRC_SCANNER_FILES, FRC_NO_QR_FILE] as const;

type ExistingImport = {
  id: string;
  file_name: string;
  event_id: string | null;
};

export type SeedFrcAttendeesResult = {
  alreadySeeded: boolean;
  seededImports: number;
  seededAttendanceRecords: number;
  seededNoQrAttendees: number;
  skippedNoStudentId: number;
};

function getFixturePath(fileName: string) {
  return path.join(FRC_DATA_DIRECTORY, fileName);
}

function assertFixtureFilesExist() {
  const missingFiles = FRC_IMPORT_FILES.filter(
    (fileName) => !fs.existsSync(getFixturePath(fileName)),
  );

  if (missingFiles.length) {
    throw new Error(
      `Missing FRC attendee seeder fixture file(s): ${missingFiles.join(", ")}`,
    );
  }
}

function toUploadedFile(fileName: string): UploadedAttendanceFile {
  const buffer = fs.readFileSync(getFixturePath(fileName));

  return {
    originalname: fileName,
    mimetype: "text/csv",
    buffer,
    size: buffer.length,
  };
}

function parseNoQrAttendees() {
  const contents = fs.readFileSync(getFixturePath(FRC_NO_QR_FILE), "utf8");
  let skippedNoStudentId = 0;

  const rows = contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const numberedLine = line.match(/^\d+\.\s*(.+)$/);
      if (!numberedLine) return null;

      const attendee = numberedLine[1].trim();
      const studentIdMatch = attendee.match(/\b(TC-[A-Z0-9-]+)\s*$/i);
      if (!studentIdMatch) {
        skippedNoStudentId += 1;
        return null;
      }

      const studentId = studentIdMatch[1].toUpperCase();
      const name = attendee.slice(0, studentIdMatch.index).trim();
      if (!name) return null;

      return {
        studentId,
        name,
        noOfAbsences: 0,
        remarks: "Seeded attendee without QR scan during the September 1 flag raising ceremony.",
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));

  return { rows, skippedNoStudentId };
}

async function getExistingImports(): Promise<ExistingImport[]> {
  const result = await query<ExistingImport>(
    `
      SELECT id, file_name, event_id
      FROM attendance_imports
      WHERE LOWER(TRIM(file_name)) = ANY($1::text[])
        AND status = 'saved'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `,
    [FRC_IMPORT_FILES.map((fileName) => fileName.toLowerCase())],
  );

  return result.rows;
}

export async function seedFrcAttendees(
  onProgress?: (message: string) => void,
): Promise<SeedFrcAttendeesResult> {
  onProgress?.("Verifying bundled September 1 FRC fixture files");
  assertFixtureFilesExist();

  onProgress?.("Checking existing FRC imports and target event");
  const existingImports = await getExistingImports();
  const existingFileNames = new Set(
    existingImports.map((record) => record.file_name.trim().toLowerCase()),
  );
  const missingScannerFiles = FRC_SCANNER_FILES.filter(
    (fileName) => !existingFileNames.has(fileName.toLowerCase()),
  );
  const shouldSeedNoQr = !existingFileNames.has(FRC_NO_QR_FILE.toLowerCase());

  if (!missingScannerFiles.length && !shouldSeedNoQr) {
    return {
      alreadySeeded: true,
      seededImports: 0,
      seededAttendanceRecords: 0,
      seededNoQrAttendees: 0,
      skippedNoStudentId: 0,
    };
  }

  let targetEventId =
    existingImports.find((record) => record.event_id)?.event_id ?? null;
  let seededImports = 0;
  let seededAttendanceRecords = 0;

  if (missingScannerFiles.length) {
    onProgress?.(`Reading ${missingScannerFiles.length} scanner attendance file(s)`);
    const files = missingScannerFiles.map(toUploadedFile);
    const fileOptions: AttendanceFileSaveOption[] = files.map(
      (file, index) => ({
        index,
        fileName: file.originalname,
        eventName: FRC_EVENT_NAME,
        mergeIntoEventId: targetEventId || undefined,
        mergeIntoBatchIndex: !targetEventId && index > 0 ? 0 : undefined,
        forceCreateEvent: !targetEventId && index === 0,
        keepEventName: "incoming",
        keepEventSchedule: index === 0 ? "incoming" : "existing",
      }),
    );

    onProgress?.(`Saving ${files.length} scanner import(s) and merging them into one FRC event`);
    const batch = await saveAttendanceFiles(files, fileOptions);
    seededImports += batch.filesSaved;
    seededAttendanceRecords += batch.recordsSaved;
    targetEventId = batch.files[0]?.result.event?.id ?? targetEventId;
  }

  if (!targetEventId) {
    onProgress?.("Resolving FRC event from existing import history");
    const refreshedImports = await getExistingImports();
    targetEventId =
      refreshedImports.find((record) => record.event_id)?.event_id ?? null;
  }

  let seededNoQrAttendees = 0;
  let skippedNoStudentId = 0;

  if (shouldSeedNoQr) {
    onProgress?.("Parsing attendees recorded without QR scans");
    if (!targetEventId) {
      throw new Error(
        "Unable to resolve the September 1 Flag Raising Ceremony event for no-QR attendees.",
      );
    }

    const parsed = parseNoQrAttendees();
    skippedNoStudentId = parsed.skippedNoStudentId;

    onProgress?.(`Saving ${parsed.rows.length} no-QR attendee record(s) to the FRC event`);
    const result = await saveAttendanceRows({
      eventId: targetEventId,
      eventName: FRC_EVENT_NAME,
      fileName: FRC_NO_QR_FILE,
      fileType: "txt",
      rows: parsed.rows,
    });

    seededImports += 1;
    seededAttendanceRecords += result.savedRecords.length;
    seededNoQrAttendees = result.savedRecords.length;
  }

  onProgress?.("FRC attendee attendance and absence sync finished");

  return {
    alreadySeeded: false,
    seededImports,
    seededAttendanceRecords,
    seededNoQrAttendees,
    skippedNoStudentId,
  };
}
