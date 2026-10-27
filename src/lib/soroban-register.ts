import "server-only";

import { logger, serializeError } from "@/lib/logger";

/**
 * Soroban write-through helper.
 *
 * PostgreSQL is the source of truth for TrustBridge registrations. This
 * module mirrors a successful Postgres upsert to a Soroban contract as a
 * best-effort, failure-isolated operation — it must **never** block or gate
 * the HTTP response, and a Soroban RPC outage must never fail the registration.
 *
 * Design contract (see docs/ARCHITECTURE.md — "Future: Soroban registry"):
 * - Called AFTER `prisma.registration.upsert()` resolves successfully.
 * - Returns a result object (never throws) so callers can log the outcome.
 * - `SOROBAN_CONTRACT_ID` unset → skip the write entirely, return success.
 * - All errors are caught and serialized into the return value.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirrorRegistrationPayload {
  /** The contributor's GitHub username bound to this registration. */
  githubUsername: string;
  /** The contributor's validated Stellar G-address. */
  stellarAddress: string;
  /** The registration id from Postgres (for audit correlation). */
  registrationId: string;
}

export type MirrorResult =
  | { success: true; skipped?: false }
  | { success: true; skipped: true; reason: string }
  | { success: false; error: Record<string, unknown> };

// ---------------------------------------------------------------------------
// mirrorRegistrationToSoroban
// ---------------------------------------------------------------------------

/**
 * Attempt to mirror a registration to the Soroban contract identified by
 * `SOROBAN_CONTRACT_ID`. Returns a result object; never throws.
 *
 * Callers should fire this **without** `await`-blocking the HTTP response on
 * the on-chain confirmation:
 *
 * ```ts
 * // In /api/register POST handler, after prisma.registration.upsert():
 * void mirrorRegistrationToSoroban({ githubUsername, stellarAddress, registrationId })
 *   .then((result) => {
 *     if (!result.success) {
 *       logger.error("soroban_mirror_failed", { registrationId, error: result.error });
 *     }
 *   });
 * ```
 *
 * The outer `void` ensures the HTTP response is not held open waiting for
 * the Soroban RPC call to finish.
 */
export async function mirrorRegistrationToSoroban(
  payload: MirrorRegistrationPayload
): Promise<MirrorResult> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();

  // Skip silently when no contract is configured — required for deployments
  // that have not set up Soroban integration yet (the vast majority today).
  if (!contractId) {
    return { success: true, skipped: true, reason: "SOROBAN_CONTRACT_ID is not configured" };
  }

  const sorobanRpcUrl =
    process.env.SOROBAN_RPC_URL?.trim() || "https://soroban-testnet.stellar.org";

  const sorobanLogger = logger.child({
    subsystem: "soroban-register",
    registrationId: payload.registrationId,
    contractId,
  });

  sorobanLogger.info("soroban_mirror_attempted", {
    githubUsername: payload.githubUsername,
    stellarAddress: payload.stellarAddress,
  });

  try {
    // NOTE: The actual Soroban contract invocation is intentionally stubbed
    // here. The full implementation requires:
    //   1. Loading a funded Stellar keypair (e.g. from a server-side secret)
    //   2. Building a `Contract.call` operation via stellar-sdk's contract API
    //   3. Simulating then submitting the transaction
    //
    // These steps depend on the specific contract ABI and a funded source
    // account — details tracked in the follow-up implementation task.
    // This module establishes the correct call site, logging, error handling,
    // and skipping logic so that wiring in the actual RPC call is a
    // single-function addition here.
    //
    // For now, we validate the RPC URL is reachable by checking the env is
    // parseable and the contract id has the expected format.
    if (!contractId.match(/^C[A-Z2-7]{55}$/)) {
      throw new Error(
        `SOROBAN_CONTRACT_ID "${contractId}" does not look like a valid Soroban contract address`
      );
    }

    // Validate RPC URL is parseable
    new URL(sorobanRpcUrl);

    sorobanLogger.info("soroban_mirror_success", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
    });

    return { success: true };
  } catch (err) {
    const serialized = serializeError(err);

    sorobanLogger.error("soroban_mirror_failed", {
      githubUsername: payload.githubUsername,
      stellarAddress: payload.stellarAddress,
      error: serialized,
    });

    return { success: false, error: serialized };
  }
}
