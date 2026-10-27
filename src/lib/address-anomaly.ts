import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

export interface AnomalyStatus {
  isAnomaly: boolean;
  count: number;
  threshold: number;
  windowMinutes: number;
}

export interface AddressAnomalyThresholds {
  windowMinutes: number;
  massChangeThreshold: number;
  walletReuseThreshold: number;
  multiAccountThreshold: number;
}

export interface AddressAnomalyResult {
  isAnomaly: boolean;
  windowMinutes: number;
  thresholds: AddressAnomalyThresholds;
  signals: {
    massAddressChanges: AnomalyStatus;
    walletReuse: AnomalyStatus;
    multiAccount: AnomalyStatus;
  };
}

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_MASS_CHANGE_THRESHOLD = 5;
const DEFAULT_WALLET_REUSE_THRESHOLD = 3;
const DEFAULT_MULTI_ACCOUNT_THRESHOLD = 3;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Resolves the anomaly detection thresholds from env, falling back to
 * safe defaults when values are missing or malformed.
 */
export function resolveAnomalyThresholds(
  overrides?: Partial<AddressAnomalyThresholds>
): AddressAnomalyThresholds {
  return {
    windowMinutes:
      overrides?.windowMinutes ??
      parsePositiveInt(
        process.env.MASS_ADDRESS_CHANGE_WINDOW_MINUTES,
        DEFAULT_WINDOW_MINUTES
      ),
    massChangeThreshold:
      overrides?.massChangeThreshold ??
      parsePositiveInt(
        process.env.MASS_ADDRESS_CHANGE_THRESHOLD,
        DEFAULT_MASS_CHANGE_THRESHOLD
      ),
    walletReuseThreshold:
      overrides?.walletReuseThreshold ??
      parsePositiveInt(
        process.env.WALLET_REUSE_THRESHOLD,
        DEFAULT_WALLET_REUSE_THRESHOLD
      ),
    multiAccountThreshold:
      overrides?.multiAccountThreshold ??
      parsePositiveInt(
        process.env.MULTI_ACCOUNT_THRESHOLD,
        DEFAULT_MULTI_ACCOUNT_THRESHOLD
      ),
  };
}

/**
 * Evaluates whether a sudden mass address rotation anomaly has occurred
 * in the configured sliding time window.
 */
export async function checkAddressChangeAnomaly(
  windowMinutesOverride?: number,
  thresholdOverride?: number
): Promise<AnomalyStatus> {
  const defaults = resolveAnomalyThresholds();
  const windowMinutes = windowMinutesOverride ?? defaults.windowMinutes;
  const threshold = thresholdOverride ?? defaults.massChangeThreshold;

  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

  try {
    const count = await prisma.addressHistoryRecord.count({
      where: {
        changeType: "address_change",
        recordedAt: { gte: windowStart },
      },
    });

    const isAnomaly = count >= threshold;
    return {
      isAnomaly,
      count,
      threshold,
      windowMinutes,
    };
  } catch (error) {
    console.error("Failed to check address change anomaly:", error);
    return {
      isAnomaly: false,
      count: 0,
      threshold,
      windowMinutes,
    };
  }
}

/**
 * Detects sudden wallet reuse: the same wallet address appearing across
 * multiple distinct accounts within the sliding window.
 */
export async function checkWalletReuseAnomaly(
  thresholds: AddressAnomalyThresholds = resolveAnomalyThresholds()
): Promise<AnomalyStatus> {
  const windowStart = new Date(
    Date.now() - thresholds.windowMinutes * 60 * 1000
  );

  try {
    const grouped = await prisma.addressHistoryRecord.groupBy({
      by: ["newAddress"],
      where: {
        recordedAt: { gte: windowStart },
      },
      _count: { newAddress: true },
    });

    const maxReuse = grouped.reduce(
      (max, row) => Math.max(max, row._count?.newAddress ?? 0),
      0
    );

    return {
      isAnomaly: maxReuse >= thresholds.walletReuseThreshold,
      count: maxReuse,
      threshold: thresholds.walletReuseThreshold,
      windowMinutes: thresholds.windowMinutes,
    };
  } catch (error) {
    console.error("Failed to check wallet reuse anomaly:", error);
    return {
      isAnomaly: false,
      count: 0,
      threshold: thresholds.walletReuseThreshold,
      windowMinutes: thresholds.windowMinutes,
    };
  }
}

