import { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  createAttendanceEvent,
  deleteAttendanceEvent,
  deleteAttendanceFinalResultsByIds,
  deleteAttendanceFinalResultsBySchoolYear,
  deleteAttendanceImport,
  deleteAttendanceImports,
  deleteCalculationResultsByIds,
  deleteCalculationResultsBySchoolYear,
  deleteAttendanceImportsByIds,
  deleteAttendanceRecord,
  deleteManualAttendanceRecordsByIds,
  deleteManualAttendanceRecordsBySchoolYear,
  getAttendanceImport,
  listAttendanceEvents,
  listAttendanceFinalResults,
  listCalculationResults,
  listAttendanceImports,
  listAttendanceRecords,
  listManualAttendanceRecords,
  previewAttendanceFile,
  refreshAttendanceFinalResults,
  refreshCalculationResults,
  saveAttendanceFile,
  saveAttendanceRows,
  saveManualAttendanceRecord,
  updateAttendanceEvent,
  updateAttendanceRecord,
  updateAttendanceRecords as updateAttendanceRecordsService,
  UploadedAttendanceFile,
} from "../services/attendance.service";
import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceImportProgress,
} from "../database/model/schema.model";

const MAX_FILE_SIZE = Number(
  process.env.ATTENDANCE_UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024,
);

function getUploadFileExtension(fileName: string) {
  const extension = String(fileName ?? "")
    .trim()
    .toLowerCase()
    .match(/\.[a-z0-9]+$/)?.[0];

  return extension ?? "";
}

function isSupportedAttendanceUpload(
  file: Pick<UploadedAttendanceFile, "originalname">,
) {
  const extension = getUploadFileExtension(file.originalname);
  return ACCEPTED_ATTENDANCE_EXTENSIONS.includes(extension as any);
}

export const attendanceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 20,
  },
  fileFilter: (_req, file, callback) => {
    if (isSupportedAttendanceUpload(file)) {
      callback(null, true);
      return;
    }

    const error = new Error("Unsupported file. Please upload an .xlsx file.") as Error & {
      statusCode?: number;
    };
    error.statusCode = 400;
    callback(error);
  },
});

function toPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getRouteParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function parseRecordIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function getBodyRecordIds(req: Request) {
  return parseRecordIds(req.body?.recordIds ?? req.body?.ids);
}

function getRequestRecordIds(req: Request) {
  return parseRecordIds(
    req.body?.recordIds ??
      req.body?.ids ??
      req.query.recordIds ??
      req.query.ids,
  );
}

function getRequestSchoolYearId(req: Request) {
  return String(
    req.body?.schoolYearId ??
      req.body?.school_year_id ??
      req.query.schoolYearId ??
      "",
  ).trim();
}

function parseImportIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

type CalculationSourceType = "imported" | "manual" | "zero_attendance";

const CALCULATION_SOURCE_TYPES = new Set<CalculationSourceType>([
  "imported",
  "manual",
  "zero_attendance",
]);

function parseCalculationSourceTypes(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  return Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter((item): item is CalculationSourceType =>
          CALCULATION_SOURCE_TYPES.has(item as CalculationSourceType),
        ),
    ),
  );
}

function getUploadedFiles(req: Request) {
  const uploadedFiles: UploadedAttendanceFile[] = [];

  if (req.file) {
    uploadedFiles.push(req.file as UploadedAttendanceFile);
  }

  if (Array.isArray(req.files)) {
    uploadedFiles.push(...(req.files as UploadedAttendanceFile[]));
  } else if (req.files && typeof req.files === "object") {
    Object.values(req.files).forEach((files) => {
      uploadedFiles.push(...(files as UploadedAttendanceFile[]));
    });
  }

  return uploadedFiles;
}

function getEventPayload(req: Request) {
  return {
    schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
    eventId: req.body?.eventId,
    eventName: req.body?.eventName,
    eventStartAt: req.body?.eventStartAt,
    eventEndAt: req.body?.eventEndAt,
    eventDescription: req.body?.eventDescription,
    resumeImportId: req.body?.resumeImportId,
  };
}

