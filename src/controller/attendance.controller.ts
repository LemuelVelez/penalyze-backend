import { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  createAttendanceEvent,
  deleteAttendanceEvent,
  deleteAttendanceImport,
  deleteAttendanceImports,
  deleteAttendanceRecord,
  getAttendanceImport,
  listAttendanceEvents,
  listAttendanceImports,
  listAttendanceRecords,
  previewAttendanceFile,
  saveAttendanceFile,
  saveAttendanceRows,
  saveManualAttendanceRecord,
  updateAttendanceEvent,
  updateAttendanceRecord,
  UploadedAttendanceFile,
} from "../services/attendance.service";
import { AttendanceImportProgress } from "../database/model/schema.model";

const MAX_FILE_SIZE = Number(
  process.env.ATTENDANCE_UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024,
);
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/octet-stream",
]);

export const attendanceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1,
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype || ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(null, true);
      return;
    }

    callback(
      new Error(
        "Unsupported file. Please upload Excel, TXT/CSV, DOC, or DOCX.",
      ),
    );
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

function getUploadedFile(req: Request) {
  return req.file as UploadedAttendanceFile | undefined;
}

function getEventPayload(req: Request) {
  return {
    eventId: req.body?.eventId,
    eventName: req.body?.eventName,
    eventStartAt: req.body?.eventStartAt,
    eventEndAt: req.body?.eventEndAt,
    eventDescription: req.body?.eventDescription,
    resumeImportId: req.body?.resumeImportId,
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
    const records = await listAttendanceEvents(limit, offset);

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
    const file = getUploadedFile(req);
    if (!file) {
      res
        .status(400)
        .json({ message: "Please upload a file using the field name 'file'." });
      return;
    }

    const preview = await previewAttendanceFile(file);
    res.json({ message: "File read successfully.", data: preview });
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
    const file = getUploadedFile(req);
    const eventPayload = getEventPayload(req);

    if (file) {
      const result = await saveAttendanceFile(file, eventPayload);
      res
        .status(201)
        .json({ message: "Attendance imported successfully.", data: result });
      return;
    }

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      res
        .status(400)
        .json({
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
    const file = getUploadedFile(req);
    const eventPayload = getEventPayload(req);
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

    if (!file && !rows.length) {
      res
        .status(400)
        .json({
          message:
            "Please upload a file or provide rows from the preview response.",
        });
      return;
    }

    prepareProgressStream(res);

    const onProgress = (progress: AttendanceImportProgress) => {
      if (clientCancelled || res.destroyed || res.writableEnded) {
        throw Object.assign(new Error("Attendance import was cancelled."), {
          statusCode: 499,
        });
      }

      writeProgressStreamMessage(res, { type: "progress", progress });
    };

    const isCancelled = () =>
      clientCancelled || res.destroyed || res.writableEnded;

    const result = file
      ? await saveAttendanceFile(
          file,
          { ...eventPayload, isCancelled },
          onProgress,
        )
      : await saveAttendanceRows({
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
    const records = await listAttendanceRecords(
      limit,
      offset,
      studentId,
      eventId,
      college,
    );

    res.json({ data: records });
  } catch (error) {
    next(error);
  }
}

export async function imports(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = toPositiveInt(req.query.limit, 50);
    const offset = toPositiveInt(req.query.offset, 0);
    const records = await listAttendanceImports(limit, offset);

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
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await deleteAttendanceImports();
    res.json({
      message: "Attendance imports deleted successfully.",
      data: result,
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