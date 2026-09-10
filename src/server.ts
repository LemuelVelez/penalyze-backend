import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import multer from "multer";

import {
  attachAuthUser,
  deleteUser,
  listUsers,
  login,
  me,
  register,
  requireAdmin,
  requireAuth,
  updateUser,
} from "./controller/auth.controller";
import { listAuditLogs } from "./controller/audit-logs.controller";
import {
  createRequest as createAttendanceRequest,
  requests as attendanceRequests,
  reviewRequest as reviewAttendanceRequest,
} from "./controller/attendance-requests.controller";
import {
  attendanceUpload,
  calculationResults as attendanceCalculationResults,
  deleteCalculationResultRows as deleteAttendanceCalculationResults,
  deleteEvent as deleteAttendanceEvent,
  deleteFinalResult as deleteAttendanceFinalResult,
  deleteFinalResults as deleteAttendanceFinalResults,
  deleteImport as deleteAttendanceImport,
  deleteImports as deleteAttendanceImports,
  deleteManualRecord as deleteAttendanceManualRecord,
  deleteManualRecords as deleteAttendanceManualRecords,
  deleteRecord as deleteAttendanceRecord,
  events as attendanceEvents,
  eventDuplicateGroups as attendanceEventDuplicateGroups,
  eventMergeImpact as attendanceEventMergeImpact,
  mergeEvents as mergeAttendanceEvents,
  finalResults as attendanceFinalResults,
  imports as attendanceImports,
  importDeleteImpact as attendanceImportDeleteImpact,
  index as attendanceIndex,
  manualRecords as attendanceManualRecords,
  manualSave,
  previewImport,
  previewCalculationResultRows as previewAttendanceCalculationResults,
  purgeImport as purgeAttendanceImport,
  refreshCalculationResultRows as refreshAttendanceCalculationResults,
  refreshFinalResults as refreshAttendanceFinalResults,
  saveEvent as saveAttendanceEvent,
  saveImport,
  saveImportWithProgress,
  showImport,
  restoreImport as restoreAttendanceImport,
  updateEvent as updateAttendanceEvent,
  updateRecord as updateAttendanceRecord,
  updateRecordsBulk as updateAttendanceRecordsBulk,
} from "./controller/attendance.controller";
import {
  deletePenalty,
  deletePenaltyResultRow,
  deletePenaltyResultRows,
  fines,
  matchPenalty,
  penalties,
  penaltyResults,
  penaltyResultAbsentEvents,
  penaltyResultColleges,
  refreshPenaltyResultRows,
  registerZeroAttendance,
  savePenalty,
  seedPenalties,
  summary,
  updatePenalty,
  updatePenaltyResultRow,
  updatePenaltyResultRowStatus,
  updateStatus,
} from "./controller/fines.controller";
import {
  activate as activateSchoolYear,
  assignCurrent as assignCurrentSchoolYearRecords,
  deleteRecords as deleteSchoolYearRecords,
  deleteImpact as schoolYearDeleteImpact,
  index as schoolYears,
  remove as deleteSchoolYear,
  save as saveSchoolYear,
  transfer as transferSchoolYearRecords,
  update as updateSchoolYear,
} from "./controller/school-years.controller";
import { query } from "./lib/db";
import { purgeExpiredAttendanceImports } from "./services/attendance.service";
import { auditMutation } from "./services/audit-log.service";

const app = express();
const attendanceBatchUpload = attendanceUpload.fields([
  { name: "files", maxCount: 20 },
  { name: "file", maxCount: 20 },
]);

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_FRONTEND_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8081",
  "https://penalyze.jrmsu-tc.online",
];

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function parseAllowedOrigins() {
  const configuredOrigins = [
    process.env.CORS_ORIGIN,
    process.env.FRONTEND_ORIGINS,
    process.env.FRONTEND_URL,
    process.env.Frontend_URL,
  ]
    .flatMap((value) => String(value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  return Array.from(
    new Set([...configuredOrigins, ...DEFAULT_FRONTEND_ORIGINS]),
  );
}

const ALLOWED_ORIGINS = parseAllowedOrigins();
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestOrigin = req.headers.origin
    ? normalizeOrigin(req.headers.origin)
    : "";
  const allowedOrigin =
    requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)
      ? requestOrigin
      : "";

  if (allowedOrigin) {
    res.header("Access-Control-Allow-Origin", allowedOrigin);
    res.header("Vary", "Origin");
  } else if (!requestOrigin && ALLOWED_ORIGINS[0]) {
    res.header("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }

  res.header("Access-Control-Allow-Credentials", "true");
  res.header(
    "Access-Control-Allow-Methods",
    "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  );
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With",
  );

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(attachAuthUser);
app.use(auditMutation);

app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "Penalyze backend is running.",
    api: "/api",
  });
});

