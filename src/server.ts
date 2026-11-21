import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";
import multer from "multer";
import crypto from "crypto";
import helmet from "helmet";

import {
  attachAuthUser,
  changePassword,
  deleteUser,
  listUsers,
  login,
  logoutSession,
  logoutEverywhere,
  me,
  register,
  requireAdmin,
  requireAuth,
  updateUser,
} from "./controller/auth.controller";
import { listAuditLogCategories, listAuditLogs } from "./controller/audit-logs.controller";
import { publicStudentRecords } from "./controller/public-student.controller";
import {
  createRequest as createAttendanceRequest,
  requests as attendanceRequests,
  publicStudentRequests as publicAttendanceStudentRequests,
  publicStudentLookup as publicAttendanceStudentLookup,
  removeRequestEvent as removeAttendanceRequestEvent,
  reviewRequest as reviewAttendanceRequest,
  reviewRequestWithProgress as reviewAttendanceRequestWithProgress,
  reviewRequestGroup as reviewAttendanceRequestGroup,
  reviewRequestGroupWithProgress as reviewAttendanceRequestGroupWithProgress,
} from "./controller/attendance-requests.controller";
import {
  attendanceUpload,
  calculationResults as attendanceCalculationResults,
  calculationPendingSummary as attendanceCalculationPendingSummary,
  calculationStatus as attendanceCalculationStatus,
  colleges as attendanceColleges,
  deleteCalculationResultRows as deleteAttendanceCalculationResults,
  deleteEvent as deleteAttendanceEvent,
  deleteFinalResult as deleteAttendanceFinalResult,
  deleteFinalResults as deleteAttendanceFinalResults,
  deleteImport as deleteAttendanceImport,
  deleteImports as deleteAttendanceImports,
  deleteManualRecord as deleteAttendanceManualRecord,
  deleteManualRecords as deleteAttendanceManualRecords,
  deleteRecord as deleteAttendanceRecord,
  dashboardOverview as attendanceDashboardOverview,
  events as attendanceEvents,
  eventDuplicateGroups as attendanceEventDuplicateGroups,
  eventExemptions as attendanceEventExemptions,
  eventCollegeChecker as attendanceEventCollegeChecker,
  eventExemptionImpact as attendanceEventExemptionImpact,
  eventYearLevelExemptions as attendanceEventYearLevelExemptions,
  eventYearLevelExemptionImpact as attendanceEventYearLevelExemptionImpact,
  eventMergeImpact as attendanceEventMergeImpact,
  mergeEvents as mergeAttendanceEvents,
  removeEventExemption as removeAttendanceEventExemption,
  removeEventExemptionsBulk as removeAttendanceEventExemptionsBulk,
  removeSelectedEventExemptionsWithProgress as removeSelectedAttendanceEventExemptionsWithProgress,
  removeEventYearLevelExemption as removeAttendanceEventYearLevelExemption,
  removeEventYearLevelExemptionsBulk as removeAttendanceEventYearLevelExemptionsBulk,
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
  repairCalculationConsistencyRows as repairAttendanceCalculationConsistency,
  refreshFinalResults as refreshAttendanceFinalResults,
  saveEvent as saveAttendanceEvent,
  saveEventExemptions as saveAttendanceEventExemptions,
  saveEventExemptionsWithProgress as saveAttendanceEventExemptionsWithProgress,
  saveEventYearLevelExemptions as saveAttendanceEventYearLevelExemptions,
  saveEventYearLevelExemptionsWithProgress as saveAttendanceEventYearLevelExemptionsWithProgress,
  saveImport,
  saveImportWithProgress,
  showImport,
  restoreImport as restoreAttendanceImport,
  updateEvent as updateAttendanceEvent,
  updateFinalResultProfile as updateAttendanceFinalResultProfile,
  updateStudentEventAttendance,
  updateStudentEventAttendanceWithProgress,
  updateStudentEventAttendancesWithProgress,
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
import {
  changeRepositorySync,
  downloadRepositoryUpload,
  listRepositoryUploads,
  restoreRepositoryUploadedStatus,
} from "./controller/penalyze-sync.controller";
import { query } from "./lib/db";
import { purgeExpiredAttendanceImports } from "./services/attendance.service";
import { auditMutation } from "./services/audit-log.service";
import { limitLoginTraffic } from "./services/login-protection.service";
import { rateLimit, limits, clientIp } from "./services/rate-limit.service";

const app = express();
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: { directives: {
    defaultSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"], formAction: ["'none'"],
  } },
}));
// Trust forwarded client IPs only when a known number of reverse proxies are
// enforced by the deployment. Never trust arbitrary X-Forwarded-For headers.
const trustedProxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
app.set("trust proxy", Number.isInteger(trustedProxyHops) && trustedProxyHops >= 0 ? trustedProxyHops : 0);
const attendanceBatchUpload = attendanceUpload.fields([
  { name: "files", maxCount: 10 },
  { name: "file", maxCount: 10 },
]);

