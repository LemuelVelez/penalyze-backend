import "dotenv/config";
import crypto from "crypto";

import { closeDatabasePool, query } from "../../lib/db";

type SeedUserRole = "admin" | "staff";

export type SeedUserRecord = {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  role: SeedUserRole;
  created_at: Date;
  updated_at: Date;
};

export type SeedUserResult = {
  user: SeedUserRecord | null;
  email: string;
  alreadySeeded: boolean;
};

function getEnvValue(keys: string[]) {
  for (const key of keys) {
    const value = process.env[key]?.trim();

    if (value) {
      return value;
    }
  }

  return "";
}

function normalizeRole(role: string): SeedUserRole {
  return role === "staff" ? "staff" : "admin";
}

function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function isCurrentPasswordHash(storedHash: string) {
  const [salt, hash] = storedHash.split(":");

  return Boolean(salt && hash);
}

function getSeedUserCredentials() {
  const email = getEnvValue(["SEED_USER_EMAIL", "User"]);
  const password = getEnvValue(["SEED_USER_PASSWORD", "Password"]);

  if (!email) {
    throw new Error("Missing seeded user email. Add User=superuser@localhost.local or SEED_USER_EMAIL to .env.");
  }

  if (!password) {
    throw new Error("Missing seeded user password. Add Password=87654321 or SEED_USER_PASSWORD to .env.");
  }

  return {
    email,
    password,
    name: getEnvValue(["SEED_USER_NAME"]) || "Super User",
    role: normalizeRole(getEnvValue(["SEED_USER_ROLE"]) || "admin")
  };
}

export async function seedUser(): Promise<SeedUserResult> {
  const { email, password, name, role } = getSeedUserCredentials();

  const existingResult = await query<SeedUserRecord>(
    `
      SELECT id, name, email, password_hash, role, created_at, updated_at
      FROM users
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1
    `,
    [email]
  );

  const existingUser = existingResult.rows[0];

  if (existingUser) {
    if (!isCurrentPasswordHash(existingUser.password_hash)) {
      const passwordHash = hashPassword(password);
      const updatedResult = await query<SeedUserRecord>(
        `
          UPDATE users
          SET password_hash = $1, updated_at = NOW()
          WHERE id = $2
          RETURNING id, name, email, password_hash, role, created_at, updated_at
        `,
        [passwordHash, existingUser.id]
      );

      return {
        user: updatedResult.rows[0] ?? existingUser,
        email,
        alreadySeeded: true
      };
    }

    return {
      user: existingUser,
      email,
      alreadySeeded: true
    };
  }

  const passwordHash = hashPassword(password);
  const result = await query<SeedUserRecord>(
    `
      INSERT INTO users (name, email, password_hash, role)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, password_hash, role, created_at, updated_at
    `,
    [name, email, passwordHash, role]
  );

  return {
    user: result.rows[0] ?? null,
    email,
    alreadySeeded: false
  };
}

if (require.main === module) {
  seedUser()
    .then(async (result) => {
      console.log(
        result.alreadySeeded
          ? `Seeded user already seeded: ${result.email}`
          : `Seeded user created: ${result.email}`
      );
      await closeDatabasePool();
    })
    .catch(async (error) => {
      console.error("User seeder failed:", error);
      await closeDatabasePool();
      process.exit(1);
    });
}