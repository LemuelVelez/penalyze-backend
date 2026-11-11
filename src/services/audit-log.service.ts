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
const NON_AUDITED_ROUTES = new Set(["POST /api/attendance/calculation-results/status"]);

export type AuditCategory =
  | "Authentication & Accounts"
  | "School Years"
  | "Attendance Requests"
  | "Attendance Exemptions"
  | "Attendance Events"
  | "Attendance Imports"
  | "Manual Attendance"
  | "Attendance Records & Final Results"
  | "Calculation Results"
  | "Penalties & Fines"
  | "Repository Sync"
  | "System"
  | "Other";
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

type AuditContext = {
  action: string;
  resourceType: string;
  resourceId: string | null;
  category: AuditCategory;
  describe?: (req: Request, responseBody: unknown) => string | null;
  unmappedRoute?: boolean;
};

type FileSummary = {
  field: string;
  name: string;
  type: string;
  size: number;
};

function getResourceId(path: string) {
  return path.match(UUID_PATTERN)?.[0] ?? null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resultData(responseBody: unknown): Record<string, unknown> {
  const response = asRecord(responseBody);
  return asRecord(response.data ?? response);
}

function firstText(source: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim().slice(0, 160);
    }
  }
  return null;
}

function describeName(req: Request, responseBody: unknown): string | null {
  const data = resultData(responseBody);
  const body = asRecord(req.body);
  const name = firstText(data, "name", "event_name", "eventName", "file_name", "fileName", "school_year_name", "schoolYearName")
    ?? firstText(body, "name", "eventName", "event_name", "fileName", "schoolYearName", "school_year_name");
  return name ? `Name: ${name}` : null;
}

function describeIds(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const data = resultData(responseBody);
  const fields: Array<[string, string]> = [
    ["uploadIds", "repository uploads"], ["requestIds", "attendance requests"],
    ["sourceEventIds", "source events"], ["eventIds", "events"],
    ["importIds", "imports"], ["recordIds", "records"],
    ["ids", "records"], ["changes", "event attendance changes"],
    ["exemptionIds", "exemptions"], ["selectedIds", "records"],
  ];
  for (const [field, label] of fields) {
    const values = body[field] ?? data[field];
    if (Array.isArray(values)) return `${values.length} ${label} selected`;
  }
  for (const field of ["deletedRecords", "deletedRows", "records", "rows"]) {
    const values = data[field];
    if (Array.isArray(values)) return `${values.length} ${field === "rows" ? "rows" : "records"} affected`;
  }
  return null;
}

function describeStatus(req: Request, responseBody: unknown): string | null {
  const status = firstText(asRecord(req.body), "status") ?? firstText(resultData(responseBody), "status");
  return status ? `New status: ${status}` : null;
}

function describeReview(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const data = resultData(responseBody);
  const decision = firstText(body, "status") ?? firstText(asRecord(data.request), "status");
  const count = Array.isArray(body.requestIds) ? `${body.requestIds.length} request(s)` : null;
  const requestType = firstText(body, "requestType", "request_type") ?? firstText(data, "request_type");
  return [decision ? `Decision: ${decision}` : null, count,
    requestType ? `Type: ${requestType}` : null,
    firstText(body, "studentId", "student_id") ? `Student: ${firstText(body, "studentId", "student_id")}` : null]
    .filter(Boolean).join(" · ") || null;
}

function describeImport(req: Request, responseBody: unknown): string | null {
  const files = summarizeFiles(req);
  if (files.length) return `File${files.length === 1 ? "" : "s"}: ${files.map((file) => file.name).join(", ").slice(0, 400)}`;
  const body = asRecord(req.body);
  const fileName = firstText(body, "fileName", "file_name");
  if (fileName) return `File: ${fileName}`;
  if (Array.isArray(body.rows)) return `${body.rows.length} attendance rows imported`;
  return describeIds(req, responseBody);
}

