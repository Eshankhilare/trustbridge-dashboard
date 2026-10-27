import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getConfigFilePath() {
  const configDir = process.env.TRUSTBRIDGE_CONFIG_DIR || join(homedir(), ".trustbridge");
  return join(configDir, "config.json");
}

export function loadStoredConfig() {
  const filePath = getConfigFilePath();
  if (!existsSync(filePath)) {
    return {};
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveStoredConfig(config) {
  const filePath = getConfigFilePath();
  const dir = join(filePath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const current = loadStoredConfig();
  const merged = { ...current, ...config };
  writeFileSync(filePath, JSON.stringify(merged, null, 2), { mode: 0o600 });
}

export function validateUrl(rawUrl, allowHttpForTesting = false) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: "${rawUrl}". Must be a valid HTTPS URL.`);
  }

  if (parsed.protocol === "http:" && !allowHttpForTesting) {
    throw new Error(
      `Insecure HTTP protocol is not permitted for TrustBridge CLI: "${rawUrl}". API endpoints must use HTTPS.`
    );
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Unsupported protocol: "${parsed.protocol}". Expected https://`);
  }

  return parsed;
}

export async function fetchTreasuryExport(options, fetchImpl = fetch) {
  const parsedUrl = validateUrl(options.url);
  const targetUrl = new URL("/api/treasury/export", parsedUrl);

  const authKey = options.apiKey || options.token;
  if (!authKey) {
    throw new Error(
      "Authentication required. Provide an API key via --api-key, TRUSTBRIDGE_API_KEY environment variable, or run 'trustbridge-dash login'."
    );
  }

  const headers = {
    Accept: options.format === "csv" ? "text/csv, application/json" : "application/json",
    Authorization: `Bearer ${authKey}`,
    "x-api-key": authKey,
  };

  const response = await fetchImpl(targetUrl.toString(), {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Treasury export request failed with status ${response.status}: ${errorBody || response.statusText}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const disposition = response.headers.get("content-disposition") || "";
  let filename;
  const match = disposition.match(/filename="?([^";]+)"?/i);
  if (match) {
    filename = match[1];
  }

  const data = await response.text();
  return { data, contentType, filename };
}

export async function triggerRecheck(options, fetchImpl = fetch) {
  const parsedUrl = validateUrl(options.url);
  const authKey = options.apiKey || options.token;
  if (!authKey) {
    throw new Error(
      "Authentication required. Provide an API key via --api-key, TRUSTBRIDGE_API_KEY environment variable, or run 'trustbridge-dash login'."
    );
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${authKey}`,
    "x-api-key": authKey,
  };

  const endpoint = options.all ? "/api/contributors" : "/api/register/recheck";
  const targetUrl = new URL(endpoint, parsedUrl);

  const response = await fetchImpl(targetUrl.toString(), {
    method: "POST",
    headers,
    body: JSON.stringify(options.githubUsername ? { githubUsername: options.githubUsername } : {}),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Recheck request failed with status ${response.status}: ${errorBody || response.statusText}`
    );
  }

  const result = await response.json();
  return { success: true, result };
}
