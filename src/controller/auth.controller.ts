import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

import type { UserRecord, UserRole } from "../database/model/schema.model";
import { query } from "../lib/db";

type JwtPayload = {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  exp: number;
};

export type AuthenticatedRequest = Request & {
  user?: JwtPayload;
};

const TOKEN_TTL_SECONDS = Number(process.env.JWT_TTL_SECONDS ?? 60 * 60 * 24 * 7);
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-before-production";

function base64UrlEncode(input: Buffer | string) {
  return Buffer.from(input).toString("base64url");
}

function base64UrlDecode(input: string) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function signData(data: string) {
  return crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64url");
}

function signToken(payload: Omit<JwtPayload, "exp">) {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(
    JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS
    })
  );
  const signature = signData(`${header}.${body}`);

  return `${header}.${body}.${signature}`;
}

function verifyToken(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expectedSignature = signData(`${header}.${body}`);

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (signatureBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;

  const payload = JSON.parse(base64UrlDecode(body)) as JwtPayload;
  if (!payload?.sub || !payload?.email || !payload?.exp) return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, storedHash: string) {
  const [salt, hash] = storedHash.split(":");
  if (!salt || !hash) return false;

  const computed = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (computed.length !== stored.length) return false;

  return crypto.timingSafeEqual(computed, stored);
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
    if (!name) {
      res.status(400).json({ message: "Name is required." });
      return;
    }

    if (!email) {
      res.status(400).json({ message: "Email is required." });
      return;
    }

    if (password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters." });
      return;
    }

    const role: UserRole = "admin";
    const passwordHash = hashPassword(password);

    const result = await query<UserRecord>(
      `
        INSERT INTO users (name, email, password_hash, role)
        VALUES ($1, $2, $3, $4)
        RETURNING *
      `,
      [name, email, passwordHash, role]
    );

    const user = result.rows[0];
    const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role });

    res.status(201).json({
      message: "Account created successfully.",
      data: {
        user: publicUser(user),
        token
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

    if (!email || !password) {
      res.status(400).json({ message: "Email and password are required." });
      return;
    }

    const result = await query<UserRecord>("SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1", [email]);
    const user = result.rows[0];

    if (!user) {
      res.status(401).json({ message: "Invalid email or password." });
      return;
    }

    const isCurrentPassword = verifyPassword(password, user.password_hash);
    const isLegacyPassword = isCurrentPassword
      ? false
      : await verifyLegacyPostgresPassword(password, user.password_hash);

    if (!isCurrentPassword && !isLegacyPassword) {
      res.status(401).json({ message: "Invalid email or password." });
      return;
    }

    if (isLegacyPassword) {
      const migratedPasswordHash = hashPassword(password);

      await query(
        `
          UPDATE users
          SET password_hash = $1, updated_at = NOW()
          WHERE id = $2
        `,
        [migratedPasswordHash, user.id]
      );
    }

    const token = signToken({ sub: user.id, email: user.email, name: user.name, role: user.role });

    res.json({
      message: "Login successful.",
      data: {
        user: publicUser(user),
        token
      }
    });
  } catch (error) {
    next(error);
  }
}

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";

    if (!token) {
      res.status(401).json({ message: "Authentication token is required." });
      return;
    }

    const payload = verifyToken(token);
    if (!payload) {
      res.status(401).json({ message: "Invalid or expired authentication token." });
      return;
    }

    req.user = payload;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired authentication token." });
  }
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

    if (password !== undefined && password.length > 0 && password.length < 6) {
      res.status(400).json({ message: "Password must be at least 6 characters." });
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
      params.push(hashPassword(password));
      fields.push(`password_hash = $${params.length}`);
    }

    if (!fields.length) {
      res.status(400).json({ message: "No user changes were provided." });
      return;
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