function describeSchoolYear(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const data = resultData(responseBody);
  const name = firstText(data, "name") ?? firstText(body, "name");
  const semester = firstText(data, "semester") ?? firstText(body, "semester");
  return [name ? `School year: ${name}` : null, semester ? `Semester: ${semester}` : null].filter(Boolean).join(" · ") || null;
}

function describeSchoolTransfer(req: Request): string | null {
  const body = asRecord(req.body);
  const fields = ["eventIds", "importIds", "attendanceRecordIds", "finalResultIds", "manualRecordIds", "fineIds", "penaltyResultIds"];
  const total = fields.reduce((sum, field) => sum + (Array.isArray(body[field]) ? (body[field] as unknown[]).length : 0), 0);
  const target = firstText(body, "targetSchoolYearId", "target_school_year_id");
  return [`${total} records selected`, target ? `Target school year: ${target}` : null].filter(Boolean).join(" · ");
}

function describeEvent(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const data = resultData(responseBody);
  const name = firstText(body, "targetName", "name", "eventName") ?? firstText(data, "name", "eventName");
  const selected = describeIds(req, responseBody);
  return [name ? `Event: ${name}` : null, selected].filter(Boolean).join(" · ") || null;
}

function describeExemptions(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const event = firstText(body, "eventId", "event_id");
  const college = firstText(body, "college");
  const selected = describeIds(req, responseBody);
  return [event ? `Event: ${event}` : null, college ? `College: ${college}` : null, selected].filter(Boolean).join(" · ") || null;
}

function describeEventAttendance(req: Request): string | null {
  const body = asRecord(req.body);
  if (Array.isArray(body.changes)) return `${body.changes.length} event attendance changes`;
  if (typeof body.attended === "boolean") return `Marked ${body.attended ? "attended" : "absent"}`;
  return null;
}

function describeProfile(req: Request): string | null {
  const keys = Object.keys(asRecord(req.body)).filter((key) => !["id", "studentId", "student_id"].includes(key));
  return keys.length ? `Updated fields: ${keys.join(", ").slice(0, 250)}` : null;
}

function describeRepair(req: Request, responseBody: unknown): string | null {
  const data = resultData(responseBody);
  const repairedGroups = Array.isArray(data.repairedGroups) ? data.repairedGroups.length : null;
  const calculated = repairedGroups !== null ? [
    `${repairedGroups} groups repaired`,
    `${Number(data.directlyRepairedRows ?? 0)} calculation rows repaired`,
    `${Number(data.directlyRepairedFinalRows ?? 0)} final-result rows repaired`,
  ].join(" · ") : null;
  const schoolYear = firstText(asRecord(req.body), "schoolYearId", "school_year_id");
  return [calculated, schoolYear ? `School year: ${schoolYear}` : null].filter(Boolean).join(" · ") || null;
}

function describePenalty(req: Request, responseBody: unknown): string | null {
  const body = asRecord(req.body);
  const data = resultData(responseBody);
  const absences = body.noOfAbsences ?? body.no_of_absences ?? data.no_of_absences;
  const penalty = firstText(body, "prescribedPenalty", "prescribed_penalty", "name")
    ?? firstText(data, "prescribed_penalty", "name");
  return [absences != null ? `Absences: ${absences}` : null, penalty ? `Penalty: ${penalty}` : null].filter(Boolean).join(" · ") || null;
}

function describeDetails(req: Request, responseBody: unknown): string | null {
  const count = describeIds(req, responseBody);
  const status = describeStatus(req, responseBody);
  const named = describeName(req, responseBody);
  const body = asRecord(req.body);
  const changedFields = Object.keys(body).filter((key) => !["password", "token", "secret", "authorization"].includes(key.toLowerCase()));
  return [count, status, named].filter(Boolean).join(" · ") ||
    (changedFields.length ? `Fields: ${changedFields.join(", ").slice(0, 250)}` : null);
}

