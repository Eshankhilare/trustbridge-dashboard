/** @type {import('next').NextConfig} */

/**
 * Allowed origin for CORS on public API endpoints.
 *
 * The W3C CORS specification (and browser implementations) requires
 * Access-Control-Allow-Origin to contain either a single origin or "*".
 * Multiple origins cannot be joined with commas in this header.
 *
 * The trustbridge-action runs server-side (Node.js fetch), so CORS does not
 * apply to it. We set the primary trusted origin statically in Next config
 * headers. For dynamic multi-origin reflection across multiple domains,
 * origin validation can be handled dynamically in middleware or route handlers.
 *
 * Default trusted origin: "https://github.com"
 */
const ALLOWED_ORIGIN = "https://github.com";

/** Paths that receive CORS headers (public, no-auth endpoints). */
const CORS_PATHS = ["/api/actions/lookup", "/api/check"];

const nextConfig = {
  // Next 14: keep stellar-sdk out of the RSC bundler (native deps)
  experimental: {
    serverComponentsExternalPackages: ["stellar-sdk", "sodium-native"],
    // Enables src/instrumentation.ts (opt-in OpenTelemetry tracing, issue #203).
    instrumentationHook: true,
  },

  async headers() {
    return [
      {
        source: "/api/actions/lookup",
        headers: buildCorsHeaders(),
      },
      {
        source: "/api/check",
        headers: buildCorsHeaders(),
      },
    ];
  },

  webpack: (config, { isServer }) => {
    config.externals.push("pino-pretty", "lokijs", "encoding");

    // @sentry/nextjs is an optional peer dependency (see src/lib/sentry.ts:
    // lazy require with a no-op fallback). Mark it external on the server so
    // the build does not try to bundle a package that is intentionally absent.
    if (isServer) {
      config.externals.push(({ request }, callback) => {
        if (request === "@sentry/nextjs") {
          return callback(null, "commonjs @sentry/nextjs");
        }
        callback();
      });
    }

    // Block accidental client bundling of stellar-sdk / native crypto
    if (!isServer) {
      config.resolve.alias = {
        ...config.resolve.alias,
        "stellar-sdk": false,
        "@stellar/stellar-base": false,
        "sodium-native": false,
      };
    }

    return config;
  },
};

/**
 * Build CORS headers for a single path.
 *
 * Policy:
 * - Reflect single trusted origin ALLOWED_ORIGIN (browsers reject comma-separated origin lists).
 * - No wildcard (*) with credentials.
 * - Methods: GET, POST, OPTIONS (preflight).
 * - The Action is server-side — CORS headers are defensive, not functional.
 */
function buildCorsHeaders() {
  return [
    {
      key: "Access-Control-Allow-Origin",
      value: ALLOWED_ORIGIN,
    },
    {
      key: "Access-Control-Allow-Methods",
      value: "GET, POST, OPTIONS",
    },
    {
      key: "Access-Control-Allow-Headers",
      value: "Content-Type, Authorization, X-Cache-Bypass",
    },
    {
      key: "Access-Control-Max-Age",
      value: "86400",
    },
    {
      key: "Vary",
      value: "Origin",
    },
  ];
}

export default nextConfig;
