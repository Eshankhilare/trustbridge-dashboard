import { spawnSync } from "node:child_process";

const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

function run(label, command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });

  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status ?? "unknown"}.`);
    process.exit(result.status ?? 1);
  }
}

if (demoMode) {
  console.log(
    "NEXT_PUBLIC_DEMO_MODE=true: skipping Prisma migrate deploy; the public demo uses local synthetic data.",
  );
} else {
  run("Prisma migrate deploy", "npm", ["run", "db:deploy"]);
}

run("Next.js production build", "npm", ["run", "build"]);
