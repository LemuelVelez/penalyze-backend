import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";
import { query } from "../lib/db";

const secret = process.env.RATE_LIMIT_SECRET || process.env.JWT_SECRET || "";
if (!secret || secret.length < 32) throw new Error("RATE_LIMIT_SECRET or JWT_SECRET must contain at least 32 characters.");

function hash(value: string) {
  return crypto.createHmac("sha256", secret).update(value).digest("hex");
}

export function clientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

let lastCleanup = 0;

export async function chargeLimit(group: string, identity: string, max: number, windowSeconds: number): Promise<number> {
  const seconds = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(seconds / windowSeconds) * windowSeconds;
  const result = await query<{ request_count: number }>(`
    INSERT INTO public.rate_limits AS rl (key_hash, window_start, request_count, expires_at)
    VALUES ($1, $2, 1, TO_TIMESTAMP($2::bigint + $3::integer))
    ON CONFLICT (key_hash, window_start) DO UPDATE SET
      request_count = rl.request_count + 1
    RETURNING request_count
  `, [hash(`${group}:${identity.toLowerCase()}`), windowStart, windowSeconds]);
  if (Date.now() - lastCleanup > 12 * 3600000) {
    lastCleanup = Date.now();
    void query("DELETE FROM public.rate_limits WHERE expires_at < NOW()").catch(() => undefined);
  }
  if (result.rows[0].request_count > max) return Math.max(1, windowStart + windowSeconds - seconds);
  return 0;
}

export function rateLimit(group: string, max: number, seconds: number, value: (req: Request) => string = clientIp) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const retry = await chargeLimit(group, value(req).slice(0, 300), max, seconds);
      if (retry) {
        res.setHeader("Retry-After", String(retry));
        res.status(429).json({ message: "Too many requests. Please try again later." });
        return;
      }
      next();
    } catch (error) { next(error); }
  };
}

// Call with independent scopes, e.g. per-IP AND per-student-ID.
export function limits(...checks: Array<[string, number, number, (req: Request) => string]>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      for (const [group, max, seconds, getIdentity] of checks) {
        const retry = await chargeLimit(group, getIdentity(req).slice(0, 300), max, seconds);
        if (retry) {
          res.setHeader("Retry-After", String(retry));
          res.status(429).json({ message: "Too many requests. Please try again later." });
          return;
        }
      }
      next();
    } catch (error) { next(error); }
  };
}
