import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

import { query, withTransaction } from "../lib/db";

// Local traffic limiting mitigates bursts; PostgreSQL counters below remain
// shared across server instances and survive restarts.
const MAX_REQUESTS_PER_IP_PER_MINUTE = 40;
const MAX_FAILURES_PER_IP = 30;
const MAX_FAILURES_PER_IP_EMAIL = 8;
const FAILURE_WINDOW_MINUTES = 15;
const BLOCK_MINUTES = 30;
const LOCAL_BUCKET_LIMIT = 10_000;
const IDENTIFIER_SECRET = process.env.LOGIN_RATE_LIMIT_SECRET
  || process.env.JWT_SECRET
  || "development-only-login-throttle-secret";

type LocalBucket = { count: number; resetAt: number };
const localBuckets = new Map<string, LocalBucket>();
let lastCleanupAt = 0;

function requestIp(req: Request): string {
  // Express computes req.ip using ONLY the explicitly configured trusted proxy hops.
  return req.ip || req.socket.remoteAddress || "unknown";
}

function hashIdentifier(value: string): string {
  return crypto.createHmac("sha256", IDENTIFIER_SECRET).update(value).digest("hex");
}

function keysFor(ip: string, email: string) {
  return {
    ip: hashIdentifier(`ip:${ip}`),
    pair: hashIdentifier(`ip-email:${ip}:${email.trim().toLowerCase()}`),
  };
}

function sendBlocked(res: Response, retryAfterSeconds: number) {
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  res.setHeader("Cache-Control", "no-store");
  res.status(429).json({
    message: "Too many sign-in attempts. Please try again later.",
  });
}

/** A small, bounded per-process burst limiter, including malformed login bodies. */
export function limitLoginTraffic(req: Request, res: Response, next: NextFunction) {
  const now = Date.now();
  const key = requestIp(req);
  const existing = localBuckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { count: 0, resetAt: now + 60_000 };

  bucket.count += 1;
  // Refresh insertion order so oldest entries are evicted first when necessary.
  localBuckets.delete(key);
  localBuckets.set(key, bucket);

  if (localBuckets.size > LOCAL_BUCKET_LIMIT) {
    for (const [ip, value] of localBuckets) {
      if (value.resetAt <= now) localBuckets.delete(ip);
    }
    while (localBuckets.size > LOCAL_BUCKET_LIMIT) {
      const oldest = localBuckets.keys().next().value;
      if (oldest === undefined) break;
      localBuckets.delete(oldest);
    }
  }

  if (bucket.count > MAX_REQUESTS_PER_IP_PER_MINUTE) {
    sendBlocked(res, (bucket.resetAt - now) / 1000);
    return;
  }

  next();
}

export async function getLoginBlockSeconds(req: Request, email: string): Promise<number> {
  const { ip, pair } = keysFor(requestIp(req), email);
  const result = await query<{ seconds: number }>(
    `
      SELECT COALESCE(
        CEIL(EXTRACT(EPOCH FROM MAX(blocked_until) - NOW())), 0
      )::integer AS seconds
      FROM public.auth_login_throttles
      WHERE key_hash = ANY($1::text[]) AND blocked_until > NOW()
    `,
    [[ip, pair]],
  );
  return Math.max(0, Number(result.rows[0]?.seconds ?? 0));
}

/** Persist each failed attempt atomically, for known AND unknown email addresses. */
export async function recordFailedLogin(req: Request, email: string): Promise<number> {
  const { ip, pair } = keysFor(requestIp(req), email);
  const blockedSeconds = await withTransaction(async (client) => {
    let longestBlock = 0;
    // Always acquire the IP key first; concurrent requests cannot invert lock order.
    for (const [key, threshold] of [
      [ip, MAX_FAILURES_PER_IP],
      [pair, MAX_FAILURES_PER_IP_EMAIL],
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
  // Clear only the successful IP/email pair; other failed logins from this IP
  // must still count toward IP-wide protection.
  const { pair } = keysFor(requestIp(req), email);
  await query("DELETE FROM public.auth_login_throttles WHERE key_hash = $1", [pair]);
}

export function respondToBlockedLogin(res: Response, retryAfterSeconds: number) {
  sendBlocked(res, retryAfterSeconds);
}
