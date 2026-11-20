import { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.controller";
import { query } from "../lib/db";

// The integration key is held exclusively by this backend, never the browser.
const REPOSITORY_BASE = (process.env.ATTENDANCE_REPOSITORY_URL || process.env.AttendanceRepository_URL || "")
  .trim().replace(/\/+$/, "").replace(/\/api$/i, "").replace(/\/+$/, "");
const INTEGRATION_KEY = (process.env.PENALYZE_INTEGRATION_KEY || process.env.Penalyze_Integration_Key || "").trim();
const MAX_BATCH = 200;
const MAX_DOWNLOAD_BYTES = Math.max(1024 * 1024, Math.min(50 * 1024 * 1024,
  Number(process.env.REPOSITORY_MAX_DOWNLOAD_BYTES) || 25 * 1024 * 1024));
const MAX_METADATA_BYTES = 2 * 1024 * 1024;

async function readBoundedResponse(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length") || 0);
  if (advertised > maxBytes) throw Object.assign(new Error("Repository file is too large."), { status: 413 });
  if (!response.body) throw Object.assign(new Error("Repository returned an empty response."), { status: 502 });
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(new Error("Repository response exceeded the allowed size."), { status: 413 });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SyncAction = "pending" | "uploaded" | "reset";
type RepositoryUpload = {
  id: string;
  originalName: string;
  penalyzeStatus: "untracked" | "pending" | "uploaded" | "outdated";
};

function getActor(req: AuthenticatedRequest): string {
  return String(req.user?.name || req.user?.email || req.user?.sub || "").trim().slice(0, 255);
}

async function repositoryRequest(path: string, init: RequestInit = {}): Promise<globalThis.Response> {
  if (!REPOSITORY_BASE || !INTEGRATION_KEY) {
    throw Object.assign(new Error("AttendanceRepository integration is not configured."), { status: 503 });
  }
  let url: URL;
  try {
    url = new URL(REPOSITORY_BASE);
    if ((url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.hostname === "localhost")) || url.username || url.password || url.search || url.hash) {
      throw new Error("Unsafe repository origin");
    }
  } catch {
    throw Object.assign(new Error("AttendanceRepository URL is not configured securely."), { status: 503 });
  }
  let response: globalThis.Response;
  try {
    response = await fetch(`${REPOSITORY_BASE}/api/penalyze-sync${path}`, {
      ...init,
      headers: {
        "X-Integration-Key": INTEGRATION_KEY,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw Object.assign(new Error("AttendanceRepository is unavailable."), { status: 502 });
  }
  if (!response.ok) {
    // An invalid server-to-server key must not sign out an authenticated Penalyze user.
    const status = response.status === 401 || response.status === 403 ? 502 : response.status;
    throw Object.assign(new Error(response.status === 401 || response.status === 403
      ? "AttendanceRepository rejected the integration credentials."
      : `AttendanceRepository request failed (${response.status}).`), { status });
  }
  return response;
}

async function getRepositoryUploads(): Promise<RepositoryUpload[]> {
  const response = await repositoryRequest("/uploads?status=all");
  const payload = JSON.parse((await readBoundedResponse(response, MAX_METADATA_BYTES)).toString("utf8")) as { uploads?: RepositoryUpload[] };
  if (!Array.isArray(payload.uploads)) {
    throw Object.assign(new Error("AttendanceRepository returned invalid upload metadata."), { status: 502 });
  }
  return payload.uploads;
}

function errorResponse(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof Error && typeof (error as Error & {status?: number}).status === "number") {
    const status = (error as Error & { status: number }).status;
    res.status(status).json({ message: error.message });
    return;
  }
  next(error);
}

export async function listRepositoryUploads(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const status = String(req.query.status ?? "all");
  if (!["all", "untracked", "pending", "uploaded", "outdated"].includes(status)) {
    res.status(400).json({ message: "Invalid sync status." });
    return;
  }
  try {
    const response = await repositoryRequest(`/uploads?status=${encodeURIComponent(status)}`);
    const payload = JSON.parse((await readBoundedResponse(response, MAX_METADATA_BYTES)).toString("utf8")) as { uploads: unknown[] };
    res.json({ data: payload.uploads, message: "Repository sync statuses loaded." });
  } catch (error) { errorResponse(error, res, next); }
}

export async function downloadRepositoryUpload(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const id = String(req.params.id ?? "");
  if (!UUID.test(id)) { res.status(400).json({ message: "Invalid upload ID." }); return; }
  try {
    const response = await repositoryRequest(`/uploads/${encodeURIComponent(id)}/download`);
    const data = await readBoundedResponse(response, MAX_DOWNLOAD_BYTES);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="repository-upload-${id}.xlsx"`);
    res.send(data);
  } catch (error) { errorResponse(error, res, next); }
}

export function changeRepositorySync(action: SyncAction) {
  return async function (req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const ids = req.body?.uploadIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BATCH || ids.some((id) => typeof id !== "string" || !UUID.test(id))) {
      res.status(400).json({ message: "Provide 1 to 200 valid upload IDs." });
      return;
    }
    const importId = req.body?.penalyzeImportId;
    const note = req.body?.note;
    if (importId != null && importId !== "" && (typeof importId !== "string" || !UUID.test(importId))) {
      res.status(400).json({ message: "penalyzeImportId must be a UUID." });
      return;
    }
    if (note != null && (typeof note !== "string" || note.length > 4000)) {
      res.status(400).json({ message: "note must be at most 4000 characters." });
      return;
    }
    try {
      if (action === "pending") {
        // A direct API request must not undo a completed upload, even if the
        // browser is stale or bypasses the disabled Pending button.
        const uploads = await getRepositoryUploads();
        if (ids.some((id) => uploads.some((item) => item.id === id && item.penalyzeStatus === "uploaded"))) {
          res.status(409).json({ message: "An already-uploaded workbook cannot be marked pending. Its saved attendance records are unchanged." });
          return;
        }
      }
      const response = await repositoryRequest(`/${action}`, {
        method: "POST",
        body: JSON.stringify({
          uploadIds: ids,
          markedBy: getActor(req),
          ...(action === "uploaded" ? { penalyzeImportId: importId || undefined, note: note || "" } : {}),
        }),
      });
      const payload = await response.json() as { uploadIds: string[] };
      res.json({ data: { uploadIds: payload.uploadIds }, message: `Repository records marked ${action}.` });
    } catch (error) { errorResponse(error, res, next); }
  };
}

// Recover an untracked or pending workbook after attendance was already saved.
// This only updates Repository Sync metadata; it never imports rows.
// Reject ambiguous filename matches and workbooks changed since an import.
export async function restoreRepositoryUploadedStatus(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const uploadId = req.body?.uploadId;
  if (typeof uploadId !== "string" || !UUID.test(uploadId)) {
    res.status(400).json({ message: "Provide a valid repository upload ID." });
    return;
  }

  try {
    const uploads = await getRepositoryUploads();
    const workbook = uploads.find((item) => item.id === uploadId);
    if (!workbook) {
      res.status(404).json({ message: "Repository workbook not found." });
      return;
    }
    if (workbook.penalyzeStatus === "uploaded") {
      res.json({ data: { uploadId, penalyzeImportId: "" }, message: "Workbook is already marked uploaded." });
      return;
    }
    if (workbook.penalyzeStatus !== "pending" && workbook.penalyzeStatus !== "untracked") {
      res.status(409).json({ message: "Only untracked or pending workbooks can be matched to a saved import. Outdated files must be reviewed separately." });
      return;
    }
    if (typeof workbook.originalName !== "string" || !workbook.originalName.trim()) {
      res.status(502).json({ message: "Repository workbook has no filename to match to a saved import." });
      return;
    }

    const imports = await query<{ id: string }>(
      `SELECT id FROM attendance_imports
       WHERE status = 'saved' AND deleted_at IS NULL
         AND LOWER(BTRIM(file_name)) = LOWER(BTRIM($1))
       ORDER BY created_at DESC LIMIT 2`,
      [workbook.originalName.normalize("NFC")],
    );
    if (imports.rows.length === 0) {
      res.status(404).json({ message: "No saved Penalyze attendance import matches this workbook. Its status was not changed." });
      return;
    }
    if (imports.rows.length > 1) {
      res.status(409).json({ message: "Multiple saved imports have this filename. Restore the correct one manually using its Penalyze import UUID." });
      return;
    }

    const penalyzeImportId = imports.rows[0].id;
    await repositoryRequest("/uploaded", {
      method: "POST",
      body: JSON.stringify({
        uploadIds: [uploadId],
        penalyzeImportId,
        markedBy: getActor(req),
        note: "Restored status from an existing saved Penalyze import; no new attendance imported",
      }),
    });
    res.json({
      data: { uploadId, penalyzeImportId },
      message: "Repository uploaded status restored from the existing attendance import.",
    });
  } catch (error) { errorResponse(error, res, next); }
}
