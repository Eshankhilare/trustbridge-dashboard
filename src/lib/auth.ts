import "server-only";

import type { NextAuthOptions } from "next-auth";
import GitHubProvider from "next-auth/providers/github";

import type { AppRole } from "@/types";
import { prisma } from "@/lib/prisma";
import { SESSION_MAX_AGE_SECONDS } from "@/lib/session-info";
import { decryptToken, encryptToken } from "@/lib/token-crypto";
import { recordTokenAudit } from "@/lib/token-audit";
import { recordAuditLog } from "@/lib/audit";
import { generateCsrfToken } from "@/lib/csrf";

async function isOrgMember(accessToken: string, org: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.github.com/user/orgs?per_page=100", {
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) return false;

    const orgs = (await response.json()) as { login: string }[];
    return orgs.some(
      (entry) => entry.login.toLowerCase() === org.toLowerCase()
    );
  } catch {
    return false;
  }
}

async function isTeamMember(
  accessToken: string,
  org: string,
  teamSlug: string,
  username: string
): Promise<boolean> {
  try {
    const response = await fetch(
      "https://api.github.com/orgs/" + encodeURIComponent(org) + "/teams/" + encodeURIComponent(teamSlug) + "/memberships/" + encodeURIComponent(username),
      {
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      }
    );

    if (!response.ok) return false;

    const membership = (await response.json()) as { state?: string };
    return membership.state === "active";
  } catch {
    return false;
  }
}

