import { runSubmittedJob } from "../services/maintenance-jobs.service";
import { pool } from "../lib/db";
import { isMasterlistActiveForSchoolYear, masterlistActiveError, MANUAL_ATTENDANCE_MASTERLIST_MESSAGE, ZERO_ATTENDANCE_MASTERLIST_MESSAGE } from "../services/masterlist.service";
import { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import multer from "multer";

import {
  createAttendanceEvent,
  createEventCollegeExemptions,
  createEventYearLevelExemptions,
  deleteAttendanceEvent,
  deleteEventCollegeExemption,
  deleteEventCollegeExemptionsBulk,
  deleteEventExemptionsByIds,
  deleteEventYearLevelExemption,
  deleteEventYearLevelExemptionsBulk,
  deleteAttendanceFinalResultsByIds,
  deleteAttendanceFinalResultsBySchoolYear,
  deleteAttendanceImport,
  deleteAttendanceImports,
  getAttendanceImportDeleteImpact,
  getAttendanceDashboardOverview,
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
  getCalculationStatus,
  getCalculationPendingSummary,
  getEventCollegeExemptionImpact,
  getEventCollegeChecker,
  getEventYearLevelExemptionImpact,
  listAttendanceEvents,
  listAttendanceColleges,
  listEventCollegeExemptions,
  listEventYearLevelExemptions,
  listAttendanceEventDuplicateGroups,
  listAttendanceFinalResults,
  listCalculationResults,
  listAttendanceImports,
  listAttendanceRecords,
  listManualAttendanceRecords,
  previewAttendanceFiles,
  prepareAttendanceFilesForSave,
  prepareAttendanceRowsForSave,
  isValidAttendanceUploadCollege,
  previewCalculationResults,
  refreshAttendanceFinalResults,
  refreshCalculationResults,
  repairCalculationConsistency,
  saveAttendanceFiles,
  saveAttendanceRows,
  saveManualAttendanceRecord,
  saveManualAttendanceRecords,
  setStudentEventAttendance,
  setStudentEventAttendances,
  mergeAttendanceEvents,
  updateAttendanceEvent,
  updateAttendanceFinalResultProfile,
  type AttendanceFinalResultProfileProgress,
  updateAttendanceRecord,
  updateAttendanceRecords as updateAttendanceRecordsService,
  UploadedAttendanceFile,
} from "../services/attendance.service";
import {
  ACCEPTED_ATTENDANCE_EXTENSIONS,
} from "../database/model/schema.model";
import type { AuthenticatedRequest } from "./auth.controller";
import { prepareProgressStream, writeProgressStreamMessage } from "../lib/progress-stream";

const MAX_FILE_SIZE = Number(
  Math.max(1024, Math.min(Number(process.env.ATTENDANCE_UPLOAD_MAX_BYTES ?? 5 * 1024 * 1024) || 5 * 1024 * 1024, 5 * 1024 * 1024)),
);

function getMaintenanceActor(req: Request) {
  const user=(req as AuthenticatedRequest).user;
  return user ? {sub:user.sub,name:user.name,email:user.email,role:user.role} : undefined;
}
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

function createSpreadsheetUpload(validateMime: boolean) {
  return multer({
    storage: multer.memoryStorage(),
    defParamCharset: "utf8",
    limits: {
      fileSize: MAX_FILE_SIZE,
      files: 10,
    },
    fileFilter: (_req, file, callback) => {
      const extension = getUploadFileExtension(file.originalname);
      const mime = String(file.mimetype ?? "").toLowerCase();
      const allowedMime = extension === ".xlsx"
        ? ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream"]
        : ["text/csv", "text/plain", "application/vnd.ms-excel", "application/octet-stream"];
      if (isSupportedAttendanceUpload(file) && (!validateMime || allowedMime.includes(mime)) && file.originalname.length <= 180) {
        file.originalname = file.originalname.split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._() -]/gu, "_");
        callback(null, true);
        return;
      }

      const error = new Error("Unsupported file. Please upload an .xlsx or .csv file.") as Error & {
        statusCode?: number;
      };
      error.statusCode = 400;
      (error as Error & { expose?: boolean }).expose = true;
      callback(error);
    },
  });
}