const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_FRONTEND_ORIGINS = ["http://localhost:5173", "http://localhost:8081"];
function parseAllowedOrigins(): string[] {
  const fromEnv = (process.env.FRONTEND_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const list = process.env.NODE_ENV === "production" ? fromEnv : [...fromEnv, ...DEFAULT_FRONTEND_ORIGINS];
  for (const origin of list) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== origin || (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")) {
        throw new Error("Invalid origin");
      }
    }
    catch { throw new Error(`Invalid FRONTEND_ORIGINS entry: ${origin}`); }
  }
  if (process.env.NODE_ENV === "production" && !list.length) {
    throw new Error("FRONTEND_ORIGINS must be configured explicitly in production.");
  }
  return Array.from(new Set(list));
}
const ALLOWED_ORIGINS = parseAllowedOrigins();
const API_ORIGIN = process.env.BACKEND_URL?.trim() || "";

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.get("origin") ?? "";
  const allowed = ALLOWED_ORIGINS.includes(origin) || (API_ORIGIN !== "" && origin === API_ORIGIN);
  res.setHeader("Vary", "Origin");
  if (origin && !allowed) {
    res.status(403).json({ message: "Origin not allowed." });
    return;
  }
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", "Retry-After");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Penalyze-Request");
  if (req.method === "OPTIONS") { res.sendStatus(204); return; }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.path.startsWith("/api/")) {
    if (!allowed || req.get("x-penalyze-request") !== "1") {
      res.status(403).json({ message: "Request origin verification failed." });
      return;
    }
  }
  next();
});

// Verify the cookie against the database before any large request body is parsed.
app.use(attachAuthUser);
app.use("/api/auth/login", limitLoginTraffic);
const smallJson = express.json({ limit: "100kb" });
const largeJson = express.json({ limit: "5mb" });
const smallForm = express.urlencoded({ extended: false, limit: "100kb", parameterLimit: 80 });
const largeRoutes = [
  /^\/api\/attendance\/bulk$/,
  /^\/api\/attendance\/calculation-results\/(preview|refresh|repair-consistency)$/,
  /^\/api\/attendance\/events\/merge$/,
  /^\/api\/attendance\/final-results\/[^/]+\/events\/batch\/progress$/,
  /^\/api\/school-years\/transfer$/,
];
app.use((req: Request, res: Response, next: NextFunction) => {
  if (largeRoutes.some((pattern) => pattern.test(req.path))) {
    return requireAuth(req, res, () => largeJson(req, res, next));
  }
  smallJson(req, res, next);
});
app.use(smallForm);
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
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  },
);


// Student record lookups are often performed from shared school networks. Keep
// a generous network-wide ceiling while limiting repeated checks of one ID.
const publicStudentRecordIdentity = (req: Request) =>
  `${clientIp(req)}:${String(req.body?.studentId ?? "").trim().toLowerCase()}`;
const publicStudentRecordsRateLimit = limits(
  ["student-records:ip-student:minute", 6, 60, publicStudentRecordIdentity],
  ["student-records:ip-student:day", 100, 86400, publicStudentRecordIdentity],
  ["student-records:ip:minute", 60, 60, clientIp],
  ["student-records:ip:day", 3000, 86400, clientIp],
);
const publicStudentStatusRateLimit = limits(
  ["student-status:minute", 30, 60, clientIp],
  ["student-status:day", 600, 86400, clientIp],
);
const publicRequestRateLimit = limits(
  ["requests:ip", 5, 3600, clientIp],
  ["requests:id", 5, 3600, (req) => String(req.body?.studentId ?? "").slice(0, 50)],
);

