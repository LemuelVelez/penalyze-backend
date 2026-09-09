import "dotenv/config";

import fs from "fs";
import path from "path";
import zlib from "zlib";

import { query } from "../../lib/db";
import {
  previewAttendanceFiles,
  saveAttendanceFiles,
  saveAttendanceRows,
  type UploadedAttendanceFile,
} from "../../services/attendance.service";

type SourceEntry = {
  name: string;
  buffer: Buffer;
};

type SeederResult = {
  alreadySeeded: boolean;
  skipped: boolean;
  sourcePath: string;
  seededImports: number;
  seededAttendanceRecords: number;
  seededStudentsWithoutQr: number;
};

function clean(value: unknown) {
  return String(value ?? "").trim();
}

function walkDirectory(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkDirectory(fullPath) : [fullPath];
  });
}

function readZipEntries(zipPath: string): SourceEntry[] {
  const zip = fs.readFileSync(zipPath);
  let eocdOffset = -1;
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 65_557); offset -= 1) {
    if (zip.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error(`Invalid ZIP archive: ${zipPath}`);

  const entryCount = zip.readUInt16LE(eocdOffset + 10);
  let centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const entries: SourceEntry[] = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (zip.readUInt32LE(centralOffset) !== 0x02014b50) break;
    const compressionMethod = zip.readUInt16LE(centralOffset + 10);
    const compressedSize = zip.readUInt32LE(centralOffset + 20);
    const fileNameLength = zip.readUInt16LE(centralOffset + 28);
    const extraLength = zip.readUInt16LE(centralOffset + 30);
    const commentLength = zip.readUInt16LE(centralOffset + 32);
    const localOffset = zip.readUInt32LE(centralOffset + 42);
    const name = zip
      .subarray(centralOffset + 46, centralOffset + 46 + fileNameLength)
      .toString("utf8");

    if (!name.endsWith("/")) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) {
        throw new Error(`Invalid ZIP local entry: ${name}`);
      }
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataOffset, dataOffset + compressedSize);
      const buffer =
        compressionMethod === 0
          ? Buffer.from(compressed)
          : compressionMethod === 8
            ? zlib.inflateRawSync(compressed)
            : (() => {
                throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
              })();
      entries.push({ name, buffer });
    }

    centralOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function readSourceEntries(sourcePath: string): SourceEntry[] {
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    return walkDirectory(sourcePath).map((filePath) => ({
      name: path.relative(sourcePath, filePath).replace(/\\/g, "/"),
      buffer: fs.readFileSync(filePath),
    }));
  }

  if (path.extname(sourcePath).toLowerCase() === ".zip") {
    return readZipEntries(sourcePath);
  }

  return [{ name: path.basename(sourcePath), buffer: fs.readFileSync(sourcePath) }];
}

function toUploadedFile(entry: SourceEntry): UploadedAttendanceFile {
  return {
    originalname: path.basename(entry.name),
    buffer: entry.buffer,
    size: entry.buffer.length,
  };
}

