import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

import { query, withTransaction } from "../lib/db";

// Login floods and failed attempts are counted in PostgreSQL across all API instances.
import { rateLimit } from "./rate-limit.service";
const MAX_FAILURES_PER_IP = 5;
const MAX_FAILURES_PER_IP_EMAIL = 5;
const FAILURE_WINDOW_MINUTES = 15;
const BLOCK_MINUTES = 30;
const IDENTIFIER_SECRET = process.env.LOGIN_RATE_LIMIT_SECRET || process.env.JWT_SECRET!;
let lastCleanupAt = 0;

function requestIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function hashIdentifier(value: string): string {
  return crypto.createHmac("sha256", IDENTIFIER_SECRET).update(value).digest("hex");
}

function keysFor(ip: string, email: string) {
  return {
    ip: hashIdentifier(`ip:${ip}`),
    pair: hashIdentifier(`ip-email:${ip}:${email.trim().toLowerCase()}`),
    account: hashIdentifier(`account:${email.trim().toLowerCase()}`),
  };
}

function sendBlocked(res: Response, retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.setHeader("Cache-Control", "no-store");
  res.status(429).json({ message: "Too many sign-in attempts. Please try again later." });
}

export const limitLoginTraffic = rateLimit("login:ip", 20, 60);

export async function getLoginBlockSeconds(req: Request, email: string): Promise<number> {
  const { ip, pair, account } = keysFor(requestIp(req), email);
  const result = await query<{ seconds: number }>(
    `
      SELECT COALESCE(
        CEIL(EXTRACT(EPOCH FROM MAX(blocked_until) - NOW())), 0
      )::integer AS seconds
      FROM public.auth_login_throttles
      WHERE key_hash = ANY($1::text[]) AND blocked_until > NOW()
    `,
    [[ip, pair, account]],
  );
  return Math.max(0, Number(result.rows[0]?.seconds ?? 0));
}

/** Persist each failed attempt atomically, for known AND unknown email addresses. */
export async function recordFailedLogin(req: Request, email: string): Promise<number> {
  const { ip, pair, account } = keysFor(requestIp(req), email);
  const blockedSeconds = await withTransaction(async (client) => {
    let longestBlock = 0;
    // Always acquire the IP key first; concurrent requests cannot invert lock order.
    for (const [key, threshold] of [
      [ip, MAX_FAILURES_PER_IP],
      [pair, MAX_FAILURES_PER_IP_EMAIL],
      [account, MAX_FAILURES_PER_IP_EMAIL],
    ] as const) {
      const result = await client.query<{ seconds: number }>(
        `
          INSERT INTO public.auth_login_throttles AS throttle
            (key_hash, failed_attempts, window_started_at, blocked_until, updated_at)
          VALUES ($1, 1, NOW(), NULL, NOW())
          ON CONFLICT (key_hash) DO UPDATE SET
            failed_attempts = CASE
              WHEN throttle.window_started_at <= NOW() - ($2::integer * INTERVAL '1 minute')
                THEN 1
              ELSE throttle.failed_attempts + 1
            END,
            window_started_at = CASE
              WHEN throttle.window_started_at <= NOW() - ($2::integer * INTERVAL '1 minute')
                THEN NOW()
              ELSE throttle.window_started_at
            END,
            blocked_until = CASE
              WHEN throttle.blocked_until > NOW() THEN throttle.blocked_until
              WHEN throttle.window_started_at <= NOW() - ($2::integer * INTERVAL '1 minute')
                THEN NULL
              WHEN throttle.failed_attempts + 1 >= $3::integer
                THEN NOW() + ($4::integer * INTERVAL '1 minute')
              ELSE NULL
            END,
            updated_at = NOW()
          RETURNING GREATEST(0, COALESCE(
            CEIL(EXTRACT(EPOCH FROM blocked_until - NOW())), 0
          ))::integer AS seconds
        `,
        [key, FAILURE_WINDOW_MINUTES, threshold, BLOCK_MINUTES],
      );
      longestBlock = Math.max(longestBlock, Number(result.rows[0]?.seconds ?? 0));
    }
    return longestBlock;
  });

  // Opportunistic cleanup, at most once per day per server process.
  const now = Date.now();
  if (now - lastCleanupAt > 24 * 60 * 60 * 1000) {
    lastCleanupAt = now;
    void query(`
      DELETE FROM public.auth_login_throttles
      WHERE updated_at < NOW() - INTERVAL '7 days'
        AND (blocked_until IS NULL OR blocked_until < NOW())
    `).catch((error) => console.error("Unable to clean expired login throttles:", error));
  }

  return blockedSeconds;
}

export async function clearSuccessfulLogin(req: Request, email: string): Promise<void> {
  // Clear per-account and IP/account failures, but preserve the IP-wide limit.
  const { pair, account } = keysFor(requestIp(req), email);
  await query("DELETE FROM public.auth_login_throttles WHERE key_hash = ANY($1::text[])", [[pair, account]]);
}

export function respondToBlockedLogin(res: Response, retryAfterSeconds: number) {
  sendBlocked(res, retryAfterSeconds);
}
