import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

import { UserRecord, UserRole } from "../database/model/schema.model";
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

async function countUsers() {
  const result = await query<{ count: string }>("SELECT COUNT(*)::TEXT AS count FROM users");
  return Number(result.rows[0]?.count ?? 0);
}

export async function register(req: Request, res: Response, next: NextFunction) {
  try {
    const name = cleanText(req.body?.name);
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password ?? "");
    const requestedRole = cleanText(req.body?.role) as UserRole;

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

    const existingUsers = await countUsers();
    const role: UserRole = existingUsers === 0 ? "admin" : requestedRole === "admin" ? "admin" : "staff";
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

    const result = await query<UserRecord>("SELECT * FROM users WHERE email = $1 LIMIT 1", [email]);
    const user = result.rows[0];

    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ message: "Invalid email or password." });
      return;
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