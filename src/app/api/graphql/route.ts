import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLError,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  coerceInputValue,
  graphql,
  parse,
  validate,
  valueFromAST,
  NoSchemaIntrospectionCustomRule,
  type DefinitionNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";
import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  buildRateLimitHeaders,
  checkRateLimit,
  extractClientIp,
} from "@/lib/rate-limit";
import { getDashboardStats, getContributorsPaginated } from "@/lib/registrations";
import type { ContributorRow, DashboardStats } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_QUERY_BYTES = 16_384;
const MAX_QUERY_DEPTH = 5;
const MAX_QUERY_FIELDS = 100;
const MAX_QUERY_COST = 2_500;
const MAX_CONTRIBUTORS = 100;
const DEFAULT_CONTRIBUTORS = 25;
const MAX_REQUESTS_PER_MINUTE = 120;

const VERIFICATION_STATUSES = ["verified", "unverified", "banned"] as const;
type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const verificationStatusEnum = new GraphQLEnumType({
  name: "VerificationStatus",
  values: {
    VERIFIED: { value: "verified" },
    UNVERIFIED: { value: "unverified" },
    BANNED: { value: "banned" },
  },
});

const contributorType = new GraphQLObjectType<ContributorRow>({
  name: "Contributor",
  fields: {
    githubUsername: { type: new GraphQLNonNull(GraphQLString) },
    stellarAddress: { type: new GraphQLNonNull(GraphQLString) },
    trustlineReady: { type: new GraphQLNonNull(GraphQLBoolean) },
    trustlineAuthorized: { type: new GraphQLNonNull(GraphQLBoolean) },
    verified: { type: new GraphQLNonNull(GraphQLBoolean) },
    funded: { type: new GraphQLNonNull(GraphQLBoolean) },
    xlmBalance: { type: new GraphQLNonNull(GraphQLString) },
    spendableXlmBalance: { type: new GraphQLNonNull(GraphQLString) },
    usdcBalance: { type: new GraphQLNonNull(GraphQLString) },
    lastCheckedAt: { type: GraphQLString },
    horizonLatencyMs: { type: GraphQLInt },
    readiness: { type: new GraphQLNonNull(GraphQLString) },
    banned: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const contributorPageType = new GraphQLObjectType({
  name: "ContributorPage",
  fields: {
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(contributorType)),
      resolve: (page: Awaited<ReturnType<typeof getContributorsPaginated>>) =>
        page.contributors,
    },
    hasMore: {
      type: new GraphQLNonNull(GraphQLBoolean),
    },
    nextCursor: { type: GraphQLString },
  },
});

const statsType = new GraphQLObjectType<DashboardStats>({
  name: "DashboardStats",
  fields: {
    totalContributors: { type: new GraphQLNonNull(GraphQLInt) },
    readyCount: { type: new GraphQLNonNull(GraphQLInt) },
    readyPercent: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const queryType = new GraphQLObjectType({
  name: "Query",
  fields: {
    stats: {
      type: new GraphQLNonNull(statsType),
      resolve: () => getDashboardStats(),
    },
    contributors: {
      type: contributorPageType,
      args: {
        first: { type: GraphQLInt, defaultValue: DEFAULT_CONTRIBUTORS },
        after: { type: GraphQLString },
        verificationStatus: { type: verificationStatusEnum },
      },
      resolve: async (
        _source,
        args: { first?: number; after?: string; verificationStatus?: VerificationStatus },
        context: { isMaintainer: boolean }
      ) => {
        if (!context.isMaintainer) {
          throw new GraphQLError("Forbidden", {
            extensions: { code: "FORBIDDEN" },
          });
        }
        return getContributorsPaginated(args.after, args.first, args.verificationStatus);
      },
    },
  },
});

const schema = new GraphQLSchema({ query: queryType });

/**
 * Coerce the `contributors(first:)` argument into a bounded integer page size.
 *
 * `valueFromAST` is only safe for inline literals: for a `Variable` node it
 * returns the raw JSON value out of `variables` *without* coercing it to the
 * argument's declared type, so a String, Boolean, object, or fractional value
 * slipped past the range check below and poisoned the cost multiplier with
 * `NaN` (`NaN > MAX_QUERY_COST` is false, so the cost limit was silently
 * skipped). Variables are therefore coerced with `coerceInputValue` against
 * `GraphQLInt` — exactly what execution does — and anything that still is not a
 * finite whole number inside `[1, MAX_CONTRIBUTORS]` is rejected with a
 * client-facing message before the resolver can run.
 *
 * @returns the validated limit, or an `error` describing why it is invalid.
 */
function resolveContributorsLimit(
  valueNode: ValueNode | undefined,
  variables: Record<string, unknown>
): ContributorsLimit {
  const rangeMessage = `contributors.first must be an Int between 1 and ${MAX_CONTRIBUTORS}`;

  // Missing argument, explicit null, or an omitted optional variable all fall
  // back to the schema default rather than producing a NaN multiplier.
  if (!valueNode || valueNode.kind === Kind.NULL) {
    return { ok: true, limit: DEFAULT_CONTRIBUTORS };
  }

  let raw: unknown;

  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;
    if (!(variableName in variables)) {
      // Absent optional variable: the argument default applies.
      return { ok: true, limit: DEFAULT_CONTRIBUTORS };
    }
    // `coerceInputValue` throws on the first problem unless it is handed an
    // `onError` collector, and the coercion message ("Int cannot represent
    // non-integer value: ...") is what makes the 400 actionable.
    const coercionErrors: GraphQLError[] = [];
    const coerced = coerceInputValue(
      variables[variableName],
      GraphQLInt,
      (_path, _invalidValue, error) => {
        coercionErrors.push(error);
      }
    );
    if (coercionErrors.length > 0) {
      return {
        ok: false,
        error: `${rangeMessage} — $${variableName} is invalid: ${coercionErrors[0].message}`,
      };
    }
    raw = coerced;
  } else {
    raw = valueFromAST(valueNode, GraphQLInt);
    if (raw === undefined) {
      return { ok: false, error: rangeMessage };
    }
  }

  if (raw === null) return { ok: true, limit: DEFAULT_CONTRIBUTORS };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { ok: false, error: rangeMessage };
  }

  const limit = Math.floor(raw);
  if (limit !== raw || limit < 1 || limit > MAX_CONTRIBUTORS) {
    return { ok: false, error: rangeMessage };
  }

  return { ok: true, limit };
}

type ContributorsLimit =
  | { ok: true; limit: number }
  | { ok: false; error: string };

/**
 * Validate the `contributors(verificationStatus:)` argument.
 *
 * The enum type already rejects unknown literals during validation, but a
 * variable can carry an arbitrary JSON value that only fails at execution
 * time. We coerce variables against the enum here so the cost walk can reject
 * malformed filters with a stable, actionable message before the resolver
 * runs — and so an empty string never reaches the database layer.
 */
function resolveVerificationStatus(
  valueNode: ValueNode | undefined,
  variables: Record<string, unknown>
): VerificationStatusResult {
  const message = `contributors.verificationStatus must be one of ${VERIFICATION_STATUSES.join(
    ", "
  )}`;

  if (!valueNode || valueNode.kind === Kind.NULL) {
    return { ok: true, status: undefined };
  }

  let raw: unknown;

  if (valueNode.kind === Kind.VARIABLE) {
    const variableName = valueNode.name.value;
    if (!(variableName in variables)) {
      return { ok: true, status: undefined };
    }
    const coercionErrors: GraphQLError[] = [];
    const coerced = coerceInputValue(
      variables[variableName],
      verificationStatusEnum,
      (_path, _invalidValue, error) => {
        coercionErrors.push(error);
      }
    );
    if (coercionErrors.length > 0) {
      return {
        ok: false,
        error: `${message} — $${variableName} is invalid: ${coercionErrors[0].message}`,
      };
    }
    raw = coerced;
  } else {
    raw = valueFromAST(valueNode, verificationStatusEnum);
    if (raw === undefined) {
      return { ok: false, error: message };
    }
  }

  if (raw === null || raw === undefined) {
    return { ok: true, status: undefined };
  }

  if (
    typeof raw !== "string" ||
    !(VERIFICATION_STATUSES as readonly string[]).includes(raw)
  ) {
    return { ok: false, error: message };
  }

  return { ok: true, status: raw as VerificationStatus };
}

type VerificationStatusResult =
  | { ok: true; status: VerificationStatus | undefined }
  | { ok: false; error: string };

function analyzeDocument(
  definitions: readonly DefinitionNode[],
  variables: Record<string, unknown>
): string | null {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of definitions) {
    if (definition.kind === "FragmentDefinition") {
      fragments.set(definition.name.value, definition);
    }
  }

  let fieldCount = 0;
  let cost = 0;
  let tooDeep = false;
  let pageSizeError: string | null = null;
  let verificationStatusError: string | null = null;

  function inspect(
    selectionSet: SelectionSetNode,
    depth: number,
    multiplier: number,
    fragmentPath: Set<string>
  ) {
    for (const selection of selectionSet.selections) {
      if (selection.kind === "Field") {
        const nextDepth = depth + 1;
        fieldCount += 1;
        if (nextDepth > MAX_QUERY_DEPTH) tooDeep = true;

        let childMultiplier = multiplier;
        if (selection.name.value === "contributors") {
          if (!pageSizeError) {
            const firstArgument = selection.arguments?.find(
              (argument) => argument.name.value === "first"
            );
            const resolved = resolveContributorsLimit(firstArgument?.value, variables);
            if (!resolved.ok) {
              // Stop growing the multiplier: an unusable page size must not be
              // able to widen the rest of the cost walk.
              pageSizeError = resolved.error;
              childMultiplier = multiplier;
            } else {
              // Multiplier comes from the validated, coerced limit — never a raw
              // variable value.
              childMultiplier *= resolved.limit;
            }
          }

          if (!verificationStatusError) {
            const statusArgument = selection.arguments?.find(
              (argument) => argument.name.value === "verificationStatus"
            );
            const resolvedStatus = resolveVerificationStatus(
              statusArgument?.value,
              variables
            );
            if (!resolvedStatus.ok) {
              verificationStatusError = resolvedStatus.error;
            }
          }
        }

        cost += multiplier;
        if (selection.selectionSet) {
          inspect(selection.selectionSet, nextDepth, childMultiplier, fragmentPath);
        }
      } else if (selection.kind === "InlineFragment") {
        inspect(selection.selectionSet, depth, multiplier, fragmentPath);
      } else if (!fragmentPath.has(selection.name.value)) {
        const fragment = fragments.get(selection.name.value);
        if (fragment) {
          const nextPath = new Set(fragmentPath);
          nextPath.add(selection.name.value);
          inspect(fragment.selectionSet, depth, multiplier, nextPath);
        }
      }
    }
  }

  for (const definition of definitions) {
    if (definition.kind === "OperationDefinition") {
      if (definition.operation !== "query") {
        return "Only read-only query operations are supported";
      }
      inspect(definition.selectionSet, 0, 1, new Set());
    }
  }

  if (tooDeep) return `Query depth exceeds the limit of ${MAX_QUERY_DEPTH}`;
  if (pageSizeError) return pageSizeError;
  if (fieldCount > MAX_QUERY_FIELDS) {
    return `Query field count exceeds the limit of ${MAX_QUERY_FIELDS}`;
  }
  if (cost > MAX_QUERY_COST) {
    return `Query cost exceeds the limit of ${MAX_QUERY_COST}`;
  }
  return null;
}

export async function POST(request: NextRequest) {
  const clientIp = extractClientIp(request);
  const rateLimit = checkRateLimit(clientIp, {
    maxRequests: MAX_REQUESTS_PER_MINUTE,
  });
  const rateLimitHeaders = buildRateLimitHeaders(
    rateLimit,
    MAX_REQUESTS_PER_MINUTE
  );
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { errors: [{ message: "Rate limit exceeded" }] },
      { status: 429, headers: rateLimitHeaders }
    );
  }

  const bodyText = await request.text();
  if (Buffer.byteLength(bodyText, "utf8") > MAX_QUERY_BYTES) {
    return NextResponse.json(
      { errors: [{ message: "Query body is too large" }] },
      { status: 413, headers: rateLimitHeaders }
    );
  }

  let body: { query?: unknown; variables?: unknown };
  try {
    body = JSON.parse(bodyText);
  } catch {
    return NextResponse.json(
      { errors: [{ message: "Invalid JSON body" }] },
      { status: 400, headers: rateLimitHeaders }
    );
  }

  if (typeof body.query !== "string") {
    return NextResponse.json(
      { errors: [{ message: "A query string is required" }] },
      { status: 400, headers: rateLimitHeaders }
    );
  }

  const variables =
    body.variables && typeof body.variables === "object" && !Array.isArray(body.variables)
      ? (body.variables as Record<string, unknown>)
      : {};

  let document;
  try {
    document = parse(body.query);
  } catch (error) {
    return NextResponse.json(
      { errors: [{ message: error instanceof Error ? error.message : "Invalid GraphQL query" }] },
      { status: 400, headers: rateLimitHeaders }
    );
  }

  const limitError = analyzeDocument(document.definitions, variables);
  if (limitError) {
    return NextResponse.json(
      { errors: [{ message: limitError }] },
      { status: 400, headers: rateLimitHeaders }
    );
  }

  const validationRules =
    process.env.NODE_ENV === "production"
      ? [NoSchemaIntrospectionCustomRule]
      : undefined;
  const validationErrors = validate(schema, document, validationRules);
  if (validationErrors.length > 0) {
    return NextResponse.json(
      { errors: validationErrors.map((error) => ({ message: error.message })) },
      { status: 400, headers: rateLimitHeaders }
    );
  }

  const session = await requireMaintainerSession();
  const result = await graphql({
    schema,
    source: body.query,
    variableValues: variables,
    contextValue: { isMaintainer: Boolean(session) },
  });

  return NextResponse.json(result);
}