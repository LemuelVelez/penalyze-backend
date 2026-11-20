import type { NextFunction, Request, Response } from "express";
import { getPublicStudentRecords } from "../services/public-student.service";

export async function publicStudentRecords(req: Request, res: Response, next: NextFunction) {
  try {
    const studentId = req.body?.studentId;
    if (typeof studentId !== "string" || !/^[A-Za-z0-9-]{4,36}$/.test(studentId.trim())) {
      res.status(400).json({ message: "Enter a valid Student ID." });
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