app.post("/api/auth/register", requireAuth, requireAdmin, register);
app.post("/api/auth/login", login);
app.post("/api/auth/logout", requireAuth, logoutSession);
app.post("/api/auth/logout-everywhere", requireAuth, logoutEverywhere);
app.get("/api/auth/me", requireAuth, me);
app.post("/api/auth/change-password", requireAuth, changePassword);

app.get("/api/users", requireAuth, requireAdmin, listUsers);
app.patch("/api/users/:id", requireAuth, requireAdmin, updateUser);
app.put("/api/users/:id", requireAuth, requireAdmin, updateUser);
app.delete("/api/users/:id", requireAuth, requireAdmin, deleteUser);

app.get("/api/audit-logs", requireAuth, requireAdmin, listAuditLogs);
app.get("/api/audit-logs/categories", requireAuth, requireAdmin, listAuditLogCategories);

// Browser calls Penalyze only; the repository integration key stays server-side.
app.get("/api/repository-sync/uploads", requireAuth, requireAdmin, listRepositoryUploads);
app.get("/api/repository-sync/uploads/:id/download", requireAuth, requireAdmin, downloadRepositoryUpload);
app.post("/api/repository-sync/pending", requireAuth, requireAdmin, changeRepositorySync("pending"));
app.post("/api/repository-sync/uploaded", requireAuth, requireAdmin, changeRepositorySync("uploaded"));
app.post("/api/repository-sync/reset", requireAuth, requireAdmin, changeRepositorySync("reset"));
app.post("/api/repository-sync/restore", requireAuth, requireAdmin, restoreRepositoryUploadedStatus);

app.get("/api/school-years", requireAuth, schoolYears);
app.post("/api/school-years", requireAuth, requireAdmin, saveSchoolYear);
app.patch("/api/school-years/transfer", requireAuth, requireAdmin, transferSchoolYearRecords);
app.patch(
  "/api/school-years/:id/assign-current",
  requireAuth, requireAdmin, assignCurrentSchoolYearRecords,
);
app.get("/api/school-years/:id/delete-impact", requireAuth, requireAdmin, schoolYearDeleteImpact);
app.delete("/api/school-years/:id/records", requireAuth, requireAdmin, deleteSchoolYearRecords);
app.patch("/api/school-years/:id/activate", requireAuth, requireAdmin, activateSchoolYear);
app.patch("/api/school-years/:id", requireAuth, requireAdmin, updateSchoolYear);
app.put("/api/school-years/:id", requireAuth, requireAdmin, updateSchoolYear);
app.delete("/api/school-years/:id", requireAuth, requireAdmin, deleteSchoolYear);


app.post("/api/attendance/requests", publicRequestRateLimit, createAttendanceRequest);
app.post("/api/public/student-records", publicStudentRecordsRateLimit, publicStudentRecords);
app.post("/api/attendance/requests/student-status", publicStudentStatusRateLimit, publicAttendanceStudentRequests);
app.post("/api/attendance/requests/student-lookup", publicStudentStatusRateLimit, publicAttendanceStudentLookup);
app.get("/api/attendance/requests", requireAuth, requireAdmin, attendanceRequests);
app.patch("/api/attendance/requests/group-review", requireAuth, requireAdmin, reviewAttendanceRequestGroup);
app.patch("/api/attendance/requests/group-review/progress", requireAuth, requireAdmin, reviewAttendanceRequestGroupWithProgress);
app.patch(
  "/api/attendance/requests/:id/review",
  requireAuth, requireAdmin, reviewAttendanceRequest,
);
app.patch(
  "/api/attendance/requests/:id/review/progress",
  requireAuth, requireAdmin, reviewAttendanceRequestWithProgress,
);
app.delete(
  "/api/attendance/requests/:id/events/:eventId",
  requireAuth, requireAdmin, removeAttendanceRequestEvent,
);

