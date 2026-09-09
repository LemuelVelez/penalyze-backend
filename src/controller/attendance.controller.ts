import { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  createAttendanceEvent,
  deleteAttendanceEvent,
  deleteAttendanceFinalResultsByIds,
  deleteAttendanceFinalResultsBySchoolYear,
  deleteAttendanceImport,
  deleteAttendanceImports,
  getAttendanceImportDeleteImpact,
  getAttendanceEventMergeImpact,
  purgeAttendanceImport,
  restoreAttendanceImport,
  deleteCalculationResultsByIds,
  deleteCalculationResultsBySchoolYear,
  deleteAttendanceImportsByIds,
  deleteAttendanceRecord,
  deleteManualAttendanceRecordsByIds,
  deleteManualAttendanceRecordsBySchoolYear,
  getAttendanceImport,
  listAttendanceEvents,
  listAttendanceEventDuplicateGroups,
  listAttendanceFinalResults,
  listCalculationResults,
  listAttendanceImports,
  listAttendanceRecords,
  listManualAttendanceRecords,
  previewAttendanceFiles,
  previewCalculationResults,
  refreshAttendanceFinalResults,
  refreshCalculationResults,
  saveAttendanceFiles,
  saveAttendanceRows,
  saveManualAttendanceRecord,
  mergeAttendanceEvents,
  updateAttendanceEvent,
  updateAttendanceRecord,
  updateAttendanceRecords as updateAttendanceRecordsService,
  UploadedAttendanceFile,
} from "../services/attendance.service";
import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
  AttendanceImportProgress,
} from "../database/model/schema.model";
import type { AuthenticatedRequest } from "./auth.controller";

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

    const error = new Error("Unsupported file. Please upload an .xlsx or .csv file.") as Error & {
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

function getAuthenticatedUserId(req: Request) {
  return (req as AuthenticatedRequest).user?.sub;
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

function parseOptionalBoolean(value: unknown) {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  return undefined;
}

function parseOptionalIndex(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
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
    mergeIntoEventId: req.body?.mergeIntoEventId,
    mergeIntoBatchIndex: parseOptionalIndex(req.body?.mergeIntoBatchIndex),
    forceCreateEvent: parseOptionalBoolean(req.body?.forceCreateEvent),
    keepEventName: req.body?.keepEventName,
    keepEventSchedule: req.body?.keepEventSchedule,
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
    mergeIntoEventId:
      filePayload.mergeIntoEventId ?? commonPayload.mergeIntoEventId,
    mergeIntoBatchIndex:
      parseOptionalIndex(filePayload.mergeIntoBatchIndex) ??
      commonPayload.mergeIntoBatchIndex,
    forceCreateEvent:
      parseOptionalBoolean(filePayload.forceCreateEvent) ??
      commonPayload.forceCreateEvent,
    keepEventName: filePayload.keepEventName ?? commonPayload.keepEventName,
    keepEventSchedule:
      filePayload.keepEventSchedule ?? commonPayload.keepEventSchedule,
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

export async function eventDuplicateGroups(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const schoolYearId = req.query.schoolYearId
      ? String(req.query.schoolYearId).trim()
      : undefined;
    const groups = await listAttendanceEventDuplicateGroups(schoolYearId);
    res.json({ data: groups });
  } catch (error) {
    next(error);
  }
}

export async function eventMergeImpact(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const targetEventId = String(
      req.body?.targetEventId ?? req.query.targetEventId ?? "",
    ).trim();
    const sourceEventIds = parseRecordIds(
      req.body?.sourceEventIds ?? req.query.sourceEventIds,
    );
    if (!targetEventId || !sourceEventIds.length) {
      res.status(400).json({
        message: "Target event ID and at least one source event ID are required.",
      });
      return;
    }
    const impact = await getAttendanceEventMergeImpact(
      targetEventId,
      sourceEventIds,
    );
    res.json({ data: impact });
  } catch (error) {
    next(error);
  }
}

export async function mergeEvents(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const targetEventId = String(req.body?.targetEventId ?? "").trim();
    const sourceEventIds = parseRecordIds(req.body?.sourceEventIds);
    if (!targetEventId || !sourceEventIds.length) {
      res.status(400).json({
        message: "Target event ID and at least one source event ID are required.",
      });
      return;
    }
    const result = await mergeAttendanceEvents({
      targetEventId,
      sourceEventIds,
      mergedBy: getAuthenticatedUserId(req),
      targetName: req.body?.targetName,
      targetEventStartAt: req.body?.targetEventStartAt,
      targetEventEndAt: req.body?.targetEventEndAt,
    });
    res.json({ message: "Attendance events merged successfully.", data: result });
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

    const previews = await previewAttendanceFiles(files);
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
      const fileOptions = files.map((file, index) => ({
        ...getEventPayloadForFile(req, file, index),
        index,
        fileName: file.originalname,
        uploadedBy: getAuthenticatedUserId(req),
      }));
      const result = await saveAttendanceFiles(files, fileOptions);

      res.status(201).json({
        message: "Attendance import batch completed.",
        data: result,
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
      uploadedBy: getAuthenticatedUserId(req),
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
      const fileOptions = files.map((file, index) => ({
        ...getEventPayloadForFile(req, file, index),
        index,
        fileName: file.originalname,
        uploadedBy: getAuthenticatedUserId(req),
        isCancelled,
      }));
      const result = await saveAttendanceFiles(
        files,
        fileOptions,
        (progress) => {
          if (isCancelled()) {
            throw Object.assign(new Error("Attendance import was cancelled."), {
              statusCode: 499,
            });
          }
          writeProgressStreamMessage(res, { type: "progress", progress });
        },
      );

      writeProgressStreamMessage(res, {
        type: "success",
        message: "Attendance import batch completed.",
        data: result,
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
      uploadedBy: getAuthenticatedUserId(req),
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

export async function previewCalculationResultRows(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const records = await previewCalculationResults({
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
      sourceTypes: parseCalculationSourceTypes(
        req.body?.sourceTypes ?? req.body?.source_types,
      ),
    });

    res.json({ message: "Calculation preview generated.", data: records });
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
    const includeDeleted =
      String(req.query.includeDeleted ?? "").trim().toLowerCase() === "true";
    const records = await listAttendanceImports(
      limit,
      offset,
      schoolYearId,
      includeDeleted,
    );

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

    const result = await deleteAttendanceImport(
      importId,
      getAuthenticatedUserId(req),
      req.body?.deleteReason ?? req.body?.delete_reason,
    );
    res.json({
      message: "Attendance import moved to recently deleted.",
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

    if (!importIds.length && !schoolYearId) {
      res.status(400).json({
        message: "School year ID is required when deleting all attendance imports.",
      });
      return;
    }

    const deletedBy = getAuthenticatedUserId(req);
    const deleteReason = req.body?.deleteReason ?? req.body?.delete_reason;
    const result = importIds.length
      ? await deleteAttendanceImportsByIds(importIds, deletedBy, deleteReason)
      : await deleteAttendanceImports(schoolYearId, deletedBy, deleteReason);

    res.json({
      message: "Attendance imports moved to recently deleted.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function restoreImport(
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

    const result = await restoreAttendanceImport(importId);
    res.json({
      message: result.restored
        ? "Attendance import restored successfully."
        : "Attendance import is already active.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function importDeleteImpact(
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

    const result = await getAttendanceImportDeleteImpact(importId);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
}

export async function purgeImport(
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

    const result = await purgeAttendanceImport(importId);
    res.json({
      message: "Attendance import permanently purged.",
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