export function getAllowedMaintainerOrgs(): string[] {
  const envOrgs = process.env.ALLOWED_MAINTAINER_ORGS || process.env.GITHUB_MAINTAINER_ORG || "";
  return envOrgs
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/**
 * Returns every org from ALLOWED_MAINTAINER_ORGS that the user is a member of.
 * Used at sign-in to populate the token's `availableOrgs` list.
 * Never throws — API errors are treated as non-membership (fail closed).
 */
export async function resolveAvailableOrgs(
  accessToken: string
): Promise<string[]> {
  const allowedOrgs = getAllowedMaintainerOrgs();
  if (allowedOrgs.length === 0 || !accessToken) return [];

  const results = await Promise.all(
    allowedOrgs.map(async (org) => {
      const member = await isOrgMember(accessToken, org);
      return member ? org : null;
    })
  );

  return results.filter((org): org is string => org !== null);
}

export function verifyTenantAccess(targetOrgId: string, currentOrgId: string): boolean {
  if (!targetOrgId || !currentOrgId) return false;
  return targetOrgId.toLowerCase() === currentOrgId.toLowerCase();
}

/**
 * Resolve a user's RBAC role from GitHub team membership across allowed orgs.
 */
async function resolveRole(
  accessToken: string,
  username: string
): Promise<AppRole | null> {
  const allowedOrgs = getAllowedMaintainerOrgs();
  if (allowedOrgs.length === 0 || !accessToken) return null;

  let matchedOrg: string | null = null;
  for (const org of allowedOrgs) {
    const isMember = await isOrgMember(accessToken, org);
    if (isMember) {
      matchedOrg = org;
      break;
    }
  }

  if (!matchedOrg) return null;

  const adminTeam = process.env.GITHUB_ADMIN_TEAM?.trim();
  if (adminTeam) {
    const isAdmin = await isTeamMember(accessToken, matchedOrg, adminTeam, username);
    if (isAdmin) return "admin";
  }

  const operatorTeam = process.env.GITHUB_OPERATOR_TEAM?.trim();
  if (operatorTeam) {
    const isOperator = await isTeamMember(accessToken, matchedOrg, operatorTeam, username);
    if (isOperator) return "operator";
  }

  return "viewer";
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      authorization: {
        params: {
          scope: "read:user user:email read:org",
        },
      },
    }),
  ],
  session: {
    strategy: "jwt",
    // Stated explicitly rather than inherited, because the account panel
    // reports this number back to the user. `SESSION_MAX_AGE_SECONDS` in
    // `src/lib/session-info.ts` must stay in step — a test asserts it does.
    maxAge: SESSION_MAX_AGE_SECONDS,
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (account?.provider === "github" && profile) {
        // next-auth's base Profile only declares sub/name/email/image; the
        // GitHub provider also returns numeric `id` and `login`.
        const githubProfile = profile as typeof profile & {
          id?: string | number | null;
          login?: string | null;
        };
        const githubId = githubProfile.id?.toString();
        const githubUsername = githubProfile.login;

        if (githubId && githubUsername) {
          let encryptedAccessToken: string | null = null;
          if (account.access_token) {
            try {
              encryptedAccessToken = encryptToken(account.access_token);
            } catch (error) {
              console.error("Failed to encrypt GitHub access token", error);
            }
          }

          const user = await prisma.user.upsert({
            where: { githubId },
            create: {
              githubId,
              githubUsername,
              name: profile.name ?? null,
              email: profile.email ?? null,
              image: profile.image ?? null,
              accessToken: encryptedAccessToken,
            },
            update: {
              githubUsername,
              name: profile.name ?? null,
              email: profile.email ?? null,
              image: profile.image ?? null,
              accessToken: encryptedAccessToken,
            },
          });

          await recordTokenAudit(
            user.id,
            encryptedAccessToken
              ? "token_encrypted_at_signin"
              : "token_encryption_skipped",
            Boolean(encryptedAccessToken)
          );

          token.sub = user.id;
          token.githubUsername = githubUsername;

          const maintainerOrg = process.env.GITHUB_MAINTAINER_ORG?.trim();
          if (maintainerOrg && account.access_token) {
            let isMaintainer = await isOrgMember(
              account.access_token,
              maintainerOrg
            );

            const maintainerTeam = process.env.GITHUB_MAINTAINER_TEAM?.trim();
            if (isMaintainer && maintainerTeam) {
              const isOnTeam = await isTeamMember(
                account.access_token,
                maintainerOrg,
                maintainerTeam,
                githubUsername
              );

              if (!isOnTeam) {
                isMaintainer = false;
                await recordAuditLog({
                  action: "maintainer_access_denied_team",
                  actorId: user.id,
                  actorLogin: githubUsername,
                  metadata: { team: maintainerTeam },
                });
              }
            }

            token.isMaintainer = isMaintainer;

            // Resolve fine-grained RBAC role (best-effort; never blocks
            // sign-in). `account.access_token` is narrowed to string by the
            // branch condition above.
            const role = await resolveRole(
              account.access_token,
              githubUsername
            );
            token.role = role ?? undefined;

            // Audit role denial for non-org members who attempt sign-in.
            if (!role && !isMaintainer) {
              await recordAuditLog({
                action: "rbac_role_denied",
                actorId: user.id,
                actorLogin: githubUsername,
                metadata: { reason: "not_org_member" },
              });
            }

            // Multi-org: populate all orgs the maintainer belongs to so the
            // org-switcher can show them. Non-maintainers get an empty list.
            // The active org stays the configured single org so existing
            // maintainerOrgId behavior is unchanged.
            if (isMaintainer) {
              token.availableOrgs = await resolveAvailableOrgs(
                account.access_token
              );
            } else {
              token.availableOrgs = [];
            }

            // Persist the org identifier on the JWT so session refreshes do
            // not need another GitHub API call. Falls back to "default" when
            // no org env var is configured so downstream org-scoping helpers
            // always receive a non-empty string.
            token.maintainerOrgId = maintainerOrg;
          } else {
            // No org env configured — assign the safe default so that API
            // routes relying on session.user.maintainerOrgId never get
            // undefined and can always perform a deterministic org-scope check.
            // isMaintainer is intentionally left unset here.
            token.maintainerOrgId = "default";
          }
        }
      }

      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.githubUsername = token.githubUsername;
        session.user.isMaintainer = token.isMaintainer ?? false;
        // Propagate the org identifier to session.user so that every server
        // component and API route can access it from a typed field rather than
        // reaching into the raw JWT or using an ad-hoc default string.
        session.user.maintainerOrgId = token.maintainerOrgId ?? "default";
        session.user.role = token.role;
        session.user.availableOrgs = token.availableOrgs ?? [];
        if (session.user.id) {
          session.user.csrfToken = generateCsrfToken(session.user.id);
        }
      }
      return session;
    },
  },
  pages: {
    signIn: "/",
  },
  secret: process.env.NEXTAUTH_SECRET,
};

export async function getSessionUserId(
  session:
    | { user?: { id?: string | null } | null }
    | null
    | undefined
): Promise<string | null> {
  return session?.user?.id ?? null;
}

export async function getDecryptedGithubAccessToken(
  userId: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { accessToken: true },
  });

  if (!user?.accessToken) return null;

  try {
    const plaintext = decryptToken(user.accessToken);
    await recordTokenAudit(userId, "token_decrypted", true);
    return plaintext;
  } catch (error) {
    await recordTokenAudit(
      userId,
      "token_decrypt_failed",
      false,
      error instanceof Error ? error.message : "Unknown decrypt error"
    );
    return null;
  }
}