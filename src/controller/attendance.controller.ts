import { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  getAttendanceImport,
  listAttendanceImports,
  listAttendanceRecords,
  previewAttendanceFile,
  saveAttendanceFile,
  saveAttendanceRows,
  UploadedAttendanceFile
} from "../services/attendance.service";

const MAX_FILE_SIZE = Number(process.env.ATTENDANCE_UPLOAD_MAX_BYTES ?? 10 * 1024 * 1024);
const ALLOWED_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/plain",
  "text/csv",
  "application/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/msword",
  "application/octet-stream"
]);

export const attendanceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype || ALLOWED_MIME_TYPES.has(file.mimetype)) {
      callback(null, true);
      return;
    }

    callback(new Error("Unsupported file. Please upload Excel, TXT/CSV, DOC, or DOCX."));
  }
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

export async function previewImport(req: Request, res: Response, next: NextFunction) {
  try {
    const file = getUploadedFile(req);
    if (!file) {
      res.status(400).json({ message: "Please upload a file using the field name 'file'." });
      return;
    }

    const preview = await previewAttendanceFile(file);
    res.json({ message: "File read successfully.", data: preview });
  } catch (error) {
    next(error);
  }
}

export async function saveImport(req: Request, res: Response, next: NextFunction) {
  try {
    const file = getUploadedFile(req);

    if (file) {
      const result = await saveAttendanceFile(file);
      res.status(201).json({ message: "Attendance imported successfully.", data: result });
      return;
    }

    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      res.status(400).json({ message: "Please upload a file or provide rows from the preview response." });
      return;
    }

    const result = await saveAttendanceRows({
      fileName: req.body?.fileName ?? "preview-import",
      fileType: req.body?.fileType ?? "json",
      rows
    });

    res.status(201).json({ message: "Attendance imported successfully.", data: result });
  } catch (error) {
    next(error);
  }
}

export async function index(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = toPositiveInt(req.query.limit, 100);
    const offset = toPositiveInt(req.query.offset, 0);
    const studentId = req.query.studentId ? String(req.query.studentId).trim() : undefined;
    const records = await listAttendanceRecords(limit, offset, studentId);

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

export async function showImport(req: Request, res: Response, next: NextFunction) {
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