app.get("/api/attendance/colleges", requireAuth, attendanceColleges);
app.get("/api/attendance/event-exemptions", requireAuth, requireAdmin, attendanceEventExemptions);
app.get("/api/attendance/event-college-checker", requireAuth, requireAdmin, attendanceEventCollegeChecker);
app.post("/api/attendance/event-exemptions/impact", requireAuth, requireAdmin, attendanceEventExemptionImpact);
app.post("/api/attendance/event-exemptions", requireAuth, requireAdmin, saveAttendanceEventExemptions);
app.post(
  "/api/attendance/event-exemptions/progress",
  requireAuth, requireAdmin, saveAttendanceEventExemptionsWithProgress,
);
app.post("/api/attendance/event-exemptions/bulk-delete", requireAuth, requireAdmin, removeAttendanceEventExemptionsBulk);
app.post(
  "/api/attendance/event-exemptions/remove-selected/progress",
  requireAuth, requireAdmin, removeSelectedAttendanceEventExemptionsWithProgress,
);
app.delete("/api/attendance/event-exemptions/:id", requireAuth, requireAdmin, removeAttendanceEventExemption);

app.get("/api/attendance/event-year-level-exemptions", requireAuth, requireAdmin, attendanceEventYearLevelExemptions);
app.post("/api/attendance/event-year-level-exemptions/impact", requireAuth, requireAdmin, attendanceEventYearLevelExemptionImpact);
app.post("/api/attendance/event-year-level-exemptions", requireAuth, requireAdmin, saveAttendanceEventYearLevelExemptions);
app.post(
  "/api/attendance/event-year-level-exemptions/progress",
  requireAuth, requireAdmin, saveAttendanceEventYearLevelExemptionsWithProgress,
);
app.post("/api/attendance/event-year-level-exemptions/bulk-delete", requireAuth, requireAdmin, removeAttendanceEventYearLevelExemptionsBulk);
app.delete("/api/attendance/event-year-level-exemptions/:id", requireAuth, requireAdmin, removeAttendanceEventYearLevelExemption);

