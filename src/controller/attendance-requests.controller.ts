import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

import type { AuthenticatedRequest } from "./auth.controller";
import {
  createAttendanceRequest,
  listAttendanceRequests,
  listPublicAttendanceRequestsForStudent,
  lookupPublicStudentById,
  removeAttendanceRequestEvent,
  preflightAttendanceRequestReview,
  preflightAttendanceRequestGroupReview,
  reviewAttendanceRequestGroup,
  reviewAttendanceRequest,
} from "../services/attendance-requests.service";
import { prepareProgressStream, writeProgressStreamMessage } from "../lib/progress-stream";

const RECEIPT_AUDIENCE = "penalyze-attendance-request-receipt";
const RECEIPT_ISSUER = process.env.JWT_ISSUER || "penalyze-api";
const RECEIPT_SECRET = process.env.JWT_SECRET!;
const RECEIPT_EXPIRY = "90d";

function getReceiptIds(receipts: unknown): string[] {
  if (!Array.isArray(receipts) || receipts.length > 20 ||
      receipts.some((receipt) => typeof receipt !== "string" || receipt.length > 1024)) {
    return [];
  }
  const ids = new Set<string>();
  for (const receipt of receipts) {
    try {
      const value = jwt.verify(receipt, RECEIPT_SECRET, {
        algorithms: ["HS256"], issuer: RECEIPT_ISSUER, audience: RECEIPT_AUDIENCE,
      });
      if (typeof value === "object" && value.purpose === "student-status" &&
          typeof value.requestId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.requestId)) {
        ids.add(value.requestId);
      }
    } catch { /* Invalid or expired receipts grant no access. */ }
  }
  return [...ids];
}


export async function createRequest(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const request = await createAttendanceRequest(req.body ?? {});
    res.locals.auditAttendanceRequestType = request.request_type;
    const statusToken = jwt.sign(
      { purpose: "student-status", requestId: request.id },
      RECEIPT_SECRET,
      { algorithm: "HS256", audience: RECEIPT_AUDIENCE, issuer: RECEIPT_ISSUER, expiresIn: RECEIPT_EXPIRY },
    );
    // Never echo full student profile or evidence links to anonymous submitters.
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json({
      message: "Request submitted for review. Track its status with your Student ID.",
      data: { id: request.id, statusToken },
    });
  } catch (error) {
    next(error);
  }
}


export async function publicStudentLookup(req: Request, res: Response, next: NextFunction) {
  try {
    const studentId = req.body?.studentId;
    if (typeof studentId !== "string" || !/^[A-Za-z0-9-]{4,36}$/.test(studentId.trim())) {
      res.status(400).json({ message: "Enter a valid Student ID." });
      return;
    }
    const data = await lookupPublicStudentById(studentId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ data });
  } catch (error) { next(error); }
}

export async function publicStudentRequests(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const ids = getReceiptIds(req.body?.receipts);
    const rows = ids.length ? await listPublicAttendanceRequestsForStudent(ids) : [];
    res.setHeader("Cache-Control", "no-store");
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

function getStreamErrorMessage(error: unknown, fallback: string) {
  const raw = error as { statusCode?: number; message?: string; code?: string } | null;
  if (raw && [400, 401, 403, 404, 409, 422].includes(raw.statusCode ?? 0) &&
      typeof raw.message === "string" && raw.message.length <= 700 && !raw.code) {
    return raw.message;
  }
  const requestId = randomUUID();
  console.error(`[${requestId}] Attendance request review stream failed:`, error);
  return `${fallback} Reference: ${requestId}.`;
}

function getReviewSuccessMessage(result: Awaited<ReturnType<typeof reviewAttendanceRequest>>) {
  if ("autoClosedByExemption" in result && result.autoClosedByExemption) {
    return "Attendance request closed automatically: all events are exempted.";
  }
  return result.request?.request_type === "details_correction"
    ? result.request.status === "approved"
      ? "Details correction request approved."
      : "Details correction request rejected."
    : result.request?.request_type === "zero_attendance"
      ? result.request.status === "approved"
        ? "No-participation declaration approved."
        : "No-participation declaration rejected."
      : result.request?.status === "approved"
        ? "Attendance request approved."
        : "Attendance request rejected.";
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
      message: getReviewSuccessMessage(result),
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function reviewRequestWithProgress(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const preflight = await preflightAttendanceRequestReview(
      req.params.id,
      req.user?.sub,
      req.body ?? {},
    );
    res.locals.auditAttendanceRequestType = preflight.request_type;

    prepareProgressStream(res, 200);
    const result = await reviewAttendanceRequest(
      req.params.id,
      req.user?.sub,
      req.body ?? {},
      (progress) => {
        writeProgressStreamMessage(res, { type: "progress", progress });
      },
    );

    if (result.request) {
      res.locals.auditAttendanceRequestType = result.request.request_type;
    }
    writeProgressStreamMessage(res, {
      type: "success",
      message: getReviewSuccessMessage(result),
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getStreamErrorMessage(error, "Unable to review attendance request."),
      });
      res.end();
      return;
    }

    next(error);
  }
}

function getGroupReviewSuccessMessage(
  result: Awaited<ReturnType<typeof reviewAttendanceRequestGroup>>,
  studentId: string,
  status: "approved" | "rejected",
) {
  const count = status === "approved" ? result.approvedCount : result.rejectedCount;
  const autoClosed = result.autoClosedCount
    ? ` ${result.autoClosedCount} request(s) auto-closed by exemption.`
    : "";
  return `${status === "approved" ? "Approved" : "Rejected"} ${count} request(s) for ${studentId}.${autoClosed}`;
}

export async function reviewRequestGroup(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const result = await reviewAttendanceRequestGroup(req.user?.sub, req.body ?? {});
    res.locals.auditAttendanceRequestType = result.requests.every(
      (request) => request.request_type === "details_correction",
    ) ? "details_correction" : result.requests.every(
      (request) => request.request_type === "zero_attendance",
    ) ? "zero_attendance" : "event_review";
    res.json({
      message: getGroupReviewSuccessMessage(result, String(req.body.studentId).trim(), result.rejectedCount ? "rejected" : "approved"),
      data: result,
    });
  } catch (error) {
    next(error);
  }
}

export async function reviewRequestGroupWithProgress(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const preflight = await preflightAttendanceRequestGroupReview(
      req.user?.sub,
      req.body ?? {},
    );
    res.locals.auditAttendanceRequestType = preflight.every(
      (request) => request.request_type === "details_correction",
    ) ? "details_correction" : preflight.every(
      (request) => request.request_type === "zero_attendance",
    ) ? "zero_attendance" : "event_review";
    prepareProgressStream(res, 200);
    const result = await reviewAttendanceRequestGroup(
      req.user?.sub,
      req.body ?? {},
      (progress) => writeProgressStreamMessage(res, { type: "progress", progress }),
    );
    writeProgressStreamMessage(res, {
      type: "success",
      message: getGroupReviewSuccessMessage(result, String(req.body.studentId).trim(), result.rejectedCount ? "rejected" : "approved"),
      data: result,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.locals.auditOutcome = "failed";
      writeProgressStreamMessage(res, {
        type: "error",
        message: getStreamErrorMessage(error, "Unable to review attendance request group."),
      });
      res.end();
      return;
    }
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
