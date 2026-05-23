import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";

import { deleteUser, listUsers, login, me, register, requireAuth, updateUser } from "./controller/auth.controller";
import {
  attendanceUpload,
  deleteEvent as deleteAttendanceEvent,
  deleteImport as deleteAttendanceImport,
  deleteImports as deleteAttendanceImports,
  deleteRecord as deleteAttendanceRecord,
  events as attendanceEvents,
  imports as attendanceImports,
  index as attendanceIndex,
  manualSave,
  previewImport,
  saveEvent as saveAttendanceEvent,
  saveImport,
  showImport,
  updateEvent as updateAttendanceEvent,
  updateRecord as updateAttendanceRecord
} from "./controller/attendance.controller";
import {
  deletePenalty,
  fines,
  matchPenalty,
  penalties,
  registerZeroAttendance,
  savePenalty,
  seedPenalties,
  summary,
  updatePenalty,
  updateStatus
} from "./controller/fines.controller";
import { query } from "./lib/db";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const DEFAULT_FRONTEND_ORIGINS = ["http://localhost:5173", "http://localhost:8081"];

function normalizeOrigin(value: string) {
  return value.trim().replace(/\/+$/, "");
}

function parseAllowedOrigins() {
  const configuredOrigins = [process.env.CORS_ORIGIN, process.env.FRONTEND_ORIGINS, process.env.FRONTEND_URL, process.env.Frontend_URL]
    .flatMap((value) => String(value ?? "").split(","))
    .map(normalizeOrigin)
    .filter(Boolean);

  return Array.from(new Set([...configuredOrigins, ...DEFAULT_FRONTEND_ORIGINS]));
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

app.use((req: Request, res: Response, next: NextFunction) => {
  const requestOrigin = req.headers.origin ? normalizeOrigin(req.headers.origin) : "";
  const allowedOrigin = requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : "";

  if (allowedOrigin) {
    res.header("Access-Control-Allow-Origin", allowedOrigin);
    res.header("Vary", "Origin");
  } else if (!requestOrigin && ALLOWED_ORIGINS[0]) {
    res.header("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }

  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");

  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/", (_req: Request, res: Response) => {
  res.json({
    message: "Penalyze backend is running.",
    api: "/api"
  });
});

app.get("/api/health", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/register", register);
app.post("/api/auth/login", login);
app.get("/api/auth/me", requireAuth, me);

app.get("/api/users", requireAuth, listUsers);
app.patch("/api/users/:id", requireAuth, updateUser);
app.put("/api/users/:id", requireAuth, updateUser);
app.delete("/api/users/:id", requireAuth, deleteUser);

app.get("/api/attendance/events", attendanceEvents);
app.post("/api/attendance/events", saveAttendanceEvent);
app.put("/api/attendance/events/:eventId", updateAttendanceEvent);
app.patch("/api/attendance/events/:eventId", updateAttendanceEvent);
app.delete("/api/attendance/events/:eventId", deleteAttendanceEvent);
app.get("/api/attendance", attendanceIndex);
app.get("/api/attendance/imports", attendanceImports);
app.delete("/api/attendance/imports", deleteAttendanceImports);
app.get("/api/attendance/imports/:importId", showImport);
app.delete("/api/attendance/imports/:importId", deleteAttendanceImport);
app.post("/api/attendance/manual", manualSave);
app.post("/api/attendance/import/preview", attendanceUpload.single("file"), previewImport);
app.post("/api/attendance/import/save", attendanceUpload.single("file"), saveImport);
app.put("/api/attendance/:id", updateAttendanceRecord);
app.patch("/api/attendance/:id", updateAttendanceRecord);
app.delete("/api/attendance/:id", deleteAttendanceRecord);

app.get("/api/fines", fines);
app.get("/api/fines/summary", summary);
app.post("/api/fines/zero-attendance", registerZeroAttendance);
app.patch("/api/fines/:id/status", updateStatus);
app.get("/api/fines/penalties", penalties);
app.post("/api/fines/penalties", savePenalty);
app.post("/api/fines/penalties/seed", seedPenalties);
app.get("/api/fines/penalties/match/:noOfAbsences", matchPenalty);
app.put("/api/fines/penalties/:id", updatePenalty);
app.patch("/api/fines/penalties/:id", updatePenalty);
app.delete("/api/fines/penalties/:id", deletePenalty);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ message: "Route not found." });
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(error?.statusCode ?? error?.status ?? 500);
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = error?.message || "Internal server error.";

  res.status(safeStatus).json({
    message,
    ...(process.env.NODE_ENV === "production" ? {} : { stack: error?.stack })
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});