function parseNoQrRows(entry: SourceEntry) {
  return entry.buffer
    .toString("utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^\d+\.\s*(.*?)\s+(TC-[A-Z0-9-]+)\s*$/i);
      if (!match) return null;
      return {
        studentId: match[2].toUpperCase(),
        name: match[1].trim(),
        noOfAbsences: 0,
        remarks: "Seeded participant without QR scan during flag raising ceremony.",
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

async function getExistingImports(fileNames: string[]) {
  if (!fileNames.length) return [];
  const result = await query<{
    id: string;
    file_name: string;
    event_id: string | null;
  }>(
    `
      SELECT id, file_name, event_id
      FROM attendance_imports
      WHERE LOWER(TRIM(file_name)) = ANY($1::text[])
        AND status = 'saved'
        AND deleted_at IS NULL
      ORDER BY created_at DESC
    `,
    [fileNames.map((name) => name.trim().toLowerCase())],
  );
  return result.rows;
}

export async function seedParticipants(): Promise<SeederResult> {
  const sourcePath = clean(process.env.SEED_PARTICIPANTS_PATH);
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return {
      alreadySeeded: true,
      skipped: true,
      sourcePath,
      seededImports: 0,
      seededAttendanceRecords: 0,
      seededStudentsWithoutQr: 0,
    };
  }

  const entries = readSourceEntries(sourcePath);
  const attendanceEntries = entries.filter((entry) =>
    [".xlsx", ".csv"].includes(path.extname(entry.name).toLowerCase()),
  );
  const noQrEntries = entries.filter(
    (entry) =>
      path.extname(entry.name).toLowerCase() === ".txt" &&
      /no\s*qr|flag\s*raising/i.test(entry.name + entry.buffer.toString("utf8", 0, 120)),
  );
  const importFileNames = [
    ...attendanceEntries.map((entry) => path.basename(entry.name)),
    ...noQrEntries.map((entry) => path.basename(entry.name)),
  ];
  const existingImports = await getExistingImports(importFileNames);
  const existingNames = new Set(
    existingImports.map((record) => record.file_name.trim().toLowerCase()),
  );
  const missingAttendanceEntries = attendanceEntries.filter(
    (entry) => !existingNames.has(path.basename(entry.name).toLowerCase()),
  );
  const missingNoQrEntries = noQrEntries.filter(
    (entry) => !existingNames.has(path.basename(entry.name).toLowerCase()),
  );

  if (!missingAttendanceEntries.length && !missingNoQrEntries.length) {
    return {
      alreadySeeded: true,
      skipped: false,
      sourcePath,
      seededImports: 0,
      seededAttendanceRecords: 0,
      seededStudentsWithoutQr: 0,
    };
  }

  const configuredEventName =
    clean(process.env.SEED_PARTICIPANTS_EVENT_NAME) || "Flag Raising Ceremony";
  let targetEventId = existingImports.find((record) => record.event_id)?.event_id ?? null;
  let seededImports = 0;
  let seededAttendanceRecords = 0;

  if (missingAttendanceEntries.length) {
    const files = missingAttendanceEntries.map(toUploadedFile);
    const previews = await previewAttendanceFiles(files);
    const existingCandidateEventId = previews
      .flatMap((preview) => preview.detectedEvent.mergeCandidates ?? [])
      .find(
        (candidate) =>
          candidate.source === "existing" && candidate.confidence !== "low" && candidate.eventId,
      )?.eventId;
    targetEventId = targetEventId ?? existingCandidateEventId ?? null;

    const fileOptions = files.map((file, index) => ({
      index,
      fileName: file.originalname,
      eventName: configuredEventName,
      mergeIntoEventId: targetEventId || undefined,
      mergeIntoBatchIndex: !targetEventId && index > 0 ? 0 : undefined,
      forceCreateEvent: !targetEventId && index === 0,
      keepEventName: "incoming" as const,
      keepEventSchedule: index === 0 ? ("incoming" as const) : ("existing" as const),
    }));
    const batch = await saveAttendanceFiles(files, fileOptions);
    seededImports += batch.filesSaved;
    seededAttendanceRecords += batch.recordsSaved;
    targetEventId = batch.files[0]?.result.event?.id ?? targetEventId;
  }

  if (!targetEventId) {
    const refreshedImports = await getExistingImports(importFileNames);
    targetEventId = refreshedImports.find((record) => record.event_id)?.event_id ?? null;
  }

  let seededStudentsWithoutQr = 0;
  for (const entry of missingNoQrEntries) {
    const rows = parseNoQrRows(entry);
    if (!rows.length || !targetEventId) continue;
    const result = await saveAttendanceRows({
      eventId: targetEventId,
      eventName: configuredEventName,
      fileName: path.basename(entry.name),
      fileType: "txt",
      rows,
    });
    seededImports += 1;
    seededAttendanceRecords += result.savedRecords.length;
    seededStudentsWithoutQr += result.savedRecords.length;
  }

  return {
    alreadySeeded: false,
    skipped: false,
    sourcePath,
    seededImports,
    seededAttendanceRecords,
    seededStudentsWithoutQr,
  };
}