export const attendanceUpload = createSpreadsheetUpload(true);
// Masterlist uploads validate the workbook contents in masterlist.service.ts.
// Browser/OS MIME guesses are not a reliable way to identify Excel files.
export const masterlistUpload = createSpreadsheetUpload(false);

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
  if (values.length > 1000) {
    throw Object.assign(new Error("A bulk operation can include at most 1000 IDs."), { statusCode: 400, expose: true });
  }

  const ids = Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  if (ids.length > 1000 || ids.some((id) => id.length > 128)) {
    throw Object.assign(new Error("A bulk operation can include at most 1000 valid IDs."), { statusCode: 400, expose: true });
  }
  return ids;
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

async function runAttendanceMaintenance<T>(req:Request,res:Response,kind:string,operation:string,body:Record<string,unknown>,finalResultId?:string) {
  const rawYear=body.schoolYearId ?? body.school_year_id;
  const schoolYearId=typeof rawYear==="string" && rawYear ? rawYear : null;
  const actor=getAuthenticatedUserId(req);
  const timer=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write("\n");},15000);timer.unref();
  try {
    return await runSubmittedJob<T>(kind,schoolYearId,{operation,body,finalResultId},actor,progress=>{
      const stage=progress.stage === "finalizing" && progress.percent<50 ? operation === "remove" ? "removing_exemptions" : kind === "manual_batch" ? "saving_events" : kind === "final_result_event_batch" ? "saving_override" : "saving_exemptions" : progress.stage;
      writeProgressStreamMessage(res,{type:"progress",progress:{...progress,stage,completed:progress.processed}});
    },()=>req.aborted||res.destroyed||res.writableEnded);
  } finally {clearInterval(timer);}
}
function getAuthenticatedUserId(req: Request) {
  return (req as AuthenticatedRequest).user?.sub;
}

