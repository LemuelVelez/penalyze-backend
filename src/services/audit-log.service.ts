import type { NextFunction, Request, Response } from "express";

import type { AuthenticatedRequest } from "../controller/auth.controller";
import { query } from "../lib/db";

const SENSITIVE_KEYS = new Set([
  "password",
  "password_hash",
  "passwordhash",
  "token",
  "authorization",
  "secret",
  "jwt",
]);

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

type AuditContext = {
  action: string;
  resourceType: string;
  resourceId: string | null;
};

type FileSummary = {
  field: string;
  name: string;
  type: string;
  size: number;
};

function humanize(value: string) {
  return value
    .replace(/^api\//, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getResourceId(path: string) {
  return path.match(UUID_PATTERN)?.[0] ?? null;
}

function getAuditContext(method: string, path: string): AuditContext {
  const resourceId = getResourceId(path);
  const normalizedMethod = method.toUpperCase();

  const rules: Array<{
    matches: (methodValue: string, pathValue: string) => boolean;
    action: string;
    resourceType: string;
  }> = [
    { matches: (m, p) => m === "POST" && p === "/api/auth/login", action: "Login attempt", resourceType: "authentication" },
    { matches: (m, p) => m === "POST" && p === "/api/auth/register", action: "Created user account", resourceType: "user" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/users\//.test(p), action: "Updated user account", resourceType: "user" },
    { matches: (m, p) => m === "DELETE" && /^\/api\/users\//.test(p), action: "Deleted user account", resourceType: "user" },
    { matches: (m, p) => m === "POST" && p === "/api/school-years", action: "Created school year", resourceType: "school year" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /\/api\/school-years\/[^/]+$/.test(p), action: "Updated school year", resourceType: "school year" },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/activate"), action: "Activated school year", resourceType: "school year" },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/assign-current"), action: "Assigned records to school year", resourceType: "school year" },
    { matches: (m, p) => m === "PATCH" && p === "/api/school-years/transfer", action: "Transferred school year records", resourceType: "school year records" },
    { matches: (m, p) => m === "DELETE" && p.endsWith("/records"), action: "Deleted school year records", resourceType: "school year records" },
    { matches: (m, p) => m === "DELETE" && /^\/api\/school-years\//.test(p), action: "Deleted school year", resourceType: "school year" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/requests", action: "Submitted attendance request", resourceType: "attendance request" },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/review"), action: "Reviewed attendance request", resourceType: "attendance request" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events", action: "Created attendance event", resourceType: "attendance event" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/attendance\/events\//.test(p), action: "Updated attendance event", resourceType: "attendance event" },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/events\//.test(p), action: "Deleted attendance event", resourceType: "attendance event" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events/merge", action: "Merged attendance events", resourceType: "attendance event" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events/merge-impact", action: "Previewed attendance event merge", resourceType: "attendance event" },
    { matches: (m, p) => m === "POST" && /\/api\/attendance\/import\/save/.test(p), action: "Saved attendance import", resourceType: "attendance import" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/import/preview", action: "Previewed attendance import", resourceType: "attendance import" },
    { matches: (m, p) => m === "POST" && p.endsWith("/restore"), action: "Restored attendance import", resourceType: "attendance import" },
    { matches: (m, p) => m === "DELETE" && p.endsWith("/purge"), action: "Purged attendance import", resourceType: "attendance import" },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/imports"), action: "Deleted attendance import", resourceType: "attendance import" },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/manual", action: "Saved manual attendance", resourceType: "manual attendance" },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/manual-records"), action: "Deleted manual attendance", resourceType: "manual attendance" },
    { matches: (m, p) => m === "POST" && p.endsWith("/final-results/refresh"), action: "Refreshed attendance final results", resourceType: "attendance final result" },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/final-results"), action: "Deleted attendance final result", resourceType: "attendance final result" },
    { matches: (m, p) => m === "POST" && p.endsWith("/calculation-results/preview"), action: "Previewed calculation results", resourceType: "calculation result" },
    { matches: (m, p) => m === "POST" && p.endsWith("/calculation-results/refresh"), action: "Refreshed calculation results", resourceType: "calculation result" },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/calculation-results"), action: "Deleted calculation results", resourceType: "calculation result" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && p === "/api/attendance/bulk", action: "Updated attendance records in bulk", resourceType: "attendance record" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/attendance\//.test(p), action: "Updated attendance record", resourceType: "attendance record" },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\//.test(p), action: "Deleted attendance record", resourceType: "attendance record" },
    { matches: (m, p) => m === "POST" && p === "/api/fines/penalties", action: "Created penalty", resourceType: "penalty" },
    { matches: (m, p) => m === "POST" && p === "/api/fines/penalties/seed", action: "Seeded penalties", resourceType: "penalty" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/fines\/penalties\//.test(p), action: "Updated penalty", resourceType: "penalty" },
    { matches: (m, p) => m === "DELETE" && /^\/api\/fines\/penalties\//.test(p), action: "Deleted penalty", resourceType: "penalty" },
    { matches: (m, p) => m === "POST" && p.endsWith("/penalty-results/refresh"), action: "Refreshed penalty results", resourceType: "penalty result" },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && p.includes("/penalty-results/"), action: "Updated penalty result", resourceType: "penalty result" },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/fines/penalty-results"), action: "Deleted penalty result", resourceType: "penalty result" },
    { matches: (m, p) => m === "POST" && p === "/api/fines/zero-attendance", action: "Registered zero attendance", resourceType: "fine" },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/status"), action: "Updated fine status", resourceType: "fine" },
  ];

  const match = rules.find((rule) => rule.matches(normalizedMethod, path));
  if (match) {
    return {
      action: match.action,
      resourceType: match.resourceType,
      resourceId,
    };
  }

  const segments = path.split("/").filter(Boolean);
  let resourceSegment = "record";
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!UUID_PATTERN.test(segments[index])) {
      resourceSegment = segments[index];
      break;
    }
  }
  const verb = normalizedMethod === "POST" ? "Created" : normalizedMethod === "DELETE" ? "Deleted" : "Updated";

  return {
    action: `${verb} ${humanize(resourceSegment).toLowerCase()}`,
    resourceType: humanize(resourceSegment).toLowerCase(),
    resourceId,
  };
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= 4) return "[nested data omitted]";

  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const displayed = value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
    if (value.length > 20) displayed.push(`[${value.length - 20} more items omitted]`);
    return displayed;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 60);
    const result: Record<string, unknown> = {};

    for (const [key, item] of entries) {
      const normalizedKey = key.toLowerCase().replace(/[-_]/g, "");
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS.has(normalizedKey)
        ? "[redacted]"
        : sanitizeValue(item, depth + 1);
    }

    return result;
  }

  return String(value);
}