app.get(
  "/api/health",
  async (_req: Request, res: Response, next: NextFunction) => {
    try {
      await query("SELECT 1");
      res.json({ ok: true, database: "connected" });
    } catch (error) {
      next(error);
    }
  },
);

app.post("/api/auth/register", register);
app.post("/api/auth/login", login);
app.get("/api/auth/me", requireAuth, me);

app.get("/api/users", requireAuth, requireAdmin, listUsers);
app.patch("/api/users/:id", requireAuth, requireAdmin, updateUser);
app.put("/api/users/:id", requireAuth, requireAdmin, updateUser);
app.delete("/api/users/:id", requireAuth, requireAdmin, deleteUser);

app.get("/api/audit-logs", requireAuth, requireAdmin, listAuditLogs);

app.get("/api/school-years", schoolYears);
app.post("/api/school-years", saveSchoolYear);
app.patch("/api/school-years/transfer", transferSchoolYearRecords);
app.patch(
  "/api/school-years/:id/assign-current",
  assignCurrentSchoolYearRecords,
);
app.get("/api/school-years/:id/delete-impact", schoolYearDeleteImpact);
app.delete("/api/school-years/:id/records", deleteSchoolYearRecords);
app.patch("/api/school-years/:id/activate", activateSchoolYear);
app.patch("/api/school-years/:id", updateSchoolYear);
app.put("/api/school-years/:id", updateSchoolYear);
app.delete("/api/school-years/:id", deleteSchoolYear);


app.post("/api/attendance/requests", createAttendanceRequest);
app.get("/api/attendance/requests", requireAuth, attendanceRequests);
app.patch(
  "/api/attendance/requests/:id/review",
  requireAuth,
  reviewAttendanceRequest,
);

app.get("/api/attendance/events", attendanceEvents);
app.get(
  "/api/attendance/events/duplicates",
  requireAuth,
  attendanceEventDuplicateGroups,
);
app.post(
  "/api/attendance/events/merge-impact",
  requireAuth,
  requireAdmin,
  attendanceEventMergeImpact,
);
app.post(
  "/api/attendance/events/merge",
  requireAuth,
  requireAdmin,
  mergeAttendanceEvents,
);
app.post("/api/attendance/events", saveAttendanceEvent);
app.put("/api/attendance/events/:eventId", updateAttendanceEvent);
app.patch("/api/attendance/events/:eventId", updateAttendanceEvent);
app.delete("/api/attendance/events/:eventId", deleteAttendanceEvent);
app.get("/api/attendance/final-results", attendanceFinalResults);
app.delete("/api/attendance/final-results", deleteAttendanceFinalResults);
app.delete("/api/attendance/final-results/:id", deleteAttendanceFinalResult);
app.post(
  "/api/attendance/final-results/refresh",
  refreshAttendanceFinalResults,
);
app.get("/api/attendance/calculation-results", attendanceCalculationResults);
app.delete(
  "/api/attendance/calculation-results",
  deleteAttendanceCalculationResults,
);
app.post(
  "/api/attendance/calculation-results/preview",
  previewAttendanceCalculationResults,
);
app.post(
  "/api/attendance/calculation-results/refresh",
  refreshAttendanceCalculationResults,
);
app.get("/api/attendance/manual-records", attendanceManualRecords);
app.delete("/api/attendance/manual-records", deleteAttendanceManualRecords);
app.delete("/api/attendance/manual-records/:id", deleteAttendanceManualRecord);
app.get("/api/attendance", attendanceIndex);
app.get("/api/attendance/imports", requireAuth, attendanceImports);
app.delete(
  "/api/attendance/imports",
  requireAuth,
  deleteAttendanceImports,
);
app.get(
  "/api/attendance/imports/:importId/delete-impact",
  requireAuth,
  attendanceImportDeleteImpact,
);
app.post(
  "/api/attendance/imports/:importId/restore",
  requireAuth,
  restoreAttendanceImport,
);
app.delete(
  "/api/attendance/imports/:importId/purge",
  requireAuth,
  requireAdmin,
  purgeAttendanceImport,
);
app.get("/api/attendance/imports/:importId", requireAuth, showImport);
app.delete(
  "/api/attendance/imports/:importId",
  requireAuth,
  deleteAttendanceImport,
);
app.post("/api/attendance/manual", manualSave);
app.post(
  "/api/attendance/import/preview",
  attendanceBatchUpload,
  previewImport,
);
app.post(
  "/api/attendance/import/save/progress",
  requireAuth,
  attendanceBatchUpload,
  saveImportWithProgress,
);
app.post(
  "/api/attendance/import/save",
  requireAuth,
  attendanceBatchUpload,
  saveImport,
);
app.put("/api/attendance/bulk", updateAttendanceRecordsBulk);
app.patch("/api/attendance/bulk", updateAttendanceRecordsBulk);
app.put("/api/attendance/:id", updateAttendanceRecord);
app.patch("/api/attendance/:id", updateAttendanceRecord);
app.delete("/api/attendance/:id", deleteAttendanceRecord);