function parseImportIds(value: unknown) {
  const values = Array.isArray(value) ? value : [value];

  const ids = Array.from(
    new Set(
      values
        .flatMap((item) => String(item ?? "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
  if (ids.length > 1000 || ids.some((id) => id.length > 128)) {
    throw Object.assign(new Error("A bulk operation can include at most 1000 valid IDs."), { statusCode: 400, expose: true });
  }
  return ids;
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
    college: req.body?.college,
    rowCollegeOverrides: req.body?.rowCollegeOverrides,
    rowEventOverrides: req.body?.rowEventOverrides,
    rowEventsReviewed: parseOptionalBoolean(req.body?.rowEventsReviewed),
    eventId: req.body?.eventId,
    eventName: req.body?.eventName,
    eventStartAt: req.body?.eventStartAt,
    eventEndAt: req.body?.eventEndAt,
    eventDescription: req.body?.eventDescription,
    resumeImportId: req.body?.resumeImportId,
    mergeIntoEventId: req.body?.mergeIntoEventId,
    mergeIntoBatchIndex: parseOptionalIndex(req.body?.mergeIntoBatchIndex),
    forceCreateEvent: parseOptionalBoolean(req.body?.forceCreateEvent),
    allowExemptedRows: parseOptionalBoolean(req.body?.allowExemptedRows),
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
    college: filePayload.college ?? commonPayload.college,
    rowCollegeOverrides: filePayload.rowCollegeOverrides ?? commonPayload.rowCollegeOverrides,
    rowEventOverrides: filePayload.rowEventOverrides ?? commonPayload.rowEventOverrides,
    rowEventsReviewed: parseOptionalBoolean(filePayload.rowEventsReviewed) ?? commonPayload.rowEventsReviewed,
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
    allowExemptedRows:
      parseOptionalBoolean(filePayload.allowExemptedRows) ??
      commonPayload.allowExemptedRows,
    keepEventName: filePayload.keepEventName ?? commonPayload.keepEventName,
    keepEventSchedule:
      filePayload.keepEventSchedule ?? commonPayload.keepEventSchedule,
  };
}

function getErrorMessage(error: unknown, fallback: string) {
  // Streaming has already sent headers, so the central error handler cannot
  // send its usual JSON error. Only our explicit validation errors are safe to
  // surface; never return a database error, SQL statement or exception stack.
  const raw = error as { statusCode?: number; message?: string; code?: string } | null;
  if (raw && [400, 404, 409, 422].includes(raw.statusCode ?? 0) &&
    typeof raw.message === "string" && raw.message.length <= 700 && !raw.code) {
    return raw.message;
  }
  const requestId = randomUUID();
  console.error(`[${requestId}] Attendance import stream failed:`, error);
  return `${fallback} Reference: ${requestId}. Check the backend logs before retrying; the import may already be saved.`;
}

export async function colleges(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({ data: await listAttendanceColleges() });
  } catch (error) {
    next(error);
  }
}

export async function eventExemptions(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listEventCollegeExemptions({
      schoolYearId: req.query.schoolYearId ?? req.query.school_year_id,
      eventId: req.query.eventId ?? req.query.event_id,
      college: req.query.college,
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function eventCollegeChecker(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getEventCollegeChecker({
      schoolYearId: req.query.schoolYearId ?? req.query.school_year_id,
      eventId: req.query.eventId ?? req.query.event_id,
    });
    res.json({ message: "College attendance checker loaded.", data });
  } catch (error) {
    next(error);
  }
}

export async function eventExemptionImpact(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getEventCollegeExemptionImpact(req.body ?? {});
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function saveEventExemptions(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createEventCollegeExemptions({
      ...(req.body ?? {}),
      createdBy: getAuthenticatedUserId(req),
    });
    res.status(201).json({ message: "College exemptions saved and fines recalculated.", data });
  } catch (error) {
    next(error);
  }
}

export async function saveEventExemptionsWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    prepareProgressStream(res, 201);
    const data = await runAttendanceMaintenance<Awaited<ReturnType<typeof createEventCollegeExemptions>>>(req,res,"event_exemptions","college",{...(req.body??{}),createdBy:getAuthenticatedUserId(req)});

    writeProgressStreamMessage(res, {
      type: "success",
      message: "College exemptions saved and fines recalculated.",
      data,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to save college exemptions."),
      });
      res.end();
      return;
    }

    next(error);
  }
}

export async function removeEventExemptionsBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await deleteEventCollegeExemptionsBulk(req.body ?? {});
    res.json({
      message: "College exemptions removed and fines recalculated.",
      data,
    });
  } catch (error) {
    next(error);
  }
}

export async function removeEventExemption(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");
    const data = await deleteEventCollegeExemption(id);
    res.json({ message: "College exemption removed and fines recalculated.", data });
  } catch (error) {
    next(error);
  }
}

export async function removeSelectedEventExemptionsWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    prepareProgressStream(res, 200);
    const data = await runAttendanceMaintenance<Awaited<ReturnType<typeof deleteEventExemptionsByIds>>>(req,res,"event_exemptions","remove",req.body??{});

    writeProgressStreamMessage(res, {
      type: "success",
      message: "Selected exemptions removed and fines recalculated.",
      data,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to remove selected exemptions."),
      });
      res.end();
      return;
    }

    next(error);
  }
}

export async function eventYearLevelExemptions(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listEventYearLevelExemptions({
      schoolYearId: req.query.schoolYearId ?? req.query.school_year_id,
      eventId: req.query.eventId ?? req.query.event_id,
      yearLevel: req.query.yearLevel ?? req.query.year_level,
      college: req.query.college,
    });
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function eventYearLevelExemptionImpact(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getEventYearLevelExemptionImpact(req.body ?? {});
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function saveEventYearLevelExemptions(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await createEventYearLevelExemptions({
      ...(req.body ?? {}),
      createdBy: getAuthenticatedUserId(req),
    });
    res.status(201).json({ message: "Year level exemptions saved and fines recalculated.", data });
  } catch (error) {
    next(error);
  }
}

export async function saveEventYearLevelExemptionsWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    prepareProgressStream(res, 201);
    const data = await runAttendanceMaintenance<Awaited<ReturnType<typeof createEventYearLevelExemptions>>>(req,res,"event_exemptions","year_level",{...(req.body??{}),createdBy:getAuthenticatedUserId(req)});

    writeProgressStreamMessage(res, {
      type: "success",
      message: "Year level exemptions saved and fines recalculated.",
      data,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to save year level exemptions."),
      });
      res.end();
      return;
    }

    next(error);
  }
}