function getAuditContext(method: string, path: string): AuditContext {
  const resourceId = getResourceId(path);
  const normalizedMethod = method.toUpperCase();

  const rules: Array<{
    matches: (methodValue: string, pathValue: string) => boolean;
    action: string;
    resourceType: string;
    category: AuditCategory;
    describe?: (req: Request, responseBody: unknown) => string | null;
  }> = [
    { matches: (m, p) => m === "POST" && p === "/api/repository-sync/pending", action: "Marked repository uploads as pending", resourceType: "repository upload", category: "Repository Sync", describe: describeIds },
    { matches: (m, p) => m === "POST" && p === "/api/repository-sync/uploaded", action: "Marked repository uploads as uploaded", resourceType: "repository upload", category: "Repository Sync", describe: describeIds },
    { matches: (m, p) => m === "POST" && p === "/api/repository-sync/reset", action: "Reset repository upload status", resourceType: "repository upload", category: "Repository Sync", describe: describeIds },
    { matches: (m, p) => m === "POST" && p === "/api/repository-sync/restore", action: "Restored repository uploaded status", resourceType: "repository upload", category: "Repository Sync", describe: (req) => firstText(asRecord(req.body), "uploadId") ? `Upload: ${firstText(asRecord(req.body), "uploadId")}` : null },
    { matches: (m, p) => m === "POST" && p === "/api/auth/login", action: "Login attempt", resourceType: "authentication", category: "Authentication & Accounts", describe: describeName },
    { matches: (m, p) => m === "POST" && p === "/api/auth/register", action: "Created user account", resourceType: "user", category: "Authentication & Accounts", describe: describeName },
    { matches: (m, p) => m === "POST" && p === "/api/auth/change-password", action: "Changed account password", resourceType: "user", category: "Authentication & Accounts", describe: describeName },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/users\//.test(p), action: "Updated user account", resourceType: "user", category: "Authentication & Accounts", describe: describeName },
    { matches: (m, p) => m === "DELETE" && /^\/api\/users\//.test(p), action: "Deleted user account", resourceType: "user", category: "Authentication & Accounts", describe: describeName },
    { matches: (m, p) => m === "POST" && p === "/api/school-years", action: "Created school year", resourceType: "school year", category: "School Years", describe: describeSchoolYear },
    { matches: (m, p) => m === "PATCH" && p === "/api/school-years/transfer", action: "Transferred school year records", resourceType: "school year records", category: "School Years", describe: describeSchoolTransfer },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /\/api\/school-years\/[^/]+$/.test(p), action: "Updated school year", resourceType: "school year", category: "School Years", describe: describeSchoolYear },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/activate"), action: "Activated school year", resourceType: "school year", category: "School Years", describe: describeSchoolYear },
    { matches: (m, p) => m === "PATCH" && p.endsWith("/assign-current"), action: "Assigned records to school year", resourceType: "school year", category: "School Years", describe: describeIds },
    { matches: (m, p) => m === "DELETE" && p.endsWith("/records"), action: "Deleted school year records", resourceType: "school year records", category: "School Years", describe: describeIds },
    { matches: (m, p) => m === "DELETE" && /^\/api\/school-years\//.test(p), action: "Deleted school year", resourceType: "school year", category: "School Years", describe: describeSchoolYear },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/requests", action: "Submitted attendance request", resourceType: "attendance request", category: "Attendance Requests", describe: describeReview },
    { matches: (m, p) => m === "PATCH" && /^\/api\/attendance\/requests\/group-review(\/progress)?$/.test(p), action: "Reviewed attendance request group", resourceType: "attendance request", category: "Attendance Requests", describe: describeReview },
    { matches: (m, p) => m === "PATCH" && /^\/api\/attendance\/requests\/[^/]+\/review(?:\/progress)?$/.test(p), action: "Reviewed attendance request", resourceType: "attendance request", category: "Attendance Requests", describe: describeReview },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/requests\/[^/]+\/events\/[^/]+$/.test(p), action: "Removed event from attendance request", resourceType: "attendance request", category: "Attendance Requests", describe: describeReview },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/event-exemptions/impact", action: "Previewed attendance event college exemption impact", resourceType: "attendance event college exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && (p === "/api/attendance/event-exemptions" || p === "/api/attendance/event-exemptions/progress"), action: "Created attendance event college exemptions", resourceType: "attendance event college exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/event-exemptions/bulk-delete", action: "Removed attendance event college exemptions (bulk)", resourceType: "attendance event college exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/event-exemptions/remove-selected/progress", action: "Removed selected attendance event exemptions", resourceType: "attendance event exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/event-exemptions\//.test(p), action: "Removed attendance event college exemption", resourceType: "attendance event college exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/event-year-level-exemptions/impact", action: "Previewed attendance event year level exemption impact", resourceType: "attendance event year level exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && (p === "/api/attendance/event-year-level-exemptions" || p === "/api/attendance/event-year-level-exemptions/progress"), action: "Created attendance event year level exemptions", resourceType: "attendance event year level exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/event-year-level-exemptions/bulk-delete", action: "Removed attendance event year level exemptions (bulk)", resourceType: "attendance event year level exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/event-year-level-exemptions\//.test(p), action: "Removed attendance event year level exemption", resourceType: "attendance event year level exemption", category: "Attendance Exemptions", describe: describeExemptions },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events", action: "Created attendance event", resourceType: "attendance event", category: "Attendance Events", describe: describeEvent },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/attendance\/events\//.test(p), action: "Updated attendance event", resourceType: "attendance event", category: "Attendance Events", describe: describeEvent },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/events\//.test(p), action: "Deleted attendance event", resourceType: "attendance event", category: "Attendance Events", describe: describeEvent },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events/merge", action: "Merged attendance events", resourceType: "attendance event", category: "Attendance Events", describe: describeEvent },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/events/merge-impact", action: "Previewed attendance event merge", resourceType: "attendance event", category: "Attendance Events", describe: describeEvent },
    { matches: (m, p) => m === "POST" && /\/api\/attendance\/import\/save/.test(p), action: "Saved attendance import", resourceType: "attendance import", category: "Attendance Imports", describe: describeImport },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/import/preview", action: "Previewed attendance import", resourceType: "attendance import", category: "Attendance Imports", describe: describeImport },
    { matches: (m, p) => m === "POST" && /^\/api\/attendance\/imports\/[^/]+\/restore$/.test(p), action: "Restored attendance import", resourceType: "attendance import", category: "Attendance Imports", describe: describeImport },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\/imports\/[^/]+\/purge$/.test(p), action: "Purged attendance import", resourceType: "attendance import", category: "Attendance Imports", describe: describeImport },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/imports"), action: "Deleted attendance import", resourceType: "attendance import", category: "Attendance Imports", describe: describeImport },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/manual", action: "Saved manual attendance", resourceType: "manual attendance", category: "Manual Attendance", describe: describeDetails },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/manual-records"), action: "Deleted manual attendance", resourceType: "manual attendance", category: "Manual Attendance", describe: describeDetails },
    { matches: (m, p) => m === "POST" && p.endsWith("/final-results/refresh"), action: "Refreshed attendance final results", resourceType: "attendance final result", category: "Attendance Records & Final Results", describe: describeDetails },
    { matches: (m, p) => m === "PATCH" && /^\/api\/attendance\/final-results\/[^/]+\/events\/batch\/progress$/.test(p), action: "Updated student event attendance (batch)", resourceType: "attendance final result", category: "Attendance Records & Final Results", describe: describeEventAttendance },
    { matches: (m, p) => m === "PATCH" && /^\/api\/attendance\/final-results\/[^/]+\/events\/[^/]+(?:\/progress)?$/.test(p), action: "Updated student event attendance", resourceType: "attendance final result", category: "Attendance Records & Final Results", describe: describeEventAttendance },
    { matches: (m, p) => m === "PATCH" && /^\/api\/attendance\/final-results\/[^/]+\/profile$/.test(p), action: "Updated student profile in final results", resourceType: "attendance final result", category: "Attendance Records & Final Results", describe: describeProfile },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/final-results"), action: "Deleted attendance final result", resourceType: "attendance final result", category: "Attendance Records & Final Results", describe: describeDetails },
    { matches: (m, p) => m === "POST" && p.endsWith("/calculation-results/preview"), action: "Previewed calculation results", resourceType: "calculation result", category: "Calculation Results", describe: describeDetails },
    { matches: (m, p) => m === "POST" && p.endsWith("/calculation-results/refresh"), action: "Refreshed calculation results", resourceType: "calculation result", category: "Calculation Results", describe: describeDetails },
    { matches: (m, p) => m === "POST" && p === "/api/attendance/calculation-results/repair-consistency", action: "Repaired attendance calculation consistency", resourceType: "calculation result", category: "Calculation Results", describe: describeRepair },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/attendance/calculation-results"), action: "Deleted calculation results", resourceType: "calculation result", category: "Calculation Results", describe: describeDetails },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && p === "/api/attendance/bulk", action: "Updated attendance records in bulk", resourceType: "attendance record", category: "Attendance Records & Final Results", describe: describeIds },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/attendance\//.test(p), action: "Updated attendance record", resourceType: "attendance record", category: "Attendance Records & Final Results", describe: describeDetails },
    { matches: (m, p) => m === "DELETE" && /^\/api\/attendance\//.test(p), action: "Deleted attendance record", resourceType: "attendance record", category: "Attendance Records & Final Results", describe: describeDetails },
    { matches: (m, p) => m === "POST" && p === "/api/fines/penalties", action: "Created penalty", resourceType: "penalty", category: "Penalties & Fines", describe: describePenalty },
    { matches: (m, p) => m === "POST" && p === "/api/fines/penalties/seed", action: "Seeded penalties", resourceType: "penalty", category: "Penalties & Fines", describe: describeIds },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && /^\/api\/fines\/penalties\//.test(p), action: "Updated penalty", resourceType: "penalty", category: "Penalties & Fines", describe: describePenalty },
    { matches: (m, p) => m === "DELETE" && /^\/api\/fines\/penalties\//.test(p), action: "Deleted penalty", resourceType: "penalty", category: "Penalties & Fines", describe: describePenalty },
    { matches: (m, p) => m === "POST" && p.endsWith("/penalty-results/refresh"), action: "Refreshed penalty results", resourceType: "penalty result", category: "Penalties & Fines", describe: describePenalty },
    { matches: (m, p) => m === "PATCH" && /^\/api\/fines\/penalty-results\/[^/]+\/status$/.test(p), action: "Updated penalty result payment status", resourceType: "penalty result", category: "Penalties & Fines", describe: describeStatus },
    { matches: (m, p) => ["PATCH", "PUT"].includes(m) && p.includes("/penalty-results/"), action: "Updated penalty result", resourceType: "penalty result", category: "Penalties & Fines", describe: describeDetails },
    { matches: (m, p) => m === "DELETE" && p.startsWith("/api/fines/penalty-results"), action: "Deleted penalty result", resourceType: "penalty result", category: "Penalties & Fines", describe: describePenalty },
    { matches: (m, p) => m === "POST" && p === "/api/fines/zero-attendance", action: "Registered zero attendance", resourceType: "fine", category: "Penalties & Fines", describe: describeName },
    { matches: (m, p) => m === "PATCH" && /^\/api\/fines\/[^/]+\/status$/.test(p), action: "Updated fine status", resourceType: "fine", category: "Penalties & Fines", describe: describeStatus },
  ];

  const match = rules.find((rule) => rule.matches(normalizedMethod, path));
  if (match) {
    return {
      action: match.action,
      resourceType: match.resourceType,
      resourceId,
      category: match.category,
      describe: match.describe,
    };
  }

  const segments = path.split("/").filter(Boolean);
  const meaningfulSegments = segments.filter((segment) => !UUID_PATTERN.test(segment));
  const suffix = meaningfulSegments.slice(-2).join("/") || "unknown/route";
  return {
    action: `${normalizedMethod} ${suffix}`,
    resourceType: meaningfulSegments[meaningfulSegments.length - 1]?.replace(/[-_]+/g, " ") ?? "record",
    resourceId,
    category: categoryFromRoute(normalizedMethod, path),
    unmappedRoute: true,
    describe: describeDetails,
  };
}

