import "server-only";

/**
 * OpenAPI 3.0.0 schema object
 */
export interface OpenAPISpec {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
    contact?: {
      name: string;
      url: string;
    };
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  paths: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
}

/**
 * Generates the OpenAPI 3.0.0 specification for TrustBridge Dashboard
 */
export function generateOpenAPISpec(
  apiUrl: string = "http://localhost:3000"
): OpenAPISpec {
  return {
    openapi: "3.0.0",
    info: {
      title: "TrustBridge Dashboard API",
      version: "1.0.0",
      description:
        "API for managing Stellar address registrations and payout readiness validation",
      contact: {
        name: "TrustBridge",
        url: "https://github.com/Stellar-TrustBridge/trustbridge-dashboard",
      },
    },
    servers: [
      {
        url: apiUrl,
        description: "TrustBridge Dashboard API",
      },
    ],
    paths: {
      "/api/register": {
        get: {
          operationId: "getRegistration",
          summary: "Get contributor registration",
          tags: ["Registration"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Registration found",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Registration",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated",
            },
            "404": {
              description: "Registration not found",
            },
          },
        },
        post: {
          operationId: "updateRegistration",
          summary: "Create or update contributor registration",
          tags: ["Registration"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/RegistrationInput",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Registration updated",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Registration",
                  },
                },
              },
            },
            "400": {
              description: "Invalid request",
            },
            "401": {
              description: "Not authenticated",
            },
          },
        },
      },
      "/api/check": {
        post: {
          operationId: "checkAddress",
          summary: "Validate Stellar address via Horizon",
          tags: ["Validation"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/CheckRequest",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Address check result",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/CheckResult",
                  },
                },
              },
            },
            "400": {
              description: "Invalid address",
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/contributors": {
        get: {
          operationId: "listContributors",
          summary: "List all contributors with readiness status",
          tags: ["Contributors"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description: "Pagination cursor (base64-encoded ID)",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              description: "Number of results per page",
            },
          ],
          responses: {
            "200": {
              description: "List of contributors",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ContributorList",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated or not a maintainer",
            },
          },
        },
        post: {
          operationId: "recheckAllContributors",
          summary: "Batch re-check all contributors via Horizon",
          tags: ["Contributors"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Batch re-check initiated",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      checked: { type: "integer" },
                    },
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated or not a maintainer",
            },
          },
        },
      },
      "/api/stats": {
        get: {
          operationId: "getStats",
          summary: "Get aggregate readiness statistics",
          tags: ["Stats"],
          responses: {
            "200": {
              description: "Dashboard statistics",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/DashboardStats",
                  },
                },
              },
            },
          },
        },
      },
      "/api/metrics": {
        get: {
          operationId: "getAdminMetrics",
          summary: "Get admin operational metrics",
          description: "Returns contributor readiness, Horizon latency, address-change anomaly, audit activity, circuit-breaker, rate-limit, and operational configuration metrics. Requires operator access.",
          tags: ["Metrics"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Admin operational metrics snapshot",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/AdminMetrics" },
                },
              },
            },
            "403": { description: "Forbidden. Operator access required." },
          },
        },
      },
      "/api/metrics/prometheus": {
        get: {
          operationId: "getPrometheusMetrics",
          summary: "Scrape Prometheus metrics",
          description: "Returns metrics in Prometheus text exposition format. Access requires an operator session or a bearer token listed in PROMETHEUS_SCRAPE_TOKENS.",
          tags: ["Metrics"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Prometheus text exposition",
              content: {
                "text/plain": {
                  schema: { type: "string" },
                },
              },
            },
            "403": { description: "Forbidden. Operator access or an allowlisted scrape token is required." },
          },
        },
      },
      "/api/disputes": {
        get: {
          operationId: "listDisputes",
          summary: "List disputes visible to the authenticated user",
          description: "Contributors see disputes for their own registrations; maintainers can see all disputes.",
          tags: ["Disputes"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "registrationId",
              in: "query",
              schema: { type: "string" },
              description: "Filter disputes by registration ID",
            },
            {
              name: "status",
              in: "query",
              schema: { type: "string", enum: ["OPEN", "VALIDATED", "REJECTED"] },
              description: "Filter disputes by status",
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description: "Pagination cursor",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
              description: "Number of disputes per page",
            },
          ],
          responses: {
            "200": {
              description: "Paginated disputes",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DisputeList" },
                },
              },
            },
            "401": { description: "Not authenticated" },
          },
        },
        post: {
          operationId: "createDispute",
          summary: "Open a dispute for a registration",
          description: "Users may dispute their own registration; maintainers may dispute any registration. The endpoint requires a same-origin request.",
          tags: ["Disputes"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CreateDisputeRequest" },
              },
            },
          },
          responses: {
            "201": {
              description: "Dispute created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DisputeResponse" },
                },
              },
            },
            "400": { description: "Invalid dispute details" },
            "401": { description: "Not authenticated" },
            "403": { description: "Registration not found or not accessible to this user" },
            "409": { description: "A dispute already exists for this registration" },
          },
        },
        patch: {
          operationId: "resolveDispute",
          summary: "Validate or reject a dispute",
          description: "Maintainer-only operation. The endpoint requires a same-origin request.",
          tags: ["Disputes"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UpdateDisputeRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Dispute status updated",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DisputeResponse" },
                },
              },
            },
            "400": { description: "Invalid dispute update" },
            "401": { description: "Not authenticated" },
            "403": { description: "Maintainer access required" },
            "404": { description: "Dispute not found" },
          },
        },
      },
      "/api/contributors/queue/health": {
        get: {
          operationId: "getQueueHealth",
          summary: "Get background queue worker health",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Worker health and serverless runtime notice",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/QueueHealth" },
                },
              },
            },
            "403": { description: "Forbidden. Maintainer access required." },
          },
        },
      },
      "/api/contributors/queue/status": {
        get: {
          operationId: "getQueueStatus",
          summary: "Get background queue job counts and processing time",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "Current queue metrics",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/QueueStatus" },
                },
              },
            },
            "403": { description: "Forbidden. Maintainer access required." },
          },
        },
      },
      "/api/contributors/queue/progress": {
        get: {
          operationId: "streamQueueJobProgress",
          summary: "Stream progress for a background job",
          description: "Returns Server-Sent Events with status, processing, completed, failed, or error events. The job must be visible to the authenticated maintainer.",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "jobId",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "ID of the job to monitor",
            },
          ],
          responses: {
            "200": {
              description: "Server-Sent Events stream of job progress",
              content: {
                "text/event-stream": {
                  schema: { type: "string" },
                },
              },
            },
            "400": { description: "Job ID is required" },
            "403": { description: "Forbidden. Maintainer access required." },
          },
        },
      },
      "/api/contributors/queue/jobs/{jobId}": {
        get: {
          operationId: "getQueueJob",
          summary: "Get a background job by ID",
          description: "A maintainer can view their own jobs and ownerless jobs.",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "jobId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Background job ID",
            },
          ],
          responses: {
            "200": {
              description: "Background job",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/QueueJobResponse" },
                },
              },
            },
            "400": { description: "Job ID is required" },
            "403": { description: "Forbidden. Maintainer access required." },
            "404": { description: "Job not found or not visible to this user" },
          },
        },
      },
      "/api/contributors/queue/dlq": {
        get: {
          operationId: "listDeadLetterJobs",
          summary: "List failed background jobs",
          description: "Lists failed jobs owned by the caller or with no owner. Error text is redacted and size-capped.",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
              description: "Maximum number of failed jobs to return",
            },
          ],
          responses: {
            "200": {
              description: "Dead-letter jobs",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DeadLetterQueueResponse" },
                },
              },
            },
            "403": { description: "Forbidden. Maintainer access required." },
          },
        },
      },
      "/api/contributors/queue/dlq/{jobId}/retry": {
        post: {
          operationId: "retryDeadLetterJob",
          summary: "Retry a failed background job",
          description: "Maintainer-only, same-origin request. Retry is also gated by the dlq_retry feature flag and audited.",
          tags: ["Queue"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "jobId",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "ID of the failed job to retry",
            },
          ],
          responses: {
            "200": {
              description: "Job returned to the pending queue",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RetryQueueJobResponse" },
                },
              },
            },
            "400": { description: "Job ID is required" },
            "403": { description: "Forbidden, same-origin check failed, or retry feature is disabled" },
            "404": { description: "Job not found, not visible, or not retryable" },
          },
        },
      },
      "/api/maintainer/ban": {
        post: {
          operationId: "manageContributorBan",
          summary: "Ban or unban a contributor",
          description: "Maintainer-only, same-origin request. Bans require a mandatory reason; unbans do not.",
          tags: ["Maintainers"],
          security: [{ bearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BanRequest" },
              },
            },
          },
          responses: {
            "200": {
              description: "Contributor banned or unbanned",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BanResponse" },
                },
              },
            },
            "400": { description: "Missing githubUsername, missing ban reason, or invalid action" },
            "403": { description: "Forbidden: maintainer access required" },
            "500": { description: "Failed to execute ban action" },
          },
        },
      },
      "/api/registrations/{id}/restore": {
        post: {
          operationId: "restoreRegistration",
          summary: "Restore a soft-deleted registration",
          description: "Maintainer-only, same-origin request. Restores a soft-deleted registration by id.",
          tags: ["Registrations"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "ID of the soft-deleted registration to restore",
            },
          ],
          responses: {
            "200": {
              description: "Registration restored",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RestoreRegistrationResponse" },
                },
              },
            },
            "403": { description: "Forbidden: maintainer access required" },
            "404": { description: "Registration not found" },
            "409": { description: "Registration is not deleted" },
          },
        },
      },
      "/api/actions/lookup": {
        get: {
          operationId: "lookupAction",
          summary: "Public action lookup for a Stellar address",
          tags: ["Actions"],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "asset_code",
              in: "query",
              schema: { type: "string", default: "USDC" },
              description: "Asset code for trustline check",
            },
            {
              name: "asset_issuer",
              in: "query",
              schema: { type: "string" },
              description: "Asset issuer public key",
            },
          ],
          responses: {
            "200": {
              description: "Action lookup result with next-action hint",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ActionLookupResult",
                  },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/badge": {
        get: {
          operationId: "getBadge",
          summary: "Get readiness badge for a Stellar address",
          tags: ["Badge"],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "format",
              in: "query",
              schema: {
                type: "string",
                enum: ["json", "svg"],
                default: "json",
              },
              description: "Response format for the badge",
            },
          ],
          responses: {
            "200": {
              description: "Badge payload (JSON) or rendered SVG badge",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/Badge",
                  },
                },
                "image/svg+xml": {
                  schema: { type: "string" },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "404": {
              description: "No badge available for address",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "429": {
              description: "Rate limit exceeded",
            },
          },
        },
      },
      "/api/address-history": {
        get: {
          operationId: "getAddressHistory",
          summary: "Get readiness history for a Stellar address",
          tags: ["Address History"],
          security: [{ bearerAuth: [] }],
          parameters: [
            {
              name: "address",
              in: "query",
              required: true,
              schema: { type: "string" },
              description: "Stellar public key (G-address)",
            },
            {
              name: "cursor",
              in: "query",
              schema: { type: "string" },
              description: "Pagination cursor (base64-encoded ID)",
            },
            {
              name: "limit",
              in: "query",
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
              description: "Number of history entries per page",
            },
          ],
          responses: {
            "200": {
              description: "Address history entries",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/AddressHistoryList",
                  },
                },
              },
            },
            "400": {
              description: "Invalid or missing address parameter",
              content: {
                "application/json": {
                  schema: {
                    $ref: "#/components/schemas/ErrorResponse",
                  },
                },
              },
            },
            "401": {
              description: "Not authenticated",
            },
          },
        },
      },
      "/api/webhooks/trustbridge-action": {
        post: {
          operationId: "trustbridgeActionWebhook",
          summary: "Receive trustbridge-action validation webhook",
          tags: ["Webhooks"],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  $ref: "#/components/schemas/WebhookPayload",
                },
              },
            },
          },
          responses: {
            "202": {
              description: "Webhook accepted for processing",
            },
            "400": {
              description: "Invalid webhook payload",
            },
            "401": {
              description: "Invalid webhook signature",
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {

        BanRequest: {
          type: "object",
          required: ["githubUsername"],
          properties: {
            action: {
              type: "string",
              enum: ["ban", "unban"],
              default: "ban",
              description: "Action to perform: ban or unban",
            },
            githubUsername: {
              type: "string",
              description: "GitHub handle of the contributor",
            },
            reason: {
              type: "string",
              description: "Mandatory reason for ban; optional for unban",
            },
          },
        },
        BanResponse: {
          type: "object",
          required: ["success", "message", "details"],
          properties: {
            success: { type: "boolean" },
            message: { type: "string" },
            details: {
              type: "object",
              required: ["githubUsername", "banned"],
              properties: {
                githubUsername: { type: "string" },
                banned: { type: "boolean" },
                bannedAt: { type: "string", format: "date-time", nullable: true },
                bannedReason: { type: "string", nullable: true },
                bannedBy: { type: "string", nullable: true },
              },
            },
          },
        },
        RestoreRegistrationResponse: {
          type: "object",
          required: ["success", "registration"],
          properties: {
            success: { type: "boolean" },
            registration: {
              $ref: "#/components/schemas/Registration",
            },
          },
        },
        Registration: {
          type: "object",
          properties: {
            id: { type: "string" },
            githubUsername: { type: "string" },
            stellarAddress: { type: "string" },
            trustlineReady: { type: "boolean" },
            trustlineAuthorized: { type: "boolean" },
            funded: { type: "boolean" },
            xlmBalance: { type: "string" },
            spendableXlmBalance: { type: "string" },
            lastCheckedAt: { type: "string", format: "date-time" },
            readiness: {
              type: "string",
              enum: ["ready", "low_reserve", "not_ready"],
            },
          },
        },
        RegistrationInput: {
          type: "object",
          required: ["stellarAddress"],
          properties: {
            stellarAddress: { type: "string" },
          },
        },
        CheckRequest: {
          type: "object",
          required: ["address"],
          properties: {
            address: { type: "string" },
            asset_code: { type: "string" },
            asset_issuer: { type: "string" },
          },
        },
        CheckResult: {
          type: "object",
          properties: {
            funded: { type: "boolean" },
            trustline: { type: "boolean" },
            trustline_authorized: { type: "boolean" },
            xlm_balance: { type: "string" },
            spendable_xlm_balance: { type: "string" },
            errors: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        ContributorList: {
          type: "object",
          properties: {
            data: {
              type: "array",
              items: { $ref: "#/components/schemas/Registration" },
            },
            nextCursor: { type: "string", nullable: true },
            hasMore: { type: "boolean" },
          },
        },
        DashboardStats: {
          type: "object",
          properties: {
            total: { type: "integer" },
            ready: { type: "integer" },
            lowReserve: { type: "integer" },
          },
        },
        AdminMetrics: {
          type: "object",
          properties: {
            contributors: {
              type: "object",
              properties: {
                total: { type: "integer" },
                ready: { type: "integer" },
                readyPercent: { type: "number" },
                byStatus: {
                  type: "object",
                  properties: {
                    ready: { type: "integer" },
                    low_reserve: { type: "integer" },
                    not_ready: { type: "integer" },
                  },
                },
              },
            },
            horizonLatency: { type: "object", additionalProperties: true },
            addressAnomaly: { type: "object", additionalProperties: true },
            audit: {
              type: "object",
              properties: {
                recentEntries: { type: "integer" },
                byAction: { type: "object", additionalProperties: { type: "integer" } },
                latestAt: { type: "string", format: "date-time", nullable: true },
              },
            },
            circuitBreaker: { type: "object", additionalProperties: true },
            rateLimit: { type: "object", additionalProperties: true },
            config: { type: "object", additionalProperties: true },
          },
        },
        CreateDisputeRequest: {
          type: "object",
          required: ["registrationId", "reason"],
          properties: {
            registrationId: { type: "string", minLength: 1 },
            reason: { type: "string", minLength: 1, maxLength: 2000 },
            proofCid: { type: "string", maxLength: 200 },
          },
        },
        UpdateDisputeRequest: {
          type: "object",
          required: ["disputeId", "status"],
          properties: {
            disputeId: { type: "string", minLength: 1 },
            status: { type: "string", enum: ["VALIDATED", "REJECTED"] },
          },
        },
        Dispute: {
          type: "object",
          properties: {
            id: { type: "string" },
            registrationId: { type: "string" },
            reason: { type: "string" },
            proofCid: { type: "string", nullable: true },
            status: { type: "string", enum: ["OPEN", "VALIDATED", "REJECTED"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
            resolvedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
        DisputeResponse: {
          type: "object",
          required: ["dispute"],
          properties: {
            dispute: { $ref: "#/components/schemas/Dispute" },
          },
        },
        DisputeList: {
          type: "object",
          required: ["disputes", "hasMore"],
          properties: {
            disputes: {
              type: "array",
              items: { $ref: "#/components/schemas/Dispute" },
            },
            hasMore: { type: "boolean" },
            nextCursor: { type: "string" },
          },
        },
        QueueHealth: {
          type: "object",
          properties: {
            depth: { type: "integer" },
            failedCount: { type: "integer" },
            oldestPendingJobCreatedAt: { type: "string", format: "date-time", nullable: true },
            isServerlessInMemoryWarning: { type: "boolean" },
            serverlessNotice: { type: "string" },
          },
          additionalProperties: true,
        },
        QueueMetrics: {
          type: "object",
          properties: {
            totalJobs: { type: "integer" },
            pendingCount: { type: "integer" },
            processingCount: { type: "integer" },
            completedCount: { type: "integer" },
            failedCount: { type: "integer" },
            averageProcessingTimeMs: { type: "number" },
          },
        },
        QueueStatus: {
          type: "object",
          required: ["queue"],
          properties: {
            queue: { $ref: "#/components/schemas/QueueMetrics" },
          },
        },
        QueueJob: {
          type: "object",
          properties: {
            id: { type: "string" },
            type: { type: "string", enum: ["recheck.batch", "recheck.single"] },
            data: { type: "object", additionalProperties: true },
            status: { type: "string", enum: ["pending", "processing", "completed", "failed"] },
            createdAt: { type: "string", format: "date-time" },
            startedAt: { type: "string", format: "date-time", nullable: true },
            completedAt: { type: "string", format: "date-time", nullable: true },
            error: { type: "string", nullable: true },
            result: { type: "object", additionalProperties: true, nullable: true },
            ownerId: { type: "string", nullable: true },
          },
        },
        QueueJobResponse: {
          type: "object",
          required: ["job"],
          properties: {
            job: { $ref: "#/components/schemas/QueueJob" },
          },
        },
        DeadLetterQueueResponse: {
          type: "object",
          required: ["jobs", "count"],
          properties: {
            jobs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string", enum: ["recheck.batch", "recheck.single"] },
                  status: { type: "string", enum: ["failed"] },
                  error: { type: "string", nullable: true },
                  attempts: { type: "integer" },
                  createdAt: { type: "string", format: "date-time" },
                  startedAt: { type: "string", format: "date-time", nullable: true },
                  completedAt: { type: "string", format: "date-time", nullable: true },
                },
              },
            },
            count: { type: "integer" },
          },
        },
        RetryQueueJobResponse: {
          type: "object",
          required: ["job"],
          properties: {
            job: {
              type: "object",
              required: ["id", "type", "status"],
              properties: {
                id: { type: "string" },
                type: { type: "string", enum: ["recheck.batch", "recheck.single"] },
                status: { type: "string", enum: ["pending"] },
              },
            },
          },
        },
        ActionLookupResult: {
          type: "object",
          properties: {
            address: { type: "string" },
            funded: { type: "boolean" },
            trustline: { type: "boolean" },
            trustline_authorized: { type: "boolean" },
            xlm_balance: { type: "string" },
            spendable_xlm_balance: { type: "string" },
            readiness: {
              type: "string",
              enum: ["ready", "low_reserve", "not_ready"],
            },
            nextAction: {
              type: "string",
              enum: ["fund_account", "add_trustline", "increase_reserve", "none"],
              description: "Recommended next action for the contributor",
            },
          },
        },
        WebhookPayload: {
          type: "object",
          required: [
            "schema_version",
            "event",
            "timestamp",
            "repository",
            "issue_number",
            "stellar_address",
            "result",
          ],
          properties: {
            schema_version: { type: "string", example: "1" },
            event: { type: "string", example: "validation_complete" },
            timestamp: { type: "string", format: "date-time" },
            repository: { type: "string", example: "owner/repo" },
            issue_number: { type: "integer", nullable: true },
            stellar_address: { type: "string", example: "GBX7...4Y5Z" },
            result: {
              type: "object",
              required: [
                "valid",
                "account_funded",
                "trustline_exists",
                "xlm_balance",
                "checks",
              ],
              properties: {
                valid: { type: "boolean" },
                account_funded: { type: "boolean" },
                trustline_exists: { type: "boolean" },
                xlm_balance: { type: "string" },
                checks: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["label", "passed"],
                    properties: {
                      label: { type: "string" },
                      passed: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },

        ErrorResponse: {
          type: "object",
          required: ["error"],
          properties: {
            error: { type: "string" },
            message: { type: "string" },
          },
        },
        Badge: {
          type: "object",
          required: ["address", "status"],
          properties: {
            address: { type: "string" },
            status: {
              type: "string",
              enum: ["ready", "pending", "blocked", "unknown"],
            },
            label: { type: "string" },
            message: { type: "string" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        AddressHistoryEntry: {
          type: "object",
          required: ["id", "address", "status", "createdAt"],
          properties: {
            id: { type: "string" },
            address: { type: "string" },
            status: {
              type: "string",
              enum: ["ready", "pending", "blocked", "unknown"],
            },
            reason: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        AddressHistoryList: {
          type: "object",
          required: ["entries"],
          properties: {
            entries: {
              type: "array",
              items: { $ref: "#/components/schemas/AddressHistoryEntry" },
            },
            nextCursor: { type: "string", nullable: true },
          },
        },
      },
    },
  };
}

/**
 * Validates the generated OpenAPI spec.
 *
 * Restored: the implementation was dropped by a bad merge even though
 * `src/app/api/openapi.json/route.ts` and `src/lib/openapi-spec.test.ts`
 * both depend on it.
 */
export function validateOpenAPISpec(spec: OpenAPISpec): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check required top-level fields
  if (!spec.openapi) errors.push("Missing openapi version");
  if (!spec.info) errors.push("Missing info object");
  if (!spec.paths) errors.push("Missing paths object");

  // Check info object
  if (spec.info) {
    if (!spec.info.title) errors.push("Missing info.title");
    if (!spec.info.version) errors.push("Missing info.version");
  }

  // Check servers
  if (!spec.servers || spec.servers.length === 0) {
    errors.push("No servers defined");
  }

  // Check paths
  if (spec.paths && Object.keys(spec.paths).length === 0) {
    errors.push("No API paths defined");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