export async function removeEventYearLevelExemptionsBulk(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await deleteEventYearLevelExemptionsBulk(req.body ?? {});
    res.json({ message: "Year level exemptions removed and fines recalculated.", data });
  } catch (error) {
    next(error);
  }
}

export async function removeEventYearLevelExemption(req: Request, res: Response, next: NextFunction) {
  try {
    const id = getRouteParam(req, "id");
    const data = await deleteEventYearLevelExemption(id);
    res.json({ message: "Year level exemption removed and fines recalculated.", data });
  } catch (error) {
    next(error);
  }
}

export async function events(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(200, toPositiveInt(req.query.limit, 100));
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

async function guardManualAttendance(body: Record<string, unknown>) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const rawYear = body.schoolYearId ?? body.school_year_id;
  const rawEvent = (Array.isArray(body.eventIds) ? body.eventIds[0] : undefined) ?? body.eventId ?? body.event_id;
  const schoolYearId = typeof rawYear === "string" && uuid.test(rawYear) ? rawYear : undefined;
  const eventId = typeof rawEvent === "string" && uuid.test(rawEvent) ? rawEvent : undefined;
  const client = await pool.connect();
  try {
    const eventIds = Array.isArray(body.eventIds) ? body.eventIds.filter((id): id is string => typeof id === "string" && uuid.test(id)) : eventId ? [eventId] : [];
    if (await isMasterlistActiveForSchoolYear(client, schoolYearId, { eventId, eventIds })) {
      const zero = (Array.isArray(body.eventIds) && body.eventIds.length === 0) || body.attendanceType === "zero_attendance" || body.attendance_type === "zero_attendance";
      throw masterlistActiveError(zero ? ZERO_ATTENDANCE_MASTERLIST_MESSAGE : MANUAL_ATTENDANCE_MASTERLIST_MESSAGE);
    }
  } finally { client.release(); }
}

