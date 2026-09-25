import type { NextFunction, Request, Response } from "express";

import type { AuthenticatedRequest } from "./auth.controller";
import {
  createAttendanceRequest,
  listAttendanceRequests,
  listPublicAttendanceRequestsForStudent,
  removeAttendanceRequestEvent,
  reviewAttendanceRequest,
} from "../services/attendance-requests.service";

export async function createRequest(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = await createAttendanceRequest(req.body ?? {});
    res.locals.auditAttendanceRequestType = request.request_type;
    res.status(201).json({
      message:
        request.request_type === "details_correction"
          ? "Details correction request submitted."
          : "Attendance review request submitted.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}


export async function publicStudentRequests(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const rows = await listPublicAttendanceRequestsForStudent(
      req.query.studentId ?? req.query.student_id,
      req.query.schoolYearId ?? req.query.school_year_id,
    );
    res.json({ data: rows });
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
      requestType: req.query.requestType ?? req.query.request_type,
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
    if (result.request) {
      res.locals.auditAttendanceRequestType = result.request.request_type;
    }
    res.json({
      message:
        result.request?.request_type === "details_correction"
          ? result.request.status === "approved"
            ? "Details correction request approved."
            : "Details correction request rejected."
          : result.request?.status === "approved"
            ? "Attendance request approved."
            : "Attendance request rejected.",
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function removeRequestEvent(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = await removeAttendanceRequestEvent(
      req.params.id,
      req.params.eventId,
      req.user?.sub,
    );
    res.json({
      message: "Event removed from attendance request.",
      data: request,
    });
  } catch (error) {
    next(error);
  }
}