app.get("/api/fines", fines);
app.get("/api/fines/summary", summary);
app.get("/api/fines/penalty-results/colleges", penaltyResultColleges);
app.get("/api/fines/penalty-results/:id/absent-events", penaltyResultAbsentEvents);
app.get("/api/fines/penalty-results", penaltyResults);
app.delete("/api/fines/penalty-results", deletePenaltyResultRows);
app.delete("/api/fines/penalty-results/:id", deletePenaltyResultRow);
app.post("/api/fines/penalty-results/refresh", refreshPenaltyResultRows);
app.put("/api/fines/penalty-results/:id", updatePenaltyResultRow);
app.patch("/api/fines/penalty-results/:id", updatePenaltyResultRow);
app.patch(
  "/api/fines/penalty-results/:id/status",
  updatePenaltyResultRowStatus,
);
app.post("/api/fines/zero-attendance", registerZeroAttendance);
app.patch("/api/fines/:id/status", updateStatus);
app.get("/api/fines/penalties", penalties);
app.post("/api/fines/penalties", savePenalty);
app.post("/api/fines/penalties/seed", seedPenalties);
app.get("/api/fines/penalties/match/:noOfAbsences", matchPenalty);
app.put("/api/fines/penalties/:id", updatePenalty);
app.patch("/api/fines/penalties/:id", updatePenalty);
app.delete("/api/fines/penalties/:id", deletePenalty);

const configuredAttendanceRetentionSweepMs = Number(
  process.env.ATTENDANCE_IMPORT_RETENTION_SWEEP_MS ?? 6 * 60 * 60 * 1000,
);
const ATTENDANCE_RETENTION_SWEEP_MS =
  Number.isFinite(configuredAttendanceRetentionSweepMs) &&
  configuredAttendanceRetentionSweepMs > 0
    ? Math.max(60_000, configuredAttendanceRetentionSweepMs)
    : 6 * 60 * 60 * 1000;

if (process.env.ATTENDANCE_IMPORT_RETENTION_ENABLED !== "false") {
  const runAttendanceRetentionSweep = () => {
    void purgeExpiredAttendanceImports().catch((error) => {
      console.error("Attendance import retention purge failed:", error);
    });
  };

  const initialSweep = setTimeout(runAttendanceRetentionSweep, 10_000);
  initialSweep.unref();
  const retentionInterval = setInterval(
    runAttendanceRetentionSweep,
    ATTENDANCE_RETENTION_SWEEP_MS,
  );
  retentionInterval.unref();
}

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: "Route not found." });
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(
    error instanceof multer.MulterError
      ? 400
      : (error?.statusCode ?? error?.status ?? 500),
  );
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = error?.message || "Internal server error.";

  res.status(safeStatus).json({
    message,
    ...(process.env.NODE_ENV === "production" ? {} : { stack: error?.stack }),
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});