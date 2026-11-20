import crypto from "crypto";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { NextFunction, Request, Response } from "express";

import type { UserRecord, UserRole } from "../database/model/schema.model";
import { query } from "../lib/db";
import {
  clearSuccessfulLogin,
  getLoginBlockSeconds,
  recordFailedLogin,
  respondToBlockedLogin,
} from "../services/login-protection.service";

type JwtPayload = {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  tokenVersion: number;
  exp?: number;
};

export type AuthenticatedRequest = Request & { user?: JwtPayload };

const JWT_SECRET = process.env.JWT_SECRET?.trim() ?? "";
if (JWT_SECRET.length < 32 || /^(change-this|secret-key|replace|example|your-|test|development)/i.test(JWT_SECRET)) {
  throw new Error("JWT_SECRET must be a strong, non-placeholder secret of at least 32 characters.");
}
const ISSUER = process.env.JWT_ISSUER || "penalyze-api";
const AUDIENCE = process.env.JWT_AUDIENCE || "penalyze-frontend";
// Bound cookie lifetime; token_version provides immediate logout/password revocation.
const TOKEN_TTL_SECONDS = 4 * 60 * 60;
const REMEMBER_TOKEN_TTL_SECONDS = 2 * 24 * 60 * 60;
const COOKIE_NAME = "penalyze_session";
const USER_ROLES: UserRole[] = ["admin", "officer"];
const COOKIE_SECURE = process.env.NODE_ENV === "production";

function signToken(user: UserRecord, ttlSeconds: number): string {
  return jwt.sign({ email: user.email, name: user.name, role: user.role, tokenVersion: user.token_version }, JWT_SECRET, {
    algorithm: "HS256", subject: user.id, issuer: ISSUER, audience: AUDIENCE, expiresIn: ttlSeconds,
  });
}

function verifyToken(token: string): JwtPayload | null {
  try {
    const value = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"], issuer: ISSUER, audience: AUDIENCE });
    if (typeof value !== "object" || typeof value.sub !== "string" || !Number.isInteger(value.tokenVersion)) return null;
    return value as JwtPayload;
  } catch { return null; }
}

function requestToken(req: Request): string {
  const cookie = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return cookie ? decodeURIComponent(cookie.slice(COOKIE_NAME.length + 1)) : "";
}

function setSessionCookie(res: Response, token: string, seconds: number): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/", maxAge: seconds * 1000,
  });
  res.setHeader("Cache-Control", "no-store");
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: COOKIE_SECURE, sameSite: "lax", path: "/" });
  res.setHeader("Cache-Control", "no-store");
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function isUserRole(value: unknown): value is UserRole {
  return USER_ROLES.includes(String(value ?? "").trim().toLowerCase() as UserRole);
}

function parseUserRole(value: unknown, fallback: UserRole = "admin") {
  const role = String(value ?? "").trim().toLowerCase();
  return isUserRole(role) ? role : fallback;
}

const scryptAsync = promisify(crypto.scrypt);
const DUMMY_PASSWORD_HASH = bcrypt.hash("nonexistent-user-placeholder", 12);

function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (storedHash.startsWith("$2")) return bcrypt.compare(password, storedHash);
  const [salt, hash] = storedHash.split(":");
  if (!salt || !/^[a-f0-9]{128}$/i.test(hash)) return false;
  const computed = await scryptAsync(password, salt, 64) as Buffer;
  const stored = Buffer.from(hash, "hex");
  return computed.length === stored.length && crypto.timingSafeEqual(computed, stored);
}

async function verifyLegacyPostgresPassword(password: string, storedHash: string) {
  if (!storedHash || storedHash.includes(":")) {
    return false;
  }

  try {
    const result = await query<{ matches: boolean }>(
      "SELECT crypt($1, $2) = $2 AS matches",
      [password, storedHash]
    );

    return result.rows[0]?.matches === true;
  } catch {
    return false;
  }
}

