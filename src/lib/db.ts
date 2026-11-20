import "dotenv/config";
import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

const databaseUrlKey = (["PostgreDatabase", "POSTGRE_DATABASE", "DATABASE_URL"] as const)
  .find((key) => Boolean(process.env[key]?.trim()));
if (process.env.NODE_ENV === "production" && !databaseUrlKey) {
  throw new Error("Set PostgreDatabase or DATABASE_URL in production; no default credentials are permitted.");
}
const connectionString = databaseUrlKey
  ? process.env[databaseUrlKey]!.trim()
  : "postgresql://postgres:password@localhost:5432/penalyze";

// DNS EAI_AGAIN is temporary; retry establishing a connection, never replay a
// statement after it has been sent on an established connection.
const configuredDnsRetryAttempts = Number(process.env.DB_DNS_RETRY_ATTEMPTS ?? 3);
const dnsRetryAttempts = Number.isFinite(configuredDnsRetryAttempts)
  ? Math.min(5, Math.max(1, Math.floor(configuredDnsRetryAttempts)))
  : 3;
const configuredDnsRetryDelayMs = Number(process.env.DB_DNS_RETRY_BASE_DELAY_MS ?? 500);
const dnsRetryDelayMs = Number.isFinite(configuredDnsRetryDelayMs)
  ? Math.min(10000, Math.max(0, configuredDnsRetryDelayMs))
  : 500;

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
  Number(process.env.DB_LOCK_TIMEOUT_MS ?? 5000),
);

const transactionStatementTimeoutMs = Math.max(
  0,
  Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 30000),
);

// Coolify's internal PostgreSQL service typically has no TLS listener. Use
// plaintext only for loopback/private-network hosts, unless the operator
// explicitly specifies DB_SSL_MODE. Public database hosts still require TLS.
function isPrivateDatabaseHost(connectionUrl: string): boolean {
  let host: string;
  try {
    host = new URL(connectionUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }

  if (
    host === "localhost" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith(".docker") ||
    host.endsWith(".svc.cluster.local")
  ) return true;

  // Docker's private service discovery uses single-label hostnames.
  if (/^[a-z0-9][a-z0-9-]*$/.test(host)) return true;

  // RFC1918 and loopback IPv4 addresses are private endpoints.
  const octets = host.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const [a, b, c, d] = octets.map(Number);
  if ([a, b, c, d].some((octet) => octet > 255)) return false;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const defaultSslMode = process.env.NODE_ENV === "production" && !isPrivateDatabaseHost(connectionString)
  ? "verify-full"
  : "disable";
const sslMode = (process.env.DB_SSL_MODE?.trim() || defaultSslMode).toLowerCase();
if (sslMode !== "verify-full" && sslMode !== "disable") {
  throw new Error("DB_SSL_MODE must be verify-full or disable.");
}

// node-postgres gives SSL parameters in a connection URL precedence over the
// Pool's ssl option. Remove those parameters when SSL is disabled so a stale
// ?sslmode=require cannot silently override DB_SSL_MODE=disable.
let poolConnectionString = connectionString;
if (sslMode === "disable") {
  const url = new URL(connectionString);
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"]) {
    url.searchParams.delete(key);
  }
  poolConnectionString = url.toString();
}

export const pool = new Pool({
  connectionString: poolConnectionString,
  ssl: sslMode === "verify-full" ? { rejectUnauthorized: true } : false,
  statement_timeout: Number(process.env.DB_QUERY_TIMEOUT_MS ?? 30000),
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

function dnsFailureError(error: unknown): Error {
  let host = "the configured host";
  try {
    host = new URL(connectionString).hostname || host;
  } catch {
    // Invalid connection strings will be reported separately by pg.
  }

  const source = databaseUrlKey ? `${databaseUrlKey} in your .env` : "the default database URL";
  return new Error(
    `PostgreSQL hostname ${host} could not be resolved (EAI_AGAIN) after ${dnsRetryAttempts} attempt(s). ` +
      `Check ${source} for the correct hostname, your internet/DNS connection, and the database provider's status. ` +
      "If running locally with a private/internal database hostname, use the provider's public connection URL instead.",
    { cause: error },
  );
}

// pool.query() and pool.connect() resolve the host before handing out a client.
// Retry only temporary DNS failures at this boundary, not SQL execution errors.
async function retryTemporaryDnsFailure<T>(connectOrQuery: () => Promise<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await connectOrQuery();
    } catch (error) {
      if (getDatabaseErrorCode(error) !== "EAI_AGAIN") throw error;
      attempt += 1;
      if (attempt >= dnsRetryAttempts) throw dnsFailureError(error);
      await wait(dnsRetryDelayMs * 2 ** (attempt - 1));
    }
  }
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
  return retryTemporaryDnsFailure(() => pool.query<T>(text, params));
}

export async function withTransaction<T>(
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < transactionRetryAttempts; attempt += 1) {
    let client: PoolClient | null = null;

    try {
      client = await retryTemporaryDnsFailure(() => pool.connect());
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