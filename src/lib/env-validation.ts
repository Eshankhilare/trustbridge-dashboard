import "server-only";

import { z } from "zod";

/**
 * Database connection pool configuration parsed from DATABASE_URL.
 */
export interface DatabasePoolConfig {
  connectionLimit?: number;
  poolTimeout?: number;
  idleInTransactionSessionTimeout?: number;
  pgbouncer?: boolean;
  schema?: string;
}

/**
 * Parses and validates PostgreSQL connection pool and PgBouncer parameters from DATABASE_URL.
 */
export function parseDatabasePoolConfig(urlStr: string): DatabasePoolConfig {
  try {
    const parsedUrl = new URL(urlStr);
    const params = parsedUrl.searchParams;

    const config: DatabasePoolConfig = {};

    const connectionLimitStr = params.get("connection_limit");
    if (connectionLimitStr !== null) {
      const parsed = parseInt(connectionLimitStr, 10);
      if (isNaN(parsed) || parsed < 1) {
        throw new Error("connection_limit must be a positive integer");
      }
      config.connectionLimit = parsed;
    }

    const poolTimeoutStr = params.get("pool_timeout");
    if (poolTimeoutStr !== null) {
      const parsed = parseInt(poolTimeoutStr, 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new Error("pool_timeout must be a non-negative integer");
      }
      config.poolTimeout = parsed;
    }

    const idleTimeoutStr = params.get("idle_in_transaction_session_timeout");
    if (idleTimeoutStr !== null) {
      const parsed = parseInt(idleTimeoutStr, 10);
      if (isNaN(parsed) || parsed < 0) {
        throw new Error("idle_in_transaction_session_timeout must be a non-negative integer");
      }
      config.idleInTransactionSessionTimeout = parsed;
    }

    const pgbouncerStr = params.get("pgbouncer");
    if (pgbouncerStr !== null) {
      config.pgbouncer = pgbouncerStr.toLowerCase() === "true" || pgbouncerStr === "1";
    }

    const schemaStr = params.get("schema");
    if (schemaStr !== null) {
      config.schema = schemaStr;
    }

    return config;
  } catch (err) {
    if (err instanceof Error && err.message.includes("must be")) {
      throw err;
    }
    throw new Error(`Invalid DATABASE_URL for pool configuration: ${urlStr}`);
  }
}

/**
 * Environment variable schema for the TrustBridge Dashboard.
 * Validates all required and optional configuration at application boot.
 */
const envSchema = z.object({
  // Optional: enables the isolated, synthetic-data /demo experience.
  NEXT_PUBLIC_DEMO_MODE: z.enum(["true", "false"]).optional().default("false"),

  // Required: authentication
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),
  NEXTAUTH_URL: z.string().url("NEXTAUTH_URL must be a valid URL"),
  NEXTAUTH_SECRET: z.string().min(1, "NEXTAUTH_SECRET is required"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1, "TOKEN_ENCRYPTION_KEY is required"),
  BADGE_SIGNING_KEY: z.string().optional(),

  // Required: GitHub org/team for maintainer access
  GITHUB_MAINTAINER_ORG: z.string().min(1, "GITHUB_MAINTAINER_ORG is required"),
  GITHUB_MAINTAINER_TEAM: z.string().optional(),

  // Required: database
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL must be a valid URL")
    .refine((url) => {
      try {
        parseDatabasePoolConfig(url);
        return true;
      } catch {
        return false;
      }
    }, "DATABASE_URL contains invalid connection pool parameters"),

  // Optional: direct database URL for migrations bypassing PgBouncer
  DIRECT_URL: z.string().url("DIRECT_URL must be a valid URL").optional(),

  // Horizon/Stellar configuration
  NEXT_PUBLIC_HORIZON_URL: z
    .string()
    .url("NEXT_PUBLIC_HORIZON_URL must be a valid URL")
    .default("https://horizon.stellar.org"),
  NEXT_PUBLIC_DEFAULT_ASSET_CODE: z.string().default("USDC"),
  NEXT_PUBLIC_DEFAULT_ASSET_ISSUER: z.string().default(
    "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ),
  NEXT_PUBLIC_MIN_XLM_BALANCE: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().nonnegative())
    .default("1.5"),
  NEXT_PUBLIC_BASE_RESERVE_XLM: z
    .string()
    .transform((v) => parseFloat(v))
    .pipe(z.number().positive())
    .optional()
    .default("0.5"),

  // Soroban configuration (optional)
  SOROBAN_CONTRACT_ID: z.string().optional(),
  SOROBAN_RPC_URL: z
    .string()
    .url("SOROBAN_RPC_URL must be a valid URL")
    .optional(),

  // Webhook secret (optional at boot, but required for org membership sync — requests are rejected if missing)
  GITHUB_WEBHOOK_SECRET: z.string().optional(),

  // trustbridge-action webhook secret (optional, but required for action sync verification)
  TRUSTBRIDGE_ACTION_SECRET: z.string().optional(),

  // Circuit breaker configuration
  HORIZON_CB_FAILURE_THRESHOLD: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("5"),
  HORIZON_CB_RECOVERY_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("30000"),
  HORIZON_CB_SUCCESS_THRESHOLD: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("2"),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("60000"),
  RATE_LIMIT_MAX_REQUESTS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("10"),

  // CSV export staleness check
  STALE_CSV_MAX_AGE_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("86400000"), // 24 hours

  // Cron authentication & export configuration (optional)
  CRON_SECRET: z.string().optional(),
  TREASURY_EXPORT_EMAIL: z.string().email().optional(),
  CRON_EXPORT_EMAIL: z.string().email().optional(),
  CRON_EXPORT_MIN_INTERVAL_MS: z
    .string()
    .transform((v) => parseInt(v, 10))
    .pipe(z.number().int().positive())
    .optional()
    .default("60000"),
});

export type Environment = z.infer<typeof envSchema>;

/**
 * Validates environment variables at application boot.
 */
export function validateEnv(): Environment {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten();
    const fieldErrors = Object.entries(errors.fieldErrors)
      .map(([field, msgs]) => `${field}: ${msgs?.join(", ")}`)
      .join("\n");

    const message = `❌ Environment validation failed:\n${fieldErrors}`;
    console.error(message);

    throw new Error(message);
  }

  return result.data;
}

let cachedEnv: Environment | null = null;

export function getValidatedEnv(): Environment {
  if (!cachedEnv) {
    cachedEnv = validateEnv();
  }
  return cachedEnv;
}