function summarizeFiles(req: Request): FileSummary[] {
  const files = req.files;
  if (!files) return [];

  const allFiles = Array.isArray(files) ? files : Object.values(files).flat();
  return allFiles.slice(0, 20).map((file) => ({
    field: file.fieldname,
    name: file.originalname,
    type: file.mimetype,
    size: file.size,
  }));
}

function extractResponseResourceId(value: unknown, depth = 0): string | null {
  if (!value || depth > 4) return null;

  if (typeof value === "string") {
    return UUID_PATTERN.test(value) ? value.match(UUID_PATTERN)?.[0] ?? null : null;
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) return null;
    return extractResponseResourceId(value[0], depth + 1);
  }

  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    for (const key of ["id", "userId", "eventId", "importId", "requestId", "schoolYearId"]) {
      const candidate = objectValue[key];
      if (typeof candidate === "string" && UUID_PATTERN.test(candidate)) {
        return candidate.match(UUID_PATTERN)?.[0] ?? null;
      }
    }

    for (const key of ["data", "user", "event", "import", "request", "schoolYear", "record", "penalty", "fine"]) {
      if (objectValue[key] !== undefined) {
        const nested = extractResponseResourceId(objectValue[key], depth + 1);
        if (nested) return nested;
      }
    }
  }

  return null;
}

function extractAuthenticatedResponseActor(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return null;
  const user = (data as Record<string, unknown>).user;
  if (!user || typeof user !== "object") return null;

  const record = user as Record<string, unknown>;
  const id = typeof record.id === "string" && UUID_PATTERN.test(record.id) ? record.id : null;
  if (!id) return null;

  return {
    sub: id,
    name: typeof record.name === "string" ? record.name : null,
    email: typeof record.email === "string" ? record.email : null,
    role: typeof record.role === "string" ? record.role : null,
  };
}

function requestPath(req: Request) {
  return (req.originalUrl || req.url).split("?")[0] || "/";
}

function getIpAddress(req: Request) {
  return req.ip || req.socket.remoteAddress || null;
}

export function auditMutation(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!MUTATING_METHODS.has(req.method.toUpperCase()) || !requestPath(req).startsWith("/api/")) {
    next();
    return;
  }

  const startedAt = Date.now();
  let responseBody: unknown;
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    responseBody = body;
    return originalJson(body);
  }) as Response["json"];

  res.once("finish", () => {
    const path = requestPath(req);
    const context = getAuditContext(req.method, path);
    const files = summarizeFiles(req);
    const responseActor =
      res.statusCode >= 200 &&
      res.statusCode < 400 &&
      (path === "/api/auth/login" || path === "/api/auth/register")
        ? extractAuthenticatedResponseActor(responseBody)
        : null;
    const actor = req.user ?? responseActor;
    const details = {
      outcome: res.statusCode >= 200 && res.statusCode < 400 ? "success" : "failed",
      durationMs: Date.now() - startedAt,
      ...(Object.keys(req.query ?? {}).length ? { query: sanitizeValue(req.query) } : {}),
      ...(req.body && Object.keys(req.body).length ? { body: sanitizeValue(req.body) } : {}),
      ...(files.length ? { files } : {}),
    };

    void query(
      `
        INSERT INTO audit_logs (
          user_id,
          actor_name,
          actor_email,
          actor_role,
          action,
          resource_type,
          resource_id,
          method,
          route,
          status_code,
          ip_address,
          user_agent,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
      `,
      [
        actor?.sub ?? null,
        actor?.name ?? null,
        actor?.email ?? null,
        actor?.role ?? null,
        context.action,
        context.resourceType,
        context.resourceId ?? extractResponseResourceId(responseBody),
        req.method.toUpperCase(),
        path,
        res.statusCode,
        getIpAddress(req),
        req.get("user-agent") ?? null,
        JSON.stringify(details),
      ],
    ).catch((error) => {
      console.error("Failed to write audit log:", error);
    });
  });

  next();
}
