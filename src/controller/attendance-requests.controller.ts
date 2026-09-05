import type { NextFunction, Request, Response } from "express";

import type { AuthenticatedRequest } from "./auth.controller";
import {
  createAttendanceRequest,
  listAttendanceRequests,
  reviewAttendanceRequest,
} from "../services/attendance-requests.service";

export async function createRequest(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = await createAttendanceRequest(req.body ?? {});
    res.status(201).json({
      message: "Attendance review request submitted.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}

export async function requests(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const rows = await listAttendanceRequests({
      status: req.query.status,
      schoolYearId: req.query.schoolYearId ?? req.query.school_year_id,
      studentId: req.query.studentId ?? req.query.student_id,
    });
    res.json({ data: rows });
  } catch (error) {
    next(error);
  }
}

export async function reviewRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await reviewAttendanceRequest(
      req.params.id,
      req.user?.sub,
      req.body ?? {},
    );
    res.json({
      message:
        result.request?.status === "approved"
          ? "Attendance request approved."
          : "Attendance request rejected.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}