type AttendanceFileEventPayload = ReturnType<typeof getEventPayload> & {
  fileName?: string;
  index?: number;
};

function getFileEventPayloads(req: Request): AttendanceFileEventPayload[] {
  const rawValue = req.body?.fileOptions;
  if (!rawValue) return [];

  try {
    const parsed =
      typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;
    return Array.isArray(parsed)
      ? (parsed as AttendanceFileEventPayload[])
      : [];
  } catch {
    return [];
  }
}

function getEventPayloadForFile(
  req: Request,
  file: UploadedAttendanceFile,
  index: number,
) {
  const commonPayload = getEventPayload(req);
  const filePayloads = getFileEventPayloads(req);
  const filePayload = filePayloads.find((payload) => {
    if (Number.isInteger(payload?.index) && payload.index === index) return true;
    return String(payload?.fileName ?? "").trim() === file.originalname;
  });

  if (!filePayload) return commonPayload;

  return {
    ...commonPayload,
    schoolYearId: filePayload.schoolYearId ?? commonPayload.schoolYearId,
    eventId: filePayload.eventId ?? commonPayload.eventId,
    eventName: filePayload.eventName ?? commonPayload.eventName,
    eventStartAt: filePayload.eventStartAt ?? commonPayload.eventStartAt,
    eventEndAt: filePayload.eventEndAt ?? commonPayload.eventEndAt,
    eventDescription:
      filePayload.eventDescription ?? commonPayload.eventDescription,
    resumeImportId: filePayload.resumeImportId ?? commonPayload.resumeImportId,
  };
}

type AttendanceBatchFileResult = {
  fileName: string;
  status: "saved" | "failed";
  error: string | null;
  result: Awaited<ReturnType<typeof saveAttendanceFile>> | null;
};

function buildAttendanceBatchResult(files: AttendanceBatchFileResult[]) {
  const savedFiles = files.filter((file) => file.status === "saved");
  const failedFiles = files.length - savedFiles.length;

  return {
    files,
    filesSaved: savedFiles.length,
    filesFailed: failedFiles,
    recordsSaved: savedFiles.reduce(
      (total, file) => total + (file.result?.savedRecords.length ?? 0),
      0,
    ),
    finesCreated: savedFiles.reduce(
      (total, file) => total + (file.result?.createdFines.length ?? 0),
      0,
    ),
  };
}

type AttendanceImportProgressStreamMessage =
  | { type: "progress"; progress: AttendanceImportProgress }
  | { type: "success"; message: string; data: unknown }
  | { type: "error"; message: string };

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function prepareProgressStream(res: Response) {
  res.status(201);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }
}

function writeProgressStreamMessage(
  res: Response,
  message: AttendanceImportProgressStreamMessage,
) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`${JSON.stringify(message)}\n`);
}