function getRouteParam(req: Request, key: string) {
  const value = req.params[key];
  return Array.isArray(value) ? value[0] : value;
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.created_at,
    updatedAt: user.updated_at
  };
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const name = cleanText(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    if (!name || name.length > 160) {
      res.status(400).json({ message: "Name must be at most 160 characters." });
      return;
    }

    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ message: "A valid email address is required." });
      return;
    }

    if (password.length < 12 || password.length > 128) {
      res.status(400).json({ message: "Password must be 12 to 128 characters." });
      return;
    }

    if (req.body?.role !== undefined && !isUserRole(req.body.role)) {
      res.status(400).json({ message: "Role must be admin or officer." });
      return;
    }
    const role = parseUserRole(req.body?.role, "admin");
    const passwordHash = await hashPassword(password);

    const result = await query<UserRecord>(
      `
        INSERT INTO users (name, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [name, email, passwordHash, role]
    );

    const user = result.rows[0];
    

    res.status(201).json({
      message: "Account created successfully.",
      data: {
        user: publicUser(user)
      }
    });
  } catch (error: any) {
    if (String(error?.code) === "23505") {
      res.status(409).json({ message: "Email is already registered." });
      return;
    }

    next(error);
  }
}

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");

    // Check both IP-wide and IP/email-specific blocks before any password work.
    const blockedSeconds = await getLoginBlockSeconds(req, email);
    if (blockedSeconds > 0) {
      respondToBlockedLogin(res, blockedSeconds);
      return;
    }

    if (!email || !password || email.length > 254 || password.length > 1024) {
      const retrySeconds = await recordFailedLogin(req, email);
      if (retrySeconds > 0) respondToBlockedLogin(res, retrySeconds);
      else res.status(400).json({ message: "Invalid credentials" });
      return;
    }

    const result = await query<UserRecord>("SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1", [email]);
    const user = result.rows[0];

    // Equalize the local password-check cost for unknown emails to reduce
    // account enumeration via response timing.
    const isCurrentPassword = await verifyPassword(password, user?.password_hash ?? await DUMMY_PASSWORD_HASH);
    const isLegacyPassword = !user || isCurrentPassword
      ? false
      : await verifyLegacyPostgresPassword(password, user.password_hash);

    if (!user || (!isCurrentPassword && !isLegacyPassword)) {
      const retrySeconds = await recordFailedLogin(req, email);
      if (retrySeconds > 0) respondToBlockedLogin(res, retrySeconds);
      else res.status(401).json({ message: "Invalid credentials" });
      return;
    }

    if (isLegacyPassword) {
      const migratedPasswordHash = await hashPassword(password);

      await query(
        `
          UPDATE users
          SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
          WHERE id = $2
        `,
        [migratedPasswordHash, user.id]
      );
    }

    await clearSuccessfulLogin(req, email);

    const remember = req.body?.remember;
    if (remember !== undefined && typeof remember !== "boolean") {
      res.status(400).json({ message: "Remember must be a boolean." });
      return;
    }
    const ttl = remember === true ? REMEMBER_TOKEN_TTL_SECONDS : TOKEN_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    if (isLegacyPassword) user.token_version += 1;
    setSessionCookie(res, signToken(user, ttl), ttl);

    res.json({
      message: "Login successful.",
      data: {
        user: publicUser(user),
        expiresAt
      }
    });
  } catch (error) {
    next(error);
  }
}

export async function changePassword(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) {
      res.status(401).json({ message: "Authentication token is required." });
      return;
    }

    const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string" ||
      typeof confirmPassword !== "string" ||
      !currentPassword ||
      !newPassword ||
      !confirmPassword
    ) {
      res.status(400).json({ message: "All password fields are required." });
      return;
    }

    if (currentPassword.length > 1024) {
      res.status(400).json({ message: "Current password is too long." });
      return;
    }

    if (newPassword.length < 12 || newPassword.length > 128) {
      res.status(400).json({ message: "New password must be 12 to 128 characters." });
      return;
    }

    if (newPassword !== confirmPassword) {
      res.status(400).json({ message: "New password and confirmation do not match." });
      return;
    }

    if (newPassword === currentPassword) {
      res.status(400).json({ message: "New password must be different from your current password." });
      return;
    }

    const result = await query<UserRecord>("SELECT * FROM users WHERE id = $1 LIMIT 1", [req.user.sub]);
    const user = result.rows[0];

    if (!user) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    const validPassword = await verifyPassword(currentPassword, user.password_hash) ||
      await verifyLegacyPostgresPassword(currentPassword, user.password_hash);
    if (!validPassword) {
      res.status(401).json({ message: "Current password is incorrect." });
      return;
    }

    const updated = await query<{ id: string }>(
      `
        UPDATE users
        SET password_hash = $1, token_version = token_version + 1, updated_at = NOW()
        WHERE id = $2 AND password_hash = $3
        RETURNING id
      `,
      [await hashPassword(newPassword), user.id, user.password_hash]
    );

    if (!updated.rows.length) {
      res.status(409).json({ message: "Password was changed in another session. Please try again." });
      return;
    }

    clearSessionCookie(res);
    res.json({ message: "Password changed successfully. Please sign in again." });
  } catch (error) {
    next(error);
  }
}

export async function attachAuthUser(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
  try {
    const token = requestToken(req);
    const payload = token ? verifyToken(token) : null;
    if (payload) {
      const result = await query<UserRecord>("SELECT * FROM users WHERE id = $1 LIMIT 1", [payload.sub]);
      const user = result.rows[0];
      if (user && user.token_version === payload.tokenVersion && isUserRole(user.role)) {
        req.user = { ...payload, email: user.email, name: user.name, role: user.role };
      }
    }
    next();
  } catch (error) { next(error); }
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user?.sub) { res.status(401).json({ message: "Authentication required." }); return; }
  next();
}

export function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.user?.role !== "admin") { res.status(403).json({ message: "Admin access required." }); return; }
  next();
}

export async function logoutSession(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (req.user?.sub) {
      await query("UPDATE users SET token_version = token_version + 1 WHERE id = $1", [req.user.sub]);
    }
    clearSessionCookie(res);
    res.json({ message: "Signed out." });
  } catch (error) { next(error); }
}

export async function logoutEverywhere(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  return logoutSession(req, res, next);
}

export async function me(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    if (!req.user?.sub) {
      res.status(401).json({ message: "Authentication token is required." });
      return;
    }

    const result = await query<UserRecord>("SELECT * FROM users WHERE id = $1 LIMIT 1", [req.user.sub]);
    const user = result.rows[0];

    if (!user) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    res.json({ data: { user: publicUser(user) } });
  } catch (error) {
    next(error);
  }
}

export async function listUsers(_req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const result = await query<UserRecord>(
      `
        SELECT *
        FROM users
        ORDER BY created_at DESC
      `
    );

    res.json({ data: result.rows.map(publicUser) });
  } catch (error) {
    next(error);
  }
}

export async function updateUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const userId = getRouteParam(req, "id");
    const name = req.body?.name === undefined ? undefined : cleanText(req.body.name);
    const email = req.body?.email === undefined ? undefined : normalizeEmail(req.body.email);
    const password = req.body?.password === undefined ? undefined : String(req.body.password ?? "");
    const role = req.body?.role === undefined ? undefined : parseUserRole(req.body.role);

    if (!userId) {
      res.status(400).json({ message: "User ID is required." });
      return;
    }

    if (name !== undefined && !name) {
      res.status(400).json({ message: "Name is required." });
      return;
    }

    if (email !== undefined && !email) {
      res.status(400).json({ message: "Email is required." });
      return;
    }

    if (password !== undefined && password.length > 0 && (password.length < 12 || password.length > 128)) {
      res.status(400).json({ message: "Password must be 12 to 128 characters." });
      return;
    }

    if (req.body?.role !== undefined && !isUserRole(req.body.role)) {
      res.status(400).json({ message: "Role must be admin or officer." });
      return;
    }

    const fields: string[] = [];
    const params: unknown[] = [];

    if (name !== undefined) {
      params.push(name);
      fields.push(`name = $${params.length}`);
    }

    if (email !== undefined) {
      params.push(email);
      fields.push(`email = $${params.length}`);
    }

    if (password !== undefined && password.length > 0) {
      params.push(await hashPassword(password));
      fields.push(`password_hash = $${params.length}`);
    }

    if (role !== undefined) {
      params.push(role);
      fields.push(`role = $${params.length}`);
    }

    if (!fields.length) {
      res.status(400).json({ message: "No user changes were provided." });
      return;
    }

    if ((password !== undefined && password.length > 0) || role !== undefined) {
      fields.push("token_version = token_version + 1");
    }
    params.push(userId);
    const result = await query<UserRecord>(
      `
        UPDATE users
        SET ${fields.join(", ")}, updated_at = NOW()
        WHERE id = $${params.length}
        RETURNING *
      `,
      params
    );

    const user = result.rows[0];
    if (!user) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    res.json({ message: "User updated successfully.", data: publicUser(user) });
  } catch (error: any) {
    if (String(error?.code) === "23505") {
      res.status(409).json({ message: "Email is already registered." });
      return;
    }

    next(error);
  }
}

export async function deleteUser(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const userId = getRouteParam(req, "id");

    if (!userId) {
      res.status(400).json({ message: "User ID is required." });
      return;
    }

    if (req.user?.sub === userId) {
      res.status(400).json({ message: "You cannot delete your currently signed-in account." });
      return;
    }

    const result = await query<UserRecord>("DELETE FROM users WHERE id = $1 RETURNING *", [userId]);
    const user = result.rows[0];

    if (!user) {
      res.status(404).json({ message: "User not found." });
      return;
    }

    res.json({ message: "User deleted successfully.", data: { id: user.id } });
  } catch (error) {
    next(error);
  }
}