app.get("/api/attendance/events", requireAuth, attendanceEvents);
app.get(
  "/api/attendance/events/duplicates",
  requireAuth, requireAdmin, attendanceEventDuplicateGroups,
);
app.post(
  "/api/attendance/events/merge-impact",
  requireAuth, requireAdmin, attendanceEventMergeImpact,
);
app.post(
  "/api/attendance/events/merge",
  requireAuth, requireAdmin, mergeAttendanceEvents,
);
app.post("/api/attendance/events", requireAuth, requireAdmin, saveAttendanceEvent);
app.put("/api/attendance/events/:eventId", requireAuth, requireAdmin, updateAttendanceEvent);
app.patch("/api/attendance/events/:eventId", requireAuth, requireAdmin, updateAttendanceEvent);
app.delete("/api/attendance/events/:eventId", requireAuth, requireAdmin, deleteAttendanceEvent);
app.get("/api/attendance/dashboard-overview", requireAuth, requireAdmin, attendanceDashboardOverview);
app.get("/api/attendance/final-results", requireAuth, requireAdmin, attendanceFinalResults);
app.patch(
  "/api/attendance/final-results/:id/events/batch/progress",
  requireAuth, requireAdmin, updateStudentEventAttendancesWithProgress,
);
app.patch(
  "/api/attendance/final-results/:id/events/:eventId",
  requireAuth, requireAdmin, updateStudentEventAttendance,
);
app.patch(
  "/api/attendance/final-results/:id/events/:eventId/progress",
  requireAuth, requireAdmin, updateStudentEventAttendanceWithProgress,
);
app.patch(
  "/api/attendance/final-results/:id/profile",
  requireAuth, requireAdmin, updateAttendanceFinalResultProfile,
);
app.delete("/api/attendance/final-results", requireAuth, requireAdmin, deleteAttendanceFinalResults);
app.delete("/api/attendance/final-results/:id", requireAuth, requireAdmin, deleteAttendanceFinalResult);
app.post(
  "/api/attendance/final-results/refresh",
  requireAuth, requireAdmin, refreshAttendanceFinalResults,
);
app.get("/api/attendance/calculation-results", requireAuth, requireAdmin, attendanceCalculationResults);
app.get(
  "/api/attendance/calculation-results/pending-summary",
  requireAuth, requireAdmin, attendanceCalculationPendingSummary,
);
app.post(
  "/api/attendance/calculation-results/status",
  requireAuth, requireAdmin, attendanceCalculationStatus,
);
app.delete(
  "/api/attendance/calculation-results",
  requireAuth, requireAdmin, deleteAttendanceCalculationResults,
);
app.post(
  "/api/attendance/calculation-results/preview",
  requireAuth, requireAdmin, previewAttendanceCalculationResults,
);
app.post(
  "/api/attendance/calculation-results/refresh",
  requireAuth, requireAdmin, refreshAttendanceCalculationResults,
);
app.post(
  "/api/attendance/calculation-results/repair-consistency",
  requireAuth, requireAdmin, repairAttendanceCalculationConsistency,
);
app.get("/api/attendance/manual-records", requireAuth, requireAdmin, attendanceManualRecords);
app.delete("/api/attendance/manual-records", requireAuth, requireAdmin, deleteAttendanceManualRecords);
app.delete("/api/attendance/manual-records/:id", requireAuth, requireAdmin, deleteAttendanceManualRecord);
app.get("/api/attendance", requireAuth, requireAdmin, attendanceIndex);
app.get("/api/attendance/imports", requireAuth, requireAdmin, attendanceImports);
app.delete(
  "/api/attendance/imports",
  requireAuth, requireAdmin, deleteAttendanceImports,
);
app.get(
  "/api/attendance/imports/:importId/delete-impact",
  requireAuth, requireAdmin, attendanceImportDeleteImpact,
);
app.post(
  "/api/attendance/imports/:importId/restore",
  requireAuth, requireAdmin, restoreAttendanceImport,
);
app.delete(
  "/api/attendance/imports/:importId/purge",
  requireAuth, requireAdmin, purgeAttendanceImport,
);
app.get("/api/attendance/imports/:importId", requireAuth, requireAdmin, showImport);
app.delete(
  "/api/attendance/imports/:importId",
  requireAuth, requireAdmin, deleteAttendanceImport,
);
app.post("/api/attendance/manual", requireAuth, requireAdmin, manualSave);
app.post(
  "/api/attendance/import/preview",
  requireAuth, requireAdmin, rateLimit("attendance:preview", 3, 60, (req) => (req as typeof req & { user?: { sub: string } }).user?.sub || clientIp(req)), attendanceBatchUpload,
  previewImport,
);
app.post(
  "/api/attendance/import/save/progress",
  requireAuth, requireAdmin, rateLimit("attendance:save", 2, 60, (req) => (req as typeof req & { user?: { sub: string } }).user?.sub || clientIp(req)), attendanceBatchUpload,
  saveImportWithProgress,
);
app.post(
  "/api/attendance/import/save",
  requireAuth, requireAdmin, rateLimit("attendance:save", 2, 60, (req) => (req as typeof req & { user?: { sub: string } }).user?.sub || clientIp(req)), attendanceBatchUpload,
  saveImport,
);
app.put("/api/attendance/bulk", requireAuth, requireAdmin, updateAttendanceRecordsBulk);
app.patch("/api/attendance/bulk", requireAuth, requireAdmin, updateAttendanceRecordsBulk);
app.put("/api/attendance/:id", requireAuth, requireAdmin, updateAttendanceRecord);
app.patch("/api/attendance/:id", requireAuth, requireAdmin, updateAttendanceRecord);
app.delete("/api/attendance/:id", requireAuth, requireAdmin, deleteAttendanceRecord);

