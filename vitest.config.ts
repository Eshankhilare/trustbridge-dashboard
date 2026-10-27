import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // tsconfig uses "jsx": "preserve" for Next.js; Vitest needs the automatic
    // runtime transform so `.tsx` component tests get `jsx-runtime` imports.
    jsx: "automatic",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" throws unless bundled with the "react-server" export
      // condition (which Next.js sets). Point it at its no-op twin so
      // server-only libs can be unit tested directly under Vitest/Node.
      "server-only": path.resolve(__dirname, "./node_modules/server-only/empty.js"),
      // stellar-sdk's `exports.browser` condition resolves to a browser
      // bundle that Vite cannot resolve in a Node test environment. Alias
      // directly to the Node-compatible CJS entry point so Vitest can import
      // it without the browser bundle path resolution error.
      "stellar-sdk": path.resolve(
        __dirname,
        "./node_modules/stellar-sdk/lib/index.js"
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    environmentMatchGlobs: [
      ["src/**/*.test.tsx", "jsdom"],
      ["tests/**/*.test.tsx", "jsdom"],
    ],
    setupFiles: ["./tests/setup.ts"],
    pool: "threads",
    poolOptions: {
      threads: {
        maxThreads: 4,
        minThreads: 1,
      },
    },
  },
});
