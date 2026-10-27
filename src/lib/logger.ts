import "server-only";

/**
 * Structured logger for server-side use.
 *
 * Design constraints:
 * - **Server-only** — `import "server-only"` prevents accidental bundle
 *   inclusion on the client. Use `createRequestLogger` for per-request
 *   context; use the module-level `logger` singleton for library code that
 *   has no request context (e.g. soroban-register, background-queue workers).
 * - **JSON log shape** — every emit is a single `JSON.stringify` call so that
 *   log collectors (Datadog, Papertrail, etc.) can parse structured fields.
 * - **Tree-shake friendly** — the module-level `logger` is a plain `const`
 *   that Next.js can DCE from server bundles when unused. No global side
 *   effects on import.
 * - **Context isolation** — each `StructuredLogger` instance owns its own
 *   `context` object; concurrent requests using `createRequestLogger` never
 *   share mutable state.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  message: string;
  context: string;
  timestamp: string;
  /** Structured key/value metadata attached by the caller. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// serializeError
// ---------------------------------------------------------------------------

/**
 * Safely serialize any thrown value to a plain object so it can be embedded
 * in a JSON log entry without losing the message or stack.
 *
 * Large `cause` chains are truncated to a single level to bound log size.
 */
export function serializeError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { raw: String(error) };
  }

  const serialized: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };

  // Include cause, but only one level deep to avoid unbounded recursion.
  if ("cause" in error && error.cause !== undefined) {
    const cause = error.cause;
    serialized.cause =
      cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : String(cause);
  }

  return serialized;
}

// ---------------------------------------------------------------------------
// StructuredLogger
// ---------------------------------------------------------------------------

/**
 * Emit a single structured JSON log line to stdout/stderr.
 *
 * Usage:
 * ```ts
 * import { logger } from "@/lib/logger";
 * logger.info("soroban_mirror_attempted", { stellarAddress, contractId });
 * logger.error("soroban_mirror_failed", { stellarAddress, error: serializeError(err) });
 * ```
 */
export class StructuredLogger {
  /**
   * @param context - A short identifier for the subsystem, e.g. "app",
   *   "soroban-register", "queue-worker". Included in every log entry so
   *   filters can narrow to a specific subsystem.
   * @param extra - Static key/value pairs merged into every log entry emitted
   *   by this instance (e.g. `{ requestId }` for per-request loggers).
   */
  constructor(
    private readonly context: string,
    private readonly extra: LogContext = {}
  ) {}

  debug(message: string, meta?: LogContext): void {
    if (process.env.DEBUG === "true") {
      this.emit("debug", message, meta);
    }
  }

  info(message: string, meta?: LogContext): void {
    this.emit("info", message, meta);
  }

  warn(message: string, meta?: LogContext): void {
    this.emit("warn", message, meta);
  }

  error(message: string, meta?: LogContext): void {
    this.emit("error", message, meta);
  }

  /**
   * Return a child logger that inherits this instance's context string and
   * extra fields, merged with the additional `childExtra` fields. The child
   * does **not** share mutable state with the parent.
   */
  child(childExtra: LogContext): StructuredLogger {
    return new StructuredLogger(this.context, {
      ...this.extra,
      ...childExtra,
    });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private emit(level: LogLevel, message: string, meta?: LogContext): void {
    const entry: LogEntry = {
      level,
      message,
      context: this.context,
      timestamp: new Date().toISOString(),
      ...this.extra,
      ...meta,
    };

    const line = JSON.stringify(entry);

    // Route errors/warnings to stderr so process monitors can capture them
    // separately from informational output.
    if (level === "error" || level === "warn") {
      process.stderr.write(line + "\n");
    } else {
      process.stdout.write(line + "\n");
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Application-wide logger singleton. Import this wherever structured logging
 * is needed in library code that has no per-request context.
 *
 * For HTTP routes, prefer `createRequestLogger(requestId)` so that all log
 * lines for a single request share a `requestId` field and can be correlated
 * in log collectors.
 *
 * ```ts
 * import { logger } from "@/lib/logger";
 * logger.info("startup", { env: process.env.NODE_ENV });
 * ```
 */
export const logger = new StructuredLogger("app");

// ---------------------------------------------------------------------------
// createRequestLogger
// ---------------------------------------------------------------------------

/**
 * Create a per-request child logger that includes `requestId` in every log
 * entry. Use this inside Next.js route handlers and server actions where a
 * request identifier is available.
 *
 * ```ts
 * const reqLogger = createRequestLogger(crypto.randomUUID());
 * reqLogger.info("register_start", { userId, stellarAddress });
 * ```
 */
export function createRequestLogger(requestId: string): StructuredLogger {
  return new StructuredLogger("request", { requestId });
}