export async function events(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const schoolYearId = req.query.schoolYearId
      ? String(req.query.schoolYearId).trim()
      : undefined;
    const records = await listAttendanceEvents(limit, offset, schoolYearId);

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function saveEvent(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await createAttendanceEvent(req.body ?? {});
    res
      .status(201)
      .json({ message: "Attendance event saved successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function updateEvent(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const eventId = getRouteParam(req, "eventId");

    if (!eventId) {
      res.status(400).json({ message: "Attendance event ID is required." });
      return;
    }

    const result = await updateAttendanceEvent(eventId, req.body ?? {});
    res.json({
      message: "Attendance event updated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteEvent(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const eventId = getRouteParam(req, "eventId");

    if (!eventId) {
      res.status(400).json({ message: "Attendance event ID is required." });
      return;
    }

    const result = await deleteAttendanceEvent(eventId);
    res.json({
      message: "Attendance event deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function manualSave(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await saveManualAttendanceRecord(req.body ?? {});
    res
      .status(201)
      .json({ message: "Manual attendance saved successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function updateRecord(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Attendance record ID is required." });
      return;
    }

    const result = await updateAttendanceRecord(id, req.body ?? {});
    res.json({
      message: "Attendance record updated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function updateRecordsBulk(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const recordIds = getBodyRecordIds(req);

    if (!recordIds.length) {
      res.status(400).json({ message: "Attendance record IDs are required." });
      return;
    }

    const payload = { ...(req.body ?? {}) };
    delete payload.recordIds;
    delete payload.ids;

    const result = await updateAttendanceRecordsService(recordIds, payload);

    res.json({
      message: "Attendance records updated successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteRecord(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Attendance record ID is required." });
      return;
    }

    const result = await deleteAttendanceRecord(id);
    res.json({
      message: "Attendance record deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function previewImport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const files = getUploadedFiles(req);
    if (!files.length) {
      res.status(400).json({
        message: "Please upload at least one file using the field name 'files'.",
      });
      return;
    }

    const previews = await Promise.all(
      files.map((file) => previewAttendanceFile(file)),
    );
    res.json({ message: "Files read successfully.", data: previews });
  } catch (error) {
    next(error);
  }
}

export async function saveImport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const files = getUploadedFiles(req);

    if (files.length) {
      const fileResults: AttendanceBatchFileResult[] = [];

      for (const [index, file] of files.entries()) {
        try {
          const result = await saveAttendanceFile(
            file,
            getEventPayloadForFile(req, file, index),
          );
          fileResults.push({
            fileName: file.originalname,
            status: "saved",
            error: null,
            result,
          });
        } catch (error) {
          fileResults.push({
            fileName: file.originalname,
            status: "failed",
            error: getErrorMessage(error, "Unable to save attendance import."),
            result: null,
          });
        }
      }

      res.status(201).json({
        message: "Attendance import batch completed.",
        data: buildAttendanceBatchResult(fileResults),
      });
      return;
    }

    const eventPayload = getEventPayload(req);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      res.status(400).json({
        message:
          "Please upload a file or provide rows from the preview response.",
      });
      return;
    }

    const result = await saveAttendanceRows({
      ...eventPayload,
      fileName: req.body?.fileName ?? "preview-import",
      fileType: req.body?.fileType ?? "json",
      rows,
    });

    res
      .status(201)
      .json({ message: "Attendance imported successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function saveImportWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  let clientCancelled = false;

  const markClientCancelled = () => {
    if (!res.writableEnded) {
      clientCancelled = true;
    }
  };

  req.on("aborted", markClientCancelled);
  res.on("close", markClientCancelled);

  try {
    const files = getUploadedFiles(req);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!files.length && !rows.length) {
      res.status(400).json({
        message:
          "Please upload a file or provide rows from the preview response.",
      });
      return;
    }

    prepareProgressStream(res);

    const isCancelled = () =>
      clientCancelled || res.destroyed || res.writableEnded;

    if (files.length) {
      const fileResults: AttendanceBatchFileResult[] = [];
      let completedRows = 0;
      let completedSavedRecords = 0;
      let completedFines = 0;

      for (const [index, file] of files.entries()) {
        if (isCancelled()) {
          throw Object.assign(new Error("Attendance import was cancelled."), {
            statusCode: 499,
          });
        }

        const onProgress = (progress: AttendanceImportProgress) => {
          if (isCancelled()) {
            throw Object.assign(new Error("Attendance import was cancelled."), {
              statusCode: 499,
            });
          }

          const batchPercent = Math.round(
            ((index + progress.percent / 100) / files.length) * 100,
          );
          writeProgressStreamMessage(res, {
            type: "progress",
            progress: {
              ...progress,
              percent: Math.max(0, Math.min(100, batchPercent)),
              message: `${file.originalname}: ${progress.message}`,
              processedRows: completedRows + progress.processedRows,
              totalRows: completedRows + progress.totalRows,
              savedRecords: completedSavedRecords + progress.savedRecords,
              createdFines: completedFines + progress.createdFines,
            },
          });
        };

        try {
          const result = await saveAttendanceFile(
            file,
            {
              ...getEventPayloadForFile(req, file, index),
              isCancelled,
            },
            onProgress,
          );
          fileResults.push({
            fileName: file.originalname,
            status: "saved",
            error: null,
            result,
          });
          completedRows += result.rowsTotal;
          completedSavedRecords += result.savedRecords.length;
          completedFines += result.createdFines.length;
        } catch (error) {
          if (isCancelled() || (error as any)?.statusCode === 499) {
            throw error;
          }

          fileResults.push({
            fileName: file.originalname,
            status: "failed",
            error: getErrorMessage(error, "Unable to save attendance import."),
            result: null,
          });
        }

        writeProgressStreamMessage(res, {
          type: "progress",
          progress: {
            stage: index === files.length - 1 ? "completed" : "preparing",
            percent: Math.round(((index + 1) / files.length) * 100),
            message:
              index === files.length - 1
                ? "Attendance import batch completed."
                : `Finished ${file.originalname}. Preparing next file...`,
            processedRows: completedRows,
            totalRows: completedRows,
            savedRecords: completedSavedRecords,
            createdFines: completedFines,
          },
        });
      }

      writeProgressStreamMessage(res, {
        type: "success",
        message: "Attendance import batch completed.",
        data: buildAttendanceBatchResult(fileResults),
      });
      res.end();
      return;
    }

    const eventPayload = getEventPayload(req);
    const onProgress = (progress: AttendanceImportProgress) => {
      if (isCancelled()) {
        throw Object.assign(new Error("Attendance import was cancelled."), {
          statusCode: 499,
        });
      }

      writeProgressStreamMessage(res, { type: "progress", progress });
    };

    const result = await saveAttendanceRows({
      ...eventPayload,
      fileName: req.body?.fileName ?? "preview-import",
      fileType: req.body?.fileType ?? "json",
      rows,
      onProgress,
      isCancelled,
    });

    writeProgressStreamMessage(res, {
      type: "success",
      message: "Attendance imported successfully.",
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to save attendance import."),
      });
      res.end();
      return;
    }

    next(error);
  }
}

export async function index(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const studentId = req.query.studentId
      ? String(req.query.studentId).trim()
      : undefined;
    const eventId = req.query.eventId
      ? String(req.query.eventId).trim()
      : undefined;
    const college = req.query.college
      ? String(req.query.college).trim()
      : undefined;
    const schoolYearId = req.query.schoolYearId
      ? String(req.query.schoolYearId).trim()
      : undefined;
    const importIds = req.query.importIds
      ? String(req.query.importIds)
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];
    const records = await listAttendanceRecords(
      limit,
      offset,
      studentId,
      eventId,
      college,
      schoolYearId,
      importIds,
    );

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function finalResults(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const records = await listAttendanceFinalResults({
      schoolYearId: req.query.schoolYearId
        ? String(req.query.schoolYearId).trim()
        : undefined,
      importId: req.query.importId
        ? String(req.query.importId).trim()
        : undefined,
      studentId: req.query.studentId
        ? String(req.query.studentId).trim()
        : undefined,
      college: req.query.college ? String(req.query.college).trim() : undefined,
      limit,
      offset,
    });

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function refreshFinalResults(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const records = await refreshAttendanceFinalResults({
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importId: req.body?.importId ?? req.body?.import_id,
    });

    res.json({ message: "Final attendance results refreshed.", data: records });
  } catch (error) {
    next(error);
  }
}

export async function calculationResults(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const records = await listCalculationResults({
      schoolYearId: req.query.schoolYearId
        ? String(req.query.schoolYearId).trim()
        : undefined,
      importIds: parseImportIds(req.query.importIds),
      sourceTypes: parseCalculationSourceTypes(req.query.sourceTypes),
      studentId: req.query.studentId
        ? String(req.query.studentId).trim()
        : undefined,
      college: req.query.college ? String(req.query.college).trim() : undefined,
      limit,
      offset,
    });

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function refreshCalculationResultRows(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const records = await refreshCalculationResults({
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
      sourceTypes: parseCalculationSourceTypes(
        req.body?.sourceTypes ?? req.body?.source_types,
      ),
    });

    res.json({ message: "Calculation results refreshed.", data: records });
  } catch (error) {
    next(error);
  }
}

export async function deleteCalculationResultRows(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ids = getRequestRecordIds(req);
    const schoolYearId = getRequestSchoolYearId(req);

    if (!ids.length && !schoolYearId) {
      res.status(400).json({
        message: "Calculation result IDs or school year ID are required.",
      });
      return;
    }

    const result = ids.length
      ? await deleteCalculationResultsByIds(ids)
      : await deleteCalculationResultsBySchoolYear(schoolYearId);

    res.json({
      message: "Calculation results deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function manualRecords(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const records = await listManualAttendanceRecords({
      schoolYearId: req.query.schoolYearId
        ? String(req.query.schoolYearId).trim()
        : undefined,
      eventId: req.query.eventId ? String(req.query.eventId).trim() : undefined,
      studentId: req.query.studentId
        ? String(req.query.studentId).trim()
        : undefined,
      college: req.query.college ? String(req.query.college).trim() : undefined,
      limit,
      offset,
    });

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function imports(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = toPositiveInt(req.query.limit, 50);
    const offset = toPositiveInt(req.query.offset, 0);
    const schoolYearId = req.query.schoolYearId
      ? String(req.query.schoolYearId).trim()
      : undefined;
    const records = await listAttendanceImports(limit, offset, schoolYearId);

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function deleteImport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const importId = getRouteParam(req, "importId");

    if (!importId) {
      res.status(400).json({ message: "Attendance import ID is required." });
      return;
    }

    const result = await deleteAttendanceImport(importId);
    res.json({
      message: "Attendance import deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteImports(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const importIds = getRequestRecordIds(req);
    const schoolYearId = getRequestSchoolYearId(req);
    const result = importIds.length
      ? await deleteAttendanceImportsByIds(importIds)
      : await deleteAttendanceImports(schoolYearId || undefined);

    res.json({
      message: "Attendance imports deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteFinalResult(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res
        .status(400)
        .json({ message: "Final attendance result ID is required." });
      return;
    }

    const result = await deleteAttendanceFinalResultsByIds([id]);
    const record = result.deletedRecords[0];

    if (!record) {
      res.status(404).json({ message: "Final attendance result not found." });
      return;
    }

    res.json({
      message: "Final attendance result deleted successfully.",
      data: record,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteFinalResults(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ids = getRequestRecordIds(req);
    const schoolYearId = getRequestSchoolYearId(req);

    if (!ids.length && !schoolYearId) {
      res.status(400).json({
        message: "Final attendance result IDs or school year ID are required.",
      });
      return;
    }

    const result = ids.length
      ? await deleteAttendanceFinalResultsByIds(ids)
      : await deleteAttendanceFinalResultsBySchoolYear(schoolYearId);

    res.json({
      message: "Final attendance results deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteManualRecords(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ids = getRequestRecordIds(req);
    const schoolYearId = getRequestSchoolYearId(req);

    if (!ids.length && !schoolYearId) {
      res.status(400).json({
        message: "Manual attendance record IDs or school year ID are required.",
      });
      return;
    }

    const result = ids.length
      ? await deleteManualAttendanceRecordsByIds(ids)
      : await deleteManualAttendanceRecordsBySchoolYear(schoolYearId);

    res.json({
      message: "Manual attendance records deleted successfully.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function deleteManualRecord(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res
        .status(400)
        .json({ message: "Manual attendance record ID is required." });
      return;
    }

    const result = await deleteManualAttendanceRecordsByIds([id]);
    const record = result.deletedRecords[0];

    if (!record) {
      res.status(404).json({ message: "Manual attendance record not found." });
      return;
    }

    res.json({
      message: "Manual attendance record deleted successfully.",
      data: record,
    });
  } catch (error) {
    next(error);
  }
}

export async function showImport(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const importId = getRouteParam(req, "importId");

    if (!importId) {
      res.status(400).json({ message: "Attendance import ID is required." });
      return;
    }

    const result = await getAttendanceImport(importId);

    if (!result) {
      res.status(404).json({ message: "Attendance import not found." });
      return;
    }

    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}