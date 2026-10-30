import type {
  ContributorRow,
  DashboardStats,
  NetworkConfig,
  ReadinessStatus,
  SorobanEventRow,
} from "@/types";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HEX_ALPHABET = "0123456789abcdef";

function deterministicId(
  prefix: string,
  seed: number,
  length: number,
  alphabet: string,
): string {
  let value = prefix;
  for (let index = 0; index < length; index += 1) {
    value += alphabet[(seed * 13 + index * 7 + index * index) % alphabet.length];
  }
  return value;
}

function demoStellarAddress(seed: number): string {
  return deterministicId("G", seed, 55, BASE32_ALPHABET);
}

function demoContractId(seed: number): string {
  return deterministicId("C", seed, 55, BASE32_ALPHABET);
}

function demoTxHash(seed: number): string {
  return deterministicId("", seed, 64, HEX_ALPHABET);
}

function isoMinutesAgo(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

interface DemoContributorSeed {
  username: string;
  readiness: ReadinessStatus;
  xlmBalance: string;
  spendableXlmBalance: string;
  usdcBalance: string;
  checkedMinutesAgo: number;
  latencyMs: number | null;
  funded?: boolean;
  banned?: boolean;
  banReason?: string;
}

const CONTRIBUTOR_SEEDS: DemoContributorSeed[] = [
  {
    username: "alice-dev",
    readiness: "ready",
    xlmBalance: "184.25",
    spendableXlmBalance: "182.75",
    usdcBalance: "1250.00",
    checkedMinutesAgo: 12,
    latencyMs: 118,
  },
  {
    username: "bob-builder",
    readiness: "ready",
    xlmBalance: "96.40",
    spendableXlmBalance: "94.90",
    usdcBalance: "780.50",
    checkedMinutesAgo: 24,
    latencyMs: 142,
  },
  {
    username: "carol-codes",
    readiness: "ready",
    xlmBalance: "48.20",
    spendableXlmBalance: "46.70",
    usdcBalance: "410.00",
    checkedMinutesAgo: 37,
    latencyMs: 96,
  },
  {
    username: "dmitri-dev",
    readiness: "low_reserve",
    xlmBalance: "2.40",
    spendableXlmBalance: "0.90",
    usdcBalance: "220.00",
    checkedMinutesAgo: 51,
    latencyMs: 134,
  },
  {
    username: "elena-engineer",
    readiness: "ready",
    xlmBalance: "75.10",
    spendableXlmBalance: "73.60",
    usdcBalance: "925.75",
    checkedMinutesAgo: 63,
    latencyMs: 109,
  },
  {
    username: "farah-frontend",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 78,
    latencyMs: null,
  },
  {
    username: "gabriel-go",
    readiness: "ready",
    xlmBalance: "210.50",
    spendableXlmBalance: "209.00",
    usdcBalance: "1680.25",
    checkedMinutesAgo: 84,
    latencyMs: 88,
  },
  {
    username: "hana-hacker",
    readiness: "low_reserve",
    xlmBalance: "1.80",
    spendableXlmBalance: "0.30",
    usdcBalance: "140.00",
    checkedMinutesAgo: 97,
    latencyMs: 151,
  },
  {
    username: "ibrahim-infra",
    readiness: "ready",
    xlmBalance: "64.20",
    spendableXlmBalance: "62.70",
    usdcBalance: "655.40",
    checkedMinutesAgo: 112,
    latencyMs: 121,
  },
  {
    username: "juniper-js",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 126,
    latencyMs: null,
  },
  {
    username: "kenji-kernel",
    readiness: "ready",
    xlmBalance: "130.00",
    spendableXlmBalance: "128.50",
    usdcBalance: "1100.00",
    checkedMinutesAgo: 143,
    latencyMs: 77,
  },
  {
    username: "lina-linux",
    readiness: "ready",
    xlmBalance: "88.80",
    spendableXlmBalance: "87.30",
    usdcBalance: "860.20",
    checkedMinutesAgo: 158,
    latencyMs: 103,
  },
  {
    username: "miguel-mobile",
    readiness: "low_reserve",
    xlmBalance: "3.10",
    spendableXlmBalance: "1.60",
    usdcBalance: "95.00",
    checkedMinutesAgo: 174,
    latencyMs: 165,
  },
  {
    username: "nina-nodes",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 191,
    latencyMs: null,
  },
  {
    username: "omar-ops",
    readiness: "ready",
    xlmBalance: "57.60",
    spendableXlmBalance: "56.10",
    usdcBalance: "520.00",
    checkedMinutesAgo: 208,
    latencyMs: 115,
  },
  {
    username: "priya-python",
    readiness: "ready",
    xlmBalance: "42.00",
    spendableXlmBalance: "40.50",
    usdcBalance: "390.75",
    checkedMinutesAgo: 226,
    latencyMs: 128,
  },
  {
    username: "quinn-quant",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 243,
    latencyMs: null,
  },
  {
    username: "ravi-rust",
    readiness: "low_reserve",
    xlmBalance: "2.00",
    spendableXlmBalance: "0.50",
    usdcBalance: "75.00",
    checkedMinutesAgo: 267,
    latencyMs: 178,
  },
  {
    username: "sofia-solidity",
    readiness: "ready",
    xlmBalance: "101.20",
    spendableXlmBalance: "99.70",
    usdcBalance: "990.00",
    checkedMinutesAgo: 289,
    latencyMs: 92,
  },
  {
    username: "tara-testing",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 312,
    latencyMs: null,
  },
  {
    username: "uma-ui",
    readiness: "ready",
    xlmBalance: "33.30",
    spendableXlmBalance: "31.80",
    usdcBalance: "310.00",
    checkedMinutesAgo: 338,
    latencyMs: 137,
  },
  {
    username: "victor-vm",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 361,
    latencyMs: null,
    banned: true,
    banReason: "Demo data: unresolved payout dispute",
  },
  {
    username: "wen-web",
    readiness: "ready",
    xlmBalance: "72.40",
    spendableXlmBalance: "70.90",
    usdcBalance: "705.50",
    checkedMinutesAgo: 389,
    latencyMs: 111,
  },
  {
    username: "yusuf-yield",
    readiness: "not_ready",
    xlmBalance: "0",
    spendableXlmBalance: "0",
    usdcBalance: "0",
    checkedMinutesAgo: 420,
    latencyMs: null,
  },
];

/**
 * Build a fresh copy of the synthetic contributor dataset.
 *
 * Timestamps are relative to `now` so the public demo always shows recent
 * activity without requiring a database or Horizon connection.
 */
export function createDemoContributors(now = Date.now()): ContributorRow[] {
  return CONTRIBUTOR_SEEDS.map((seed, index) => {
    const isReady = seed.readiness === "ready";
    const isLowReserve = seed.readiness === "low_reserve";
    const hasTrustline = isReady || isLowReserve;
    const funded = seed.funded ?? hasTrustline;

    return {
      id: `demo-contributor-${index + 1}`,
      githubUsername: seed.username,
      stellarAddress: demoStellarAddress(index + 1),
      trustlineReady: hasTrustline,
      trustlineAuthorized: hasTrustline,
      verified: hasTrustline,
      funded,
      xlmBalance: funded ? seed.xlmBalance : "0",
      spendableXlmBalance: funded ? seed.spendableXlmBalance : "0",
      usdcBalance: funded ? seed.usdcBalance : "0",
      lastCheckedAt: isoMinutesAgo(now, seed.checkedMinutesAgo),
      horizonLatencyMs: seed.latencyMs,
      readiness: seed.readiness,
      banned: seed.banned ?? false,
      banReason: seed.banReason,
    };
  });
}

/** Stable sample data for the public landing page and demo statistics. */
export const DEMO_CONTRIBUTORS: ContributorRow[] = createDemoContributors();

export const DEMO_CONTRACT_ID = demoContractId(7);

interface DemoEventSeed {
  type: SorobanEventRow["type"];
  minutesAgo: number;
  ledger: number;
  topic: string[];
  value: string;
}

const EVENT_SEEDS: DemoEventSeed[] = [
  {
    type: "contract",
    minutesAgo: 9,
    ledger: 5821043,
    topic: ["register", "alice-dev"],
    value: "demo registration mirrored",
  },
  {
    type: "contract",
    minutesAgo: 27,
    ledger: 5821018,
    topic: ["recheck", "bob-builder"],
    value: "trustline authorized",
  },
  {
    type: "system",
    minutesAgo: 44,
    ledger: 5820996,
    topic: ["contract", "initialized"],
    value: "registry initialized",
  },
  {
    type: "contract",
    minutesAgo: 68,
    ledger: 5820961,
    topic: ["register", "carol-codes"],
    value: "demo registration mirrored",
  },
  {
    type: "diagnostic",
    minutesAgo: 93,
    ledger: 5820924,
    topic: ["recheck", "dmitri-dev"],
    value: "low reserve detected",
  },
  {
    type: "contract",
    minutesAgo: 121,
    ledger: 5820887,
    topic: ["register", "elena-engineer"],
    value: "demo registration mirrored",
  },
  {
    type: "system",
    minutesAgo: 158,
    ledger: 5820839,
    topic: ["admin", "set_asset"],
    value: "USDC asset configured",
  },
  {
    type: "diagnostic",
    minutesAgo: 204,
    ledger: 5820775,
    topic: ["recheck", "farah-frontend"],
    value: "trustline missing",
  },
];

export function createDemoSorobanEvents(now = Date.now()): SorobanEventRow[] {
  return EVENT_SEEDS.map((seed, index) => ({
    id: `demo-event-${index + 1}`,
    type: seed.type,
    ledger: seed.ledger,
    ledgerClosedAt: isoMinutesAgo(now, seed.minutesAgo),
    contractId: DEMO_CONTRACT_ID,
    topic: seed.topic,
    value: seed.value,
    txHash: demoTxHash(index + 1),
  }));
}

export const DEMO_SOROBAN_EVENTS: SorobanEventRow[] =
  createDemoSorobanEvents();

export const DEMO_NETWORK_CONFIG: NetworkConfig = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  horizonNetwork: "testnet",
  sorobanUrl: "https://soroban-testnet.stellar.org",
  sorobanNetwork: "testnet",
  sorobanContractConfigured: true,
  mismatched: false,
  actionAlignment: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    assetCode: "USDC",
    assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    minXlmBalance: 1.5,
    expected: {
      horizonUrl: "https://horizon-testnet.stellar.org",
      assetCode: "USDC",
      assetIssuer:
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      minXlmBalance: 1.5,
    },
    aligned: true,
    warnings: [],
  },
  warnings: [],
};

export function getDemoDashboardStats(
  contributors: ContributorRow[] = DEMO_CONTRIBUTORS,
): DashboardStats {
  const totalContributors = contributors.length;
  const readyCount = contributors.filter(
    (contributor) => contributor.readiness === "ready",
  ).length;

  return {
    totalContributors,
    readyCount,
    readyPercent:
      totalContributors > 0
        ? Math.round((readyCount / totalContributors) * 100)
        : 0,
  };
}
