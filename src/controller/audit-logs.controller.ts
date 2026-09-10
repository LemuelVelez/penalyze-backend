import type { NextFunction, Response } from "express";

import type { AuthenticatedRequest } from "./auth.controller";
import { query } from "../lib/db";

type AuditLogRow = {
  id: string;
  user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  method: string;
  route: string;
  status_code: number;
  ip_address: string | null;
  user_agent: string | null;
  details: Record<string, unknown>;
  created_at: Date | string;
};

type CountRow = { total: string };

function positiveInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function validDate(value: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function listAuditLogs(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const page = positiveInteger(req.query.page, 1);
    const limit = Math.min(100, positiveInteger(req.query.limit, 50));
    const offset = (page - 1) * limit;
    const search = cleanText(req.query.search);
    const outcome = cleanText(req.query.outcome).toLowerCase();
    const from = validDate(cleanText(req.query.from));
    const to = validDate(cleanText(req.query.to));

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      params.push(`%${search}%`);
      const index = params.length;
      where.push(`(
        actor_name ILIKE $${index}
        OR actor_email ILIKE $${index}
        OR action ILIKE $${index}
        OR resource_type ILIKE $${index}
        OR COALESCE(resource_id, '') ILIKE $${index}
        OR route ILIKE $${index}
      )`);
    }

    if (outcome === "success") {
      where.push("status_code >= 200 AND status_code < 400");
    } else if (outcome === "failed") {
      where.push("status_code >= 400");
    }

    if (from) {
      params.push(from);
      where.push(`created_at >= $${params.length}`);
    }

    if (to) {
      params.push(to);
      where.push(`created_at <= $${params.length}`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countParams = [...params];

    params.push(limit, offset);
    const rows = await query<AuditLogRow>(
      `
        SELECT
          id,
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
          details,
          created_at
        FROM audit_logs
        ${whereSql}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length - 1}
        OFFSET $${params.length}
      `,
      params,
    );

    const count = await query<CountRow>(
      `SELECT COUNT(*)::text AS total FROM audit_logs ${whereSql}`,
      countParams,
    );

    const total = Number(count.rows[0]?.total ?? 0);
    res.json({
      data: rows.rows,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
}