export async function manualSave(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    await guardManualAttendance(req.body ?? {});
    const result = await saveManualAttendanceRecord(req.body ?? {});
    res
      .status(201)
      .json({ message: "Manual attendance saved successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function manualBatchSave(req: Request, res: Response, next: NextFunction) {
  try {
    await guardManualAttendance(req.body ?? {});
    const result = await saveManualAttendanceRecords(req.body ?? {});
    res.status(201).json({ message: "Manual attendance saved successfully.", data: result });
  } catch (error) { next(error); }
}

export async function manualBatchSaveWithProgress(req: Request, res: Response, next: NextFunction) {
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  try {
    await guardManualAttendance(req.body ?? {});
    prepareProgressStream(res, 200);
    keepAlive = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write("\n"); }, 15_000);
    keepAlive.unref();
    const result = await runAttendanceMaintenance<Awaited<ReturnType<typeof saveManualAttendanceRecords>>>(req,res,"manual_batch","save",req.body??{});
    writeProgressStreamMessage(res, { type: "success", message: "Manual attendance saved successfully.", data: result });
    if (!res.destroyed && !res.writableEnded) res.end();
  } catch (error) {
    if (!res.headersSent) return next(error);
    res.locals.auditOutcome = "failed";
    const raw = error as { expose?: boolean; message?: string; code?: string };
    writeProgressStreamMessage(res, { type: "error", message: raw.expose ? raw.message || "Unable to save manual attendance." : "Unable to save manual attendance.", ...(raw.code === "MASTERLIST_ACTIVE" ? { code: raw.code } : {}) });
    if (!res.destroyed && !res.writableEnded) res.end();
  } finally { if (keepAlive) clearInterval(keepAlive); }
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

    const previews = await previewAttendanceFiles(files, getEventPayload(req).college, undefined, true, getEventPayload(req).schoolYearId);
    res.json({ message: "Attendance preview completed.", data: previews });
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
      if (fileOptions.some((option) => !isValidAttendanceUploadCollege(option.college))) {
        res.status(400).json({ message: "Select a college before uploading." });
        return;
      }
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

    if (!isValidAttendanceUploadCollege(eventPayload.college)) {
      res.status(400).json({ message: "Select a college before uploading." });
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

    const selectedColleges = files.length
      ? files.map((file, index) => getEventPayloadForFile(req, file, index).college)
      : [getEventPayload(req).college];
    if (selectedColleges.some((college) => !isValidAttendanceUploadCollege(college))) {
      res.status(400).json({ message: "Select a college before uploading." });
      return;
    }

    prepareProgressStream(res, 201);
    // Keep the NDJSON connection open during long whole-year recalculations;
    // blank lines are ignored by the stream parser, so they carry no student data.
    const keepAlive = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write("\n");
    }, 15_000);
    keepAlive.unref();
    res.once("close", () => clearInterval(keepAlive));

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
      const prepared=await prepareAttendanceFilesForSave(files,fileOptions.map(({isCancelled:_cancel,...option})=>option));
      const result=await runSubmittedJob<Awaited<ReturnType<typeof saveAttendanceFiles>>>("attendance_import_save",null,{operation:"files",body:prepared},getAuthenticatedUserId(req),progress=>writeProgressStreamMessage(res,{type:"progress",progress:{stage:progress.percent<25?"saving":"syncing",percent:progress.percent,message:progress.message,processedRows:progress.processed??0,totalRows:progress.total??0,savedRecords:0,createdFines:0}}),isCancelled);

      writeProgressStreamMessage(res, {
        type: "success",
        message: "Attendance import batch completed.",
        data: result,
      });
      res.end();
      return;
    }

    const eventPayload = getEventPayload(req);
    if (!isValidAttendanceUploadCollege(eventPayload.college)) {
      res.status(400).json({ message: "Select a college before uploading." });
      return;
    }
    const prepared=prepareAttendanceRowsForSave({...eventPayload,uploadedBy:getAuthenticatedUserId(req),fileName:req.body?.fileName??"preview-import",fileType:req.body?.fileType??"json",rows});
    const result=await runSubmittedJob<Awaited<ReturnType<typeof saveAttendanceRows>>>("attendance_import_save",eventPayload.schoolYearId??null,{operation:"rows",body:prepared},getAuthenticatedUserId(req),progress=>writeProgressStreamMessage(res,{type:"progress",progress:{stage:progress.percent<25?"saving":"syncing",percent:progress.percent,message:progress.message,processedRows:progress.processed??0,totalRows:progress.total??0,savedRecords:0,createdFines:0}}),isCancelled);

    writeProgressStreamMessage(res, {
      type: "success",
      message: "Attendance imported successfully.",
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
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

export async function dashboardOverview(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const schoolYearId = req.query.schoolYearId
      ? String(req.query.schoolYearId).trim()
      : undefined;
    const data = await getAttendanceDashboardOverview(schoolYearId);
    res.json({ data });
  } catch (error) {
    next(error);
  }
}

export async function index(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(200, toPositiveInt(req.query.limit, 100));
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
    const zeroAttendanceOnly =
      String(req.query.zeroAttendanceOnly ?? "").trim().toLowerCase() === "true";
    const records = await listAttendanceRecords(
      limit,
      offset,
      studentId,
      eventId,
      college,
      schoolYearId,
      importIds,
      zeroAttendanceOnly,
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
    const limit = Math.min(200, toPositiveInt(req.query.limit, 100));
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
      studentProfile: req.query.studentName !== undefined || req.query.studentCollege !== undefined || req.query.studentProgram !== undefined ? {
        name: String(req.query.studentName ?? ""),
        college: String(req.query.studentCollege ?? ""),
        program: String(req.query.studentProgram ?? ""),
      } : undefined,
      college: req.query.college ? String(req.query.college).trim() : undefined,
      includeMissedEvents:
        String(req.query.includeMissedEvents ?? "")
          .trim()
          .toLowerCase() === "true",
      includeEventDetails:
        String(req.query.includeEventDetails ?? "")
          .trim()
          .toLowerCase() === "true",
      consolidatedOnly:
        String(req.query.consolidatedOnly ?? "")
          .trim()
          .toLowerCase() === "true",
      limit,
      offset,
    });

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function updateStudentEventAttendance(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");
    const eventId = getRouteParam(req, "eventId");
    if (!id || !eventId || typeof req.body?.attended !== "boolean") {
      res.status(400).json({ message: "Student, event, and a boolean attended status are required." });
      return;
    }

    const result = await setStudentEventAttendance(
      id,
      eventId,
      req.body.attended,
      getAuthenticatedUserId(req),
    );
    res.json({ message: "Student event attendance updated successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function updateStudentEventAttendanceWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");
    const eventId = getRouteParam(req, "eventId");
    if (!id || !eventId || typeof req.body?.attended !== "boolean") {
      res.status(400).json({ message: "Student, event, and a boolean attended status are required." });
      return;
    }

    prepareProgressStream(res);
    const result = await setStudentEventAttendance(
      id,
      eventId,
      req.body.attended,
      getAuthenticatedUserId(req),
      (progress) => writeProgressStreamMessage(res, { type: "progress", progress }),
    );
    writeProgressStreamMessage(res, {
      type: "success",
      message: "Student event attendance updated successfully.",
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to update event attendance."),
      });
      res.end();
      return;
    }
    next(error);
  }
}


export async function updateStudentEventAttendancesWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");
    if (!id || !Array.isArray(req.body?.changes)) {
      res.status(400).json({ message: "Student and event changes are required." });
      return;
    }

    prepareProgressStream(res);
    const result = await runAttendanceMaintenance<Awaited<ReturnType<typeof setStudentEventAttendances>>>(req,res,"final_result_event_batch","save",req.body??{},id);
    writeProgressStreamMessage(res, {
      type: "success",
      message: "Selected student event attendance updated successfully.",
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getErrorMessage(error, "Unable to update selected events."),
      });
      res.end();
      return;
    }
    next(error);
  }
}

export async function updateFinalResultProfile(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const id = getRouteParam(req, "id");

    if (!id) {
      res.status(400).json({ message: "Final attendance result ID is required." });
      return;
    }

    const result = await updateAttendanceFinalResultProfile(id, req.body ?? {});
    res.json({
      message: "Student attendance details updated successfully.",
      data: result,
    });
  } catch (error) {
    const requestId = randomUUID();
    console.error(`[${requestId}] Attendance profile update failed:`, error);
    res.locals.auditOutcome = "failed";
    next(error);
  }
}

export async function updateFinalResultProfileWithProgress(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const id = getRouteParam(req, "id");
  if (!id) {
    res.status(400).json({ message: "Final attendance result ID is required." });
    return;
  }
  let lastProgress: AttendanceFinalResultProfileProgress = { percent: 0, message: "Preparing student profile update." };
  let stageStarted = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    prepareProgressStream(res);
    const emit = (progress: AttendanceFinalResultProfileProgress) => {
      lastProgress = progress;
      stageStarted = Date.now();
      writeProgressStreamMessage(res, { type: "progress", progress });
    };
    emit(lastProgress);
    heartbeat = setInterval(() => {
      const seconds = Math.floor((Date.now() - stageStarted) / 1000);
      writeProgressStreamMessage(res, {
        type: "progress",
        progress: { ...lastProgress, message: `${lastProgress.message} (${seconds}s in this stage)` },
      });
    }, 5000);
    const result = await updateAttendanceFinalResultProfile(id, req.body ?? {}, emit, () => res.destroyed || res.writableEnded);
    writeProgressStreamMessage(res, { type: "success", message: "Student attendance details updated successfully.", data: result });
    res.end();
  } catch (error) {
    if (!res.headersSent) { next(error); return; }
    res.locals.auditOutcome = "failed";
    const requestId = randomUUID();
    console.error(`[${requestId}] Attendance profile update failed:`, error);
    const raw = error as { code?: string; statusCode?: number; expose?: boolean; message?: string };
    const messages: Record<string, string> = {
      "57014": "The profile save exceeded the database statement timeout and was rolled back.",
      "55P03": "A database row remained locked during the profile save. The transaction was rolled back.",
      "40P01": "The profile save conflicted with another update. The transaction was rolled back.",
      "40001": "The profile save conflicted with another update. The transaction was rolled back.",
      "23505": "A duplicate record blocked the profile save. The transaction was rolled back.",
    };
    const message = raw?.code && Object.prototype.hasOwnProperty.call(messages, raw.code)
      ? messages[raw.code]
      : raw?.expose === true && !raw.code && raw.message
        ? raw.message : "Unable to save student details. Check the attendance result before retrying.";
    writeProgressStreamMessage(res, { type: "error", message: `${message} (Request ID: ${requestId})` });
    res.end();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
}

