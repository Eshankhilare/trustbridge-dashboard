import "server-only";

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export function redactParams(paramsStr: string): string {
  if (!paramsStr) return "";
  return paramsStr
    .replace(/\bG[A-Z0-9]{55}\b/g, "G***[REDACTED]")
    .replace(/"accessToken"\s*:\s*"[^"]+"/g, '"accessToken":"[REDACTED]"')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[REDACTED]"')
    .replace(/"password"\s*:\s*"[^"]+"/g, '"password":"[REDACTED]"')
    .replace(/"codeHash"\s*:\s*"[^"]+"/g, '"codeHash":"[REDACTED]"');
}

export function logSlowQuery(
  model: string,
  action: string,
  durationMs: number,
  params?: string,
  customThreshold?: number
): boolean {
  const threshold = customThreshold ?? Number(process.env.SLOW_QUERY_THRESHOLD_MS || 200);
  if (durationMs >= threshold) {
    const redacted = params ? redactParams(params) : "";
    console.warn(
      `[SLOW_QUERY] Prisma query ${model}.${action} took ${durationMs}ms (threshold: ${threshold}ms). Params: ${redacted}`
    );
    return true;
  }
  return false;
}

const basePrisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log:
      process.env.NODE_ENV === "development"
        ? ["query", "error", "warn"]
        : ["error"],
  });

basePrisma.$use(async (params, next) => {
  const start = Date.now();
  const result = await next(params);
  const duration = Date.now() - start;
  logSlowQuery(
    params.model || "Raw",
    params.action,
    duration,
    JSON.stringify(params.args || {})
  );
  return result;
});

export const prisma = basePrisma;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
