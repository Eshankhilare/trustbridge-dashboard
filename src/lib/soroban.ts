import "server-only";

import { rpc, scValToNative, xdr, Contract, TransactionBuilder, Account, nativeToScVal } from "stellar-sdk";

import type { SorobanEventRow, SorobanEventTimelineResponse } from "@/types";

const DEFAULT_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
// ~7 hours of ledgers at a 5s close time — comfortably inside RPC event
// retention windows while still giving the timeline a meaningful range.
const DEFAULT_LEDGER_WINDOW = 5_000;
const DEFAULT_EVENT_LIMIT = 50;
// Simulate reads against a throwaway source account; simulateTransaction does
// not require the source to exist or be funded.
const SIMULATE_SOURCE_ACCOUNT =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5";
const SIMULATE_FEE = "100";

import { resolveSorobanNetworkPassphrase } from "@/lib/network-config";

function getSorobanRpcUrl(): string {
  return process.env.SOROBAN_RPC_URL?.trim() || DEFAULT_SOROBAN_RPC_URL;
}

function getSorobanNetworkPassphrase(): string {
  return resolveSorobanNetworkPassphrase();
}

function safeScValToNative(value: unknown): string {
  try {
    const native = scValToNative(value as never);
    return typeof native === "string" ? native : JSON.stringify(native);
  } catch {
    return "<undecodable>";
  }
}

/**
 * Fetches recent Soroban contract events for the configured registry
 * contract. Returns an empty, error-annotated result (never throws) so the
 * dashboard panel can render a clear message on outages, rate limits, or
 * missing configuration instead of crashing the page.
 */
export async function getSorobanEventTimeline(): Promise<SorobanEventTimelineResponse> {
  const contractId = process.env.SOROBAN_CONTRACT_ID?.trim();

  if (!contractId) {
    return {
      events: [],
      latestLedger: 0,
      errors: ["SOROBAN_CONTRACT_ID is not configured"],
    };
  }

  try {
    const server = new rpc.Server(getSorobanRpcUrl());
    const latest = await server.getLatestLedger();
    const startLedger = Math.max(
      latest.sequence - DEFAULT_LEDGER_WINDOW,
      1
    );

    const response = await server.getEvents({
      startLedger,
      filters: [{ type: undefined, contractIds: [contractId] }],
      limit: DEFAULT_EVENT_LIMIT,
    });

    const events: SorobanEventRow[] = response.events.map((event) => ({
      id: event.id,
      type: event.type,
      ledger: event.ledger,
      ledgerClosedAt: event.ledgerClosedAt,
      contractId: event.contractId?.contractId?.() ?? contractId,
      topic: event.topic.map(safeScValToNative),
      value: safeScValToNative(event.value),
      txHash: event.txHash,
    }));

    return { events, latestLedger: response.latestLedger, errors: [] };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Soroban RPC error";
    return {
      events: [],
      latestLedger: 0,
      errors: [`Soroban RPC error: ${message}`],
    };
  }
}

/**
 * Reads a Soroban contract function via RPC `simulateTransaction` instead of
 * relying on direct ledger-entry reads. Simulation is the supported read path
 * for Soroban contracts: it executes the invocation against the current ledger
 * state and returns the decoded return value without submitting a transaction.
 *
 * Returns `null` when the contract id is missing, the simulation fails, or the
 * result cannot be decoded, so callers can fall back gracefully.
 */
export async function simulateContractRead<T = unknown>(
  contractId: string,
  method: string,
  args: unknown[] = []
): Promise<T | null> {
  const trimmedContractId = contractId?.trim();

  if (!trimmedContractId) {
    return null;
  }

  try {
    const server = new rpc.Server(getSorobanRpcUrl());
    const account = new Account(SIMULATE_SOURCE_ACCOUNT, "0");
    const contract = new Contract(trimmedContractId);

    const transaction = new TransactionBuilder(account, {
      fee: SIMULATE_FEE,
      networkPassphrase: getSorobanNetworkPassphrase(),
    })
      .addOperation(
        contract.call(method, ...args.map((arg) => nativeToScVal(arg as never)))
      )
      .setTimeout(0)
      .build();

    const simulation = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationError(simulation)) {
      return null;
    }

    const returnValue = simulation.result?.retval;

    if (returnValue === undefined) {
      return null;
    }

    return scValToNative(returnValue) as T;
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper that reads a contract function and normalizes the
 * decoded value to a string, matching the shape used by the event timeline.
 */
export async function simulateContractReadString(
  contractId: string,
  method: string,
  args: unknown[] = []
): Promise<string | null> {
  const value = await simulateContractRead(contractId, method, args);

  if (value === null || value === undefined) {
    return null;
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

// Re-exported so contract-sync can build XDR arguments without importing the
// SDK directly, keeping Soroban access centralized in this module.
export { xdr };