export async function refreshFinalResults(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const records = await runSubmittedJob<Awaited<ReturnType<typeof refreshAttendanceFinalResults>>>("derived_refresh",req.body?.schoolYearId ?? req.body?.school_year_id ?? null,{operation:"final",body:{
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importId: req.body?.importId ?? req.body?.import_id,
    },actor:getMaintenanceActor(req)},getAuthenticatedUserId(req),undefined,()=>req.aborted||res.destroyed||res.writableEnded);

    res.json({ message: "Final attendance results refreshed.", data: records });
  } catch (error) {
    next(error);
  }
}

export async function calculationPendingSummary(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const summary = await getCalculationPendingSummary(
      req.query.schoolYearId
        ? String(req.query.schoolYearId).trim()
        : undefined,
    );

    res.json({ data: summary });
  } catch (error) {
    next(error);
  }
}

export async function calculationStatus(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const status = await getCalculationStatus({
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
      sourceTypes: parseCalculationSourceTypes(
        req.body?.sourceTypes ?? req.body?.source_types,
      ),
    });

    res.json({ data: status });
  } catch (error) {
    next(error);
  }
}

export async function repairCalculationConsistencyRows(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await runSubmittedJob<Awaited<ReturnType<typeof repairCalculationConsistency>>>("derived_refresh",req.body?.schoolYearId ?? req.body?.school_year_id ?? null,{operation:"repair",body:{
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
      sourceTypes: parseCalculationSourceTypes(
        req.body?.sourceTypes ?? req.body?.source_types,
      ),
    },actor:getMaintenanceActor(req)},getAuthenticatedUserId(req),undefined,()=>req.aborted||res.destroyed||res.writableEnded);
    res.json({
      message: result.repaired
        ? "Inconsistent attendance totals were automatically corrected for all affected groups."
        : "All expected-event totals are already consistent.",
      data: result,
    });
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
    const limit = Math.min(200, toPositiveInt(req.query.limit, 100));
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
    const records = await runSubmittedJob<Awaited<ReturnType<typeof refreshCalculationResults>>>("derived_refresh",req.body?.schoolYearId ?? req.body?.school_year_id ?? null,{operation:"calculations",body:{
      schoolYearId: req.body?.schoolYearId ?? req.body?.school_year_id,
      importIds: parseImportIds(req.body?.importIds ?? req.body?.import_ids),
      sourceTypes: parseCalculationSourceTypes(
        req.body?.sourceTypes ?? req.body?.source_types,
      ),
    },actor:getMaintenanceActor(req)},getAuthenticatedUserId(req),undefined,()=>req.aborted||res.destroyed||res.writableEnded);

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
    const limit = Math.min(200, toPositiveInt(req.query.limit, 100));
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
    const limit = Math.min(200, toPositiveInt(req.query.limit, 50));
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