function categoryFromRoute(method: string, path: string): AuditCategory {
  if (method.toUpperCase() === "SYSTEM") return "System";
  if (/^\/api\/(auth|users)(\/|$)/.test(path)) return "Authentication & Accounts";
  if (path.startsWith("/api/school-years")) return "School Years";
  if (path.startsWith("/api/attendance/requests")) return "Attendance Requests";
  if (/^\/api\/attendance\/event-(?:year-level-)?exemptions(?:\/|$)/.test(path)) return "Attendance Exemptions";
  if (path.startsWith("/api/attendance/events") || path.startsWith("/api/attendance/event-college-checker")) return "Attendance Events";
  if (/^\/api\/attendance\/imports?(?:\/|$)/.test(path)) return "Attendance Imports";
  if (path.startsWith("/api/attendance/manual")) return "Manual Attendance";
  if (path.startsWith("/api/attendance/calculation-results")) return "Calculation Results";
  if (path.startsWith("/api/attendance/")) return "Attendance Records & Final Results";
  if (path.startsWith("/api/fines")) return "Penalties & Fines";
  if (path.startsWith("/api/repository-sync")) return "Repository Sync";
  return "Other";
}

export function getAuditCategory(method: string, route: string): AuditCategory {
  return getAuditContext(method, route).category;
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
      result[key] = normalizedKey.includes("password") || SENSITIVE_KEYS.has(key.toLowerCase()) || SENSITIVE_KEYS.has(normalizedKey)
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
  const route = requestPath(req);
  const method = req.method.toUpperCase();
  if (!MUTATING_METHODS.has(method) || !route.startsWith("/api/") || NON_AUDITED_ROUTES.has(`${method} ${route}`)) {
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
    const attendanceRequestType =
      res.locals.auditAttendanceRequestType ??
      (path === "/api/attendance/requests"
        ? req.body?.requestType ?? req.body?.request_type
        : null);
    if (attendanceRequestType === "details_correction") {
      if (req.method.toUpperCase() === "POST" && path === "/api/attendance/requests") {
        context.action = "Submitted details correction request";
      } else if (req.method.toUpperCase() === "PATCH" && /^\/api\/attendance\/requests\/[^/]+\/review(\/progress)?$/.test(path)) {
        context.action = "Reviewed details correction request";
      }
    }
    const files = summarizeFiles(req);
    const responseActor =
      res.statusCode >= 200 &&
      res.statusCode < 400 &&
      (path === "/api/auth/login" || path === "/api/auth/register")
        ? extractAuthenticatedResponseActor(responseBody)
        : null;
    const actor = req.user ?? responseActor;
    const summary = context.describe?.(req, responseBody) ?? null;
    const details = {
      ...(summary ? { summary: sanitizeValue(summary) } : {}),
      ...(context.unmappedRoute ? { unmappedRoute: true } : {}),
      outcome:
        res.locals.auditOutcome === "failed"
          ? "failed"
          : res.statusCode >= 200 && res.statusCode < 400
            ? "success"
            : "failed",
      durationMs: Date.now() - startedAt,
      ...(Object.keys(req.query ?? {}).length ? { query: sanitizeValue(req.query) } : {}),
      ...(path !== "/api/auth/change-password" && req.body && Object.keys(req.body).length ? { body: sanitizeValue(req.body) } : {}),
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
          category,
          resource_type,
          resource_id,
          method,
          route,
          status_code,
          ip_address,
          user_agent,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
      `,
      [
        actor?.sub ?? null,
        actor?.name ?? null,
        actor?.email ?? null,
        actor?.role ?? null,
        context.action,
        context.category,
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
