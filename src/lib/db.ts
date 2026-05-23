import "dotenv/config";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const connectionString =
  process.env.PostgreDatabase ||
  process.env.POSTGRE_DATABASE ||
  process.env.DATABASE_URL ||
  "postgresql://postgres:password@localhost:5432/penalyze";

const TRANSACTION_RETRY_ERROR_CODES = new Set([
  "40P01", // deadlock_detected
  "40001", // serialization_failure
  "55P03", // lock_not_available
  "53300", // too_many_connections
  "57P03", // cannot_connect_now
]);

const transactionRetryAttempts = Math.max(
  1,
  Number(process.env.DB_TRANSACTION_RETRY_ATTEMPTS ?? 3),
);

const transactionRetryBaseDelayMs = Math.max(
  0,
  Number(process.env.DB_TRANSACTION_RETRY_BASE_DELAY_MS ?? 75),
);

const transactionLockTimeoutMs = Math.max(
  0,
  Number(process.env.DB_LOCK_TIMEOUT_MS ?? 0),
);

const transactionStatementTimeoutMs = Math.max(
  0,
  Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 0),
);

export const pool = new Pool({
  connectionString,
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 10000),
});

pool.on("error", (error) => {
  console.error("Unexpected PostgreSQL pool error:", error);
});

function getDatabaseErrorCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
}

function getDatabaseErrorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : "";
}

function isRetryableTransactionError(error: unknown) {
  const code = getDatabaseErrorCode(error);
  const message = getDatabaseErrorMessage(error);

  return (
    TRANSACTION_RETRY_ERROR_CODES.has(code) ||
    message.includes("deadlock detected") ||
    message.includes("timeout exceeded when trying to connect") ||
    message.includes("terminating connection due to administrator command")
  );
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attemptIndex: number) {
  if (transactionRetryBaseDelayMs <= 0) return 0;

  const backoff = transactionRetryBaseDelayMs * 2 ** attemptIndex;
  const jitter = Math.floor(Math.random() * transactionRetryBaseDelayMs);

  return backoff + jitter;
}

async function applyTransactionTimeouts(client: PoolClient) {
  if (transactionLockTimeoutMs > 0) {
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${transactionLockTimeoutMs}ms`,
    ]);
  }

  if (transactionStatementTimeoutMs > 0) {
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${transactionStatementTimeoutMs}ms`,
    ]);
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTransaction<T>(
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < transactionRetryAttempts; attempt += 1) {
    let client: PoolClient | null = null;

    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await applyTransactionTimeouts(client);

      const result = await handler(client);

      await client.query("COMMIT");
      return result;
    } catch (error) {
      lastError = error;

      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error("Failed to rollback PostgreSQL transaction:", rollbackError);
        }
      }

      if (
        attempt >= transactionRetryAttempts - 1 ||
        !isRetryableTransactionError(error)
      ) {
        throw error;
      }

      const delay = getRetryDelayMs(attempt);
      if (delay > 0) await wait(delay);
    } finally {
      client?.release();
    }
  }

  throw lastError;
}

export async function closeDatabasePool() {
  await pool.end();
}

export function getDatabaseUrl() {
  return connectionString;
}