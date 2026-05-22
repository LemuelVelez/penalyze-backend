import "dotenv/config";
import express, { NextFunction, Request, Response } from "express";

import { login, me, register, requireAuth } from "./controller/auth.controller";
import {
  attendanceUpload,
  imports as attendanceImports,
  index as attendanceIndex,
  previewImport,
  saveImport,
  showImport
} from "./controller/attendance.controller";
import {
  fines,
  matchPenalty,
  penalties,
  savePenalty,
  seedPenalties,
  summary,
  updateStatus
} from "./controller/fines.controller";
import { query } from "./lib/db";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_URL = process.env.Frontend_URL || process.env.FRONTEND_URL || "http://localhost:8081";

app.use((req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", FRONTEND_URL);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

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

app.get("/api/attendance", attendanceIndex);
app.get("/api/attendance/imports", attendanceImports);
app.get("/api/attendance/imports/:importId", showImport);
app.post("/api/attendance/import/preview", attendanceUpload.single("file"), previewImport);
app.post("/api/attendance/import/save", attendanceUpload.single("file"), saveImport);

app.get("/api/fines", fines);
app.get("/api/fines/summary", summary);
app.patch("/api/fines/:id/status", updateStatus);
app.get("/api/fines/penalties", penalties);
app.post("/api/fines/penalties", savePenalty);
app.post("/api/fines/penalties/seed", seedPenalties);
app.get("/api/fines/penalties/match/:noOfAbsences", matchPenalty);

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