#!/usr/bin/env node

/**
 * TrustBridge Dashboard CLI (trustbridge-dash)
 * CLI for treasury export and contributor readiness recheck.
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchTreasuryExport,
  loadStoredConfig,
  saveStoredConfig,
  triggerRecheck,
  validateUrl,
} from "./client.mjs";

function printHelp() {
  console.log(`
Usage: trustbridge-dash <command> [options]

Commands:
  login                 Store API key and API URL for future commands
  export                Export treasury readiness report (CSV / JSON)
  recheck               Trigger readiness recheck for contributor(s)
  help                  Show this help text

Global Options:
  --url <url>           Base URL of TrustBridge Dashboard (must use https://)
                        Default: TRUSTBRIDGE_API_URL or config value
  --api-key <key>       API Key or Bearer Token for authentication
                        Default: TRUSTBRIDGE_API_KEY or config value
  -h, --help            Show help documentation

Export Options:
  --format <csv|json>   Export format (default: csv)
  --out <file>          Path to save exported file (default: stdout or filename from server)

Recheck Options:
  --all                 Trigger batch recheck for all contributors (maintainer only)
  --username <user>     Specific contributor username to recheck

Security Note:
  All requests must use HTTPS. Secrets and API keys are masked in logs.
`);
}

function maskApiKey(key) {
  if (!key) return "[none]";
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function parseArgs(rawArgs) {
  const args = [...rawArgs];
  const command = args[0] && !args[0].startsWith("-") ? args.shift() : "";
  const options = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--url" && args[i + 1]) {
      options.url = args[++i];
    } else if (arg === "--api-key" && args[i + 1]) {
      options.apiKey = args[++i];
    } else if (arg === "--format" && args[i + 1]) {
      options.format = args[++i];
    } else if (arg === "--out" && args[i + 1]) {
      options.out = args[++i];
    } else if (arg === "--username" && args[i + 1]) {
      options.username = args[++i];
    }
  }

  return { command, options };
}

export async function runCli(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);

  if (options.help || !command || command === "help") {
    printHelp();
    return 0;
  }

  const storedConfig = loadStoredConfig();
  const url = options.url || process.env.TRUSTBRIDGE_API_URL || storedConfig.apiUrl;
  const apiKey = options.apiKey || process.env.TRUSTBRIDGE_API_KEY || storedConfig.apiKey;

  if (command === "login") {
    if (!url) {
      console.error("Error: --url is required when logging in. Must use HTTPS.");
      return 1;
    }
    try {
      validateUrl(url);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      return 1;
    }

    if (!apiKey) {
      console.error("Error: --api-key is required when logging in.");
      return 1;
    }

    saveStoredConfig({ apiUrl: url, apiKey });
    console.log(`Successfully stored configuration for ${url} (API Key: ${maskApiKey(apiKey)})`);
    return 0;
  }

  if (!url) {
    console.error("Error: API URL is required. Provide --url, set TRUSTBRIDGE_API_URL, or run 'trustbridge-dash login'.");
    return 1;
  }

  try {
    validateUrl(url);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    return 1;
  }

  if (command === "export") {
    const format = options.format || "csv";
    if (format !== "csv" && format !== "json") {
      console.error(`Error: Invalid export format "${format}". Supported formats: csv, json`);
      return 1;
    }

    try {
      console.error(`Fetching treasury export from ${url} (Auth: ${maskApiKey(apiKey)})...`);
      const { data, filename } = await fetchTreasuryExport({
        url,
        apiKey,
        format,
      });

      if (options.out) {
        const outPath = resolve(process.cwd(), options.out);
        writeFileSync(outPath, data, "utf-8");
        console.error(`Treasury export written to ${outPath}`);
      } else if (filename && process.stdout.isTTY) {
        const outPath = resolve(process.cwd(), filename);
        writeFileSync(outPath, data, "utf-8");
        console.error(`Treasury export written to ${outPath}`);
      } else {
        process.stdout.write(data);
      }
      return 0;
    } catch (err) {
      console.error(`Error exporting treasury: ${err.message}`);
      return 1;
    }
  }

  if (command === "recheck") {
    try {
      console.error(`Triggering recheck on ${url} (Auth: ${maskApiKey(apiKey)})...`);
      const res = await triggerRecheck({
        url,
        apiKey,
        all: Boolean(options.all),
        githubUsername: options.username,
      });
      console.log(JSON.stringify(res.result, null, 2));
      return 0;
    } catch (err) {
      console.error(`Error triggering recheck: ${err.message}`);
      return 1;
    }
  }

  console.error(`Unknown command: "${command}". Run "trustbridge-dash --help" for usage.`);
  return 1;
}

if (process.argv[1] && (process.argv[1].endsWith("trustbridge-dash") || process.argv[1].endsWith("index.mjs"))) {
  runCli().then((code) => {
    if (code !== 0) process.exit(code);
  });
}