app.get("/api/fines", requireAuth, requireAdmin, fines);
app.get("/api/fines/summary", requireAuth, requireAdmin, summary);
app.get("/api/fines/penalty-results/colleges", requireAuth, requireAdmin, penaltyResultColleges);
app.get("/api/fines/penalty-results/:id/absent-events", requireAuth, requireAdmin, penaltyResultAbsentEvents);
app.get("/api/fines/penalty-results", requireAuth, requireAdmin, penaltyResults);
app.delete("/api/fines/penalty-results", requireAuth, requireAdmin, deletePenaltyResultRows);
app.delete("/api/fines/penalty-results/:id", requireAuth, requireAdmin, deletePenaltyResultRow);
app.post("/api/fines/penalty-results/refresh", requireAuth, requireAdmin, refreshPenaltyResultRows);
app.put("/api/fines/penalty-results/:id", requireAuth, requireAdmin, updatePenaltyResultRow);
app.patch("/api/fines/penalty-results/:id", requireAuth, requireAdmin, updatePenaltyResultRow);
app.patch(
  "/api/fines/penalty-results/:id/status",
  requireAuth, requireAdmin, updatePenaltyResultRowStatus,
);
app.post("/api/fines/zero-attendance", requireAuth, requireAdmin, registerZeroAttendance);
app.patch("/api/fines/:id/status", requireAuth, requireAdmin, updateStatus);
app.get("/api/fines/penalties", requireAuth, requireAdmin, penalties);
app.post("/api/fines/penalties", requireAuth, requireAdmin, savePenalty);
app.post("/api/fines/penalties/seed", requireAuth, requireAdmin, seedPenalties);
app.get("/api/fines/penalties/match/:noOfAbsences", requireAuth, requireAdmin, matchPenalty);
app.put("/api/fines/penalties/:id", requireAuth, requireAdmin, updatePenalty);
app.patch("/api/fines/penalties/:id", requireAuth, requireAdmin, updatePenalty);
app.delete("/api/fines/penalties/:id", requireAuth, requireAdmin, deletePenalty);

const auditRetentionDays = Number(process.env.AUDIT_LOG_RETENTION_DAYS ?? 365);
if (Number.isInteger(auditRetentionDays) && auditRetentionDays >= 30 && auditRetentionDays <= 3650) {
  const purgeOldAuditLogs = () => {
    void query("DELETE FROM public.audit_logs WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')", [auditRetentionDays])
      .catch((error) => console.error("Audit retention purge failed:", error));
  };
  const initialAuditPurge = setTimeout(purgeOldAuditLogs, 60_000);
  initialAuditPurge.unref();
  const auditPurgeInterval = setInterval(purgeOldAuditLogs, 24 * 60 * 60 * 1000);
  auditPurgeInterval.unref();
}

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

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const requestId = crypto.randomUUID();
  const raw = error as { statusCode?: number; status?: number; message?: string; stack?: string; expose?: boolean; code?: string };
  const status = error instanceof multer.MulterError ? 400 : Number(raw?.statusCode ?? raw?.status ?? 500);
  const safeStatus = status >= 400 && status < 500 ? status : 500;
  console.error(`[${requestId}] request failed`, error);
  res.setHeader("X-Request-ID", requestId);
  const response: { message: string; requestId: string; stack?: string } = {
    message: safeStatus === 400 ? "Invalid request." : safeStatus === 404 ? "Resource not found." : "Request failed.",
    requestId,
  };
  if (error instanceof multer.MulterError) {
    response.message = error.code === "LIMIT_FILE_SIZE"
      ? "Attendance file exceeds the 5 MB upload limit."
      : error.code === "LIMIT_FILE_COUNT" || error.code === "LIMIT_UNEXPECTED_FILE"
        ? "Select at most 10 attendance files in one import."
        : "Invalid attendance upload.";
  } else if (safeStatus < 500 && raw?.expose === true && !raw?.code) {
    response.message = raw.message || response.message;
  }
  // Internal stacks belong exclusively in server-side logs. Never send them to clients.
  res.status(safeStatus).json(response);
});

if (
  !(process.env.ATTENDANCE_REPOSITORY_URL?.trim() || process.env.AttendanceRepository_URL?.trim()) ||
  !(process.env.PENALYZE_INTEGRATION_KEY?.trim() || process.env.Penalyze_Integration_Key?.trim())
) {
  console.warn("AttendanceRepository sync is not configured: set ATTENDANCE_REPOSITORY_URL and PENALYZE_INTEGRATION_KEY on penalyze-backend.");
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});