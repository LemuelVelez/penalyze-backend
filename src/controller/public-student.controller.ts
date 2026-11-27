import { isPlaceholderStudentNumber, placeholderStudentNumberMessage } from "../services/masterlist-normalize";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { writeProgressStreamMessage } from "../lib/progress-stream";
import { getPublicStudentRecords } from "../services/public-student.service";

export async function publicStudentRecords(req: Request, res: Response, next: NextFunction) {
  try {
    const studentId = req.body?.studentId;
    if (typeof studentId !== "string" || !/^[A-Za-z0-9-]{4,36}$/.test(studentId.trim())) {
      res.status(400).json({ message: "Enter a valid Student ID." });
      return;
    }

    if (isPlaceholderStudentNumber(studentId)) { res.status(400).json({ message: placeholderStudentNumberMessage(studentId.trim()) }); return; }
    // Keep the existing JSON contract for clients that do not opt into progress.
    if (req.body?.progress === true) {
      const requestId = randomUUID();
      res.setHeader("X-Request-ID", requestId);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      // Blank NDJSON lines keep idle connections active without inventing progress.
      const heartbeat = setInterval(() => {
        if (!res.destroyed && !res.writableEnded) res.write("\n");
      }, 8_000);
      res.once("close", () => clearInterval(heartbeat));
      try {
        const data = await getPublicStudentRecords(studentId, (progress) => {
          if (res.destroyed || res.writableEnded) throw new Error("Public lookup disconnected.");
          writeProgressStreamMessage(res, { type: "progress", progress });
        });
        const found = data.profile || data.attendance.length || data.manualAttendance.length ||
          data.finalResults.length || data.fines.length || data.penaltyResults.length;
        writeProgressStreamMessage(res, { type: "success", message: "Student records checked.", data: found ? data : null });
      } catch (error) {
        if (!res.destroyed && !res.writableEnded) {
          console.error(`[${requestId}] Public student lookup failed`, error);
          const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
          const statusCode = typeof error === "object" && error !== null && "statusCode" in error ? error.statusCode : undefined;
          const message = statusCode === 400 && error instanceof Error
            ? error.message
            : code === "57014" || code === "55P03"
              ? "The database is busy checking attendance records. Please try again shortly."
              : "Unable to load student records. Please try again.";
          res.locals.auditOutcome = "failed";
          writeProgressStreamMessage(res, { type: "error", message: `${message} (Request ID: ${requestId})` });
        }
      } finally {
        clearInterval(heartbeat);
        if (!res.destroyed && !res.writableEnded) res.end();
      }
      return;
    }
    const data = await getPublicStudentRecords(studentId);
    const found = data.profile || data.attendance.length || data.manualAttendance.length ||
      data.finalResults.length || data.fines.length || data.penaltyResults.length;
    res.setHeader("Cache-Control", "no-store");
    res.json({ data: found ? data : null });
  } catch (error) {
    next(error);
  }
}