/**
 * Detects multi-account patterns: a single actor touching more distinct
 * accounts than the configured threshold within the sliding window.
 */
export async function checkMultiAccountAnomaly(
  thresholds: AddressAnomalyThresholds = resolveAnomalyThresholds()
): Promise<AnomalyStatus> {
  const windowStart = new Date(
    Date.now() - thresholds.windowMinutes * 60 * 1000
  );

  try {
    const grouped = await prisma.addressHistoryRecord.groupBy({
      by: ["userId"],
      where: {
        recordedAt: { gte: windowStart },
      },
      _count: { userId: true },
    });

    const maxAccounts = grouped.reduce(
      (max, row) => Math.max(max, row._count?.userId ?? 0),
      0
    );

    return {
      isAnomaly: maxAccounts >= thresholds.multiAccountThreshold,
      count: maxAccounts,
      threshold: thresholds.multiAccountThreshold,
      windowMinutes: thresholds.windowMinutes,
    };
  } catch (error) {
    console.error("Failed to check multi-account anomaly:", error);
    return {
      isAnomaly: false,
      count: 0,
      threshold: thresholds.multiAccountThreshold,
      windowMinutes: thresholds.windowMinutes,
    };
  }
}

/**
 * Runs all address anomaly detectors and returns a combined result.
 */
export async function checkAddressAnomalies(
  overrides?: Partial<AddressAnomalyThresholds>
): Promise<AddressAnomalyResult> {
  const thresholds = resolveAnomalyThresholds(overrides);

  const [massAddressChanges, walletReuse, multiAccount] = await Promise.all([
    checkAddressChangeAnomaly(
      thresholds.windowMinutes,
      thresholds.massChangeThreshold
    ),
    checkWalletReuseAnomaly(thresholds),
    checkMultiAccountAnomaly(thresholds),
  ]);

  return {
    isAnomaly:
      massAddressChanges.isAnomaly ||
      walletReuse.isAnomaly ||
      multiAccount.isAnomaly,
    windowMinutes: thresholds.windowMinutes,
    thresholds,
    signals: { massAddressChanges, walletReuse, multiAccount },
  };
}

/**
 * Triggers anomaly evaluation when an address change occurs.
 * If any threshold is breached, an audit log event is recorded so
 * maintainers see the alert. Fail open: non-blocking, returns status.
 */
export async function evaluateAndAuditAddressChangeAnomaly(
  actorId: string,
  actorLogin: string | null
): Promise<AddressAnomalyResult> {
  const result = await checkAddressAnomalies();

  if (result.isAnomaly) {
    try {
      await recordAuditLog({
        action: "anomaly.address_anomaly_detected",
        actorId,
        actorLogin,
        metadata: {
          windowMinutes: result.windowMinutes,
          thresholds: result.thresholds,
          signals: {
            massAddressChanges: result.signals.massAddressChanges,
            walletReuse: result.signals.walletReuse,
            multiAccount: result.signals.multiAccount,
          },
          message: `Address anomaly detected (window ${result.windowMinutes}m): mass=${result.signals.massAddressChanges.count}/${result.signals.massAddressChanges.threshold}, reuse=${result.signals.walletReuse.count}/${result.signals.walletReuse.threshold}, multiAccount=${result.signals.multiAccount.count}/${result.signals.multiAccount.threshold}.`,
        },
      });
    } catch (auditErr) {
      console.error("Failed to log address anomaly audit event:", auditErr);
    }
  }

  return result;
}
