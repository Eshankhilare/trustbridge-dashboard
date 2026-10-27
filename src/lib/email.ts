import "server-only";

export interface EmailAttachment {
  filename: string;
  content: string;
  contentType?: string;
}
import { createHash } from "node:crypto";

import enMessages from "../../public/locales/en.json";
import esMessages from "../../public/locales/es.json";
import ptMessages from "../../public/locales/pt.json";
import { resolveLocale, type SupportedLocale } from "@/lib/i18n-config";
import { withRetry } from "@/lib/retry";
import { recordAuditLog } from "@/lib/audit";

const EMAIL_MESSAGES: Record<SupportedLocale, typeof enMessages.email> = {
  en: enMessages.email,
  es: esMessages.email,
  pt: ptMessages.email,
};

export interface LocalizedEmailTemplate {
  subject: string;
  body: string;
}

export interface InviteEmailDetails {
  inviteCode: string;
  recipientName?: string;
  expiresAt?: Date | string | null;
  locale?: string;
}

export interface BanEmailDetails {
  githubUsername: string;
  reason: string;
  locale?: string;
}

export interface EmailNotification {
  to: string;
  subject: string;
  body: string;
  recipientName?: string;
  idempotencyScope?: string;
  attachments?: EmailAttachment[];
}

export interface NotReadyNotification extends EmailNotification {
  contributorUsername: string;
  reason: "unfunded" | "no_trustline" | "low_reserve";
  lastCheckedAt?: Date;
}

export function buildInviteEmail(
  details: InviteEmailDetails
): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].invite;
  const inviteCode = details.inviteCode.trim();
  if (!inviteCode) throw new Error("Invite code is required");

  const recipientName = details.recipientName?.trim() || messages.greetingFallback;
  const expiryDate = formatEmailDate(details.expiresAt, locale);
  const registrationUrl = getRegistrationUrl();

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { recipientName })}</p>
  <p>${messages.codeLabel}: <strong><code>${escapeHtml(inviteCode)}</code></strong></p>
  <p>${expiryDate ? interpolateEmailText(messages.expires, { date: expiryDate }) : messages.noExpiry}</p>
  <p>${messages.instructions}</p>
  <p><a href="${escapeHtml(registrationUrl)}">${messages.action}</a></p>
</div>`.trim(),
  };
}

export function buildBanEmail(details: BanEmailDetails): LocalizedEmailTemplate {
  const locale = resolveLocale(
    typeof details.locale === "string" ? details.locale : undefined
  );
  const messages = EMAIL_MESSAGES[locale].ban;
  const githubUsername = details.githubUsername.trim();
  const reason = details.reason.trim();
  if (!githubUsername) throw new Error("GitHub username is required");
  if (!reason) throw new Error("Ban reason is required");

  return {
    subject: messages.subject,
    body: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#212529;">
  <h2>${messages.heading}</h2>
  <p>${interpolateEmailText(messages.greeting, { githubUsername })}</p>
  <p><strong>${messages.reasonLabel}:</strong> ${escapeHtml(reason)}</p>
  <p>${messages.nextSteps}</p>
</div>`.trim(),
  };
}

function formatEmailDate(
  value: Date | string | null | undefined,
  locale: SupportedLocale
): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(date);
}

function getRegistrationUrl(): string {
  try {
    const url = new URL(
      "/register",
      process.env.NEXTAUTH_URL?.trim() || "https://trustbridge.dev"
    );
    if (url.protocol === "https:" || url.hostname === "localhost") {
      return url.toString();
    }
  } catch {
    // Fall back to the canonical registration page for malformed configuration.
  }
  return "https://trustbridge.dev/register";
}

function interpolateEmailText(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    escapeHtml(values[key] ?? "")
  );
}

/**
 * Maximum number of send attempts (including the first).
 * Configurable via EMAIL_MAX_ATTEMPTS env var, capped at 5.
 */
function getMaxAttempts(): number {
  const raw = Number.parseInt(process.env.EMAIL_MAX_ATTEMPTS ?? "3", 10);
  return Math.min(Math.max(1, Number.isFinite(raw) ? raw : 3), 5);
}

/**
 * Deterministic idempotency key derived from recipient + subject.
 * Prevents duplicate emails when Resend retries a 429 and the first
 * request actually succeeded (network timeout, etc.).
 */
function buildIdempotencyKey(
  to: string,
  subject: string,
  scope?: string
): string {
  const payload = scope ? `${to}:${subject}:${scope}` : `${to}:${subject}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

export async function sendEmailNotification(
  notification: EmailNotification
): Promise<boolean> {
  const emailService = process.env.EMAIL_SERVICE || "console";

  if (emailService === "console") {
    return sendViaConsole(notification);
  }

  if (emailService === "resend") {
    return sendViaResend(notification);
  }

  console.warn(`Unknown EMAIL_SERVICE: ${emailService}, falling back to console`);
  return sendViaConsole(notification);
}

async function sendViaConsole(
  notification: EmailNotification
): Promise<boolean> {
  console.log(`[EMAIL] To: ${notification.to}`);
  console.log(`[EMAIL] Subject: ${notification.subject}`);
  console.log(`[EMAIL] Body:\n${notification.body}`);
  if (notification.attachments && notification.attachments.length > 0) {
    console.log(
      `[EMAIL] Attachments: ${notification.attachments
        .map((a) => `${a.filename} (${a.content.length} bytes)`)
        .join(", ")}`
    );
  }
  return true;
}

/**
 * Retryable HTTP error from Resend (429 = rate limit, 5xx = transient).
 * 4xx except 429 are permanent failures — don't retry.
 */
function isRetryableResendError(error: unknown): boolean {
  if (error instanceof ResendApiError) {
    if (error.status === 429) return true;
    if (error.status >= 500) return true;
    return false;
  }
  // Network errors, timeouts, etc. — retry
  return true;
}

class ResendApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
    this.name = "ResendApiError";
  }
}

async function sendViaResend(
  notification: EmailNotification
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set, email not sent");
    return false;
  }

  const maxAttempts = getMaxAttempts();
  const idempotencyKey = buildIdempotencyKey(
    notification.to,
    notification.subject,
    notification.idempotencyScope
  );

  try {
    const payload: Record<string, unknown> = {
      from: process.env.EMAIL_FROM || "noreply@trustbridge.dev",
      to: notification.to,
      subject: notification.subject,
      html: notification.body,
    };

    if (notification.attachments && notification.attachments.length > 0) {
      payload.attachments = notification.attachments.map((att) => ({
        filename: att.filename,
        content: att.content,
      }));
    }

    await withRetry(
      async () => {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new ResendApiError(
            `Resend API error: ${response.status} ${response.statusText} ${body}`.trim(),
            response.status
          );
        }

        return true;
      },
      {
        attempts: maxAttempts,
        delayMs: 500,
        backoffFactor: 2,
        shouldRetry: isRetryableResendError,
        sleep: (ms) =>
          new Promise((resolve) =>
            setTimeout(resolve, ms + Math.random() * 250)
          ),
      }
    );

    return true;
  } catch (error) {
    console.error("Failed to send email via Resend after retries:", error);

    // Surface failure in audit log (DLQ pattern)
    await recordAuditLog({
      action: "email.send_failed",
      targetLabel: notification.to,
      metadata: {
        subject: notification.subject,
        error: error instanceof Error ? error.message : String(error),
        attempts: maxAttempts,
        idempotencyKey,
      },
    }).catch(() => {});

    return false;
  }
}

export function buildNotReadyEmailBody(
  contributorUsername: string,
  reason: "unfunded" | "no_trustline" | "low_reserve"
): string {
  const reasonText = {
    unfunded: "Account not funded with XLM",
    no_trustline: "USDC trustline not established",
    low_reserve: "Insufficient spendable XLM balance",
  }[reason];

  return `
<h2>Registration Not Ready: ${contributorUsername}</h2>
<p>The registration for <strong>${contributorUsername}</strong> is currently not ready for Wave payout:</p>
<p><strong>Reason:</strong> ${reasonText}</p>
<p>Please contact the contributor to resolve this issue before the next Wave payout.</p>
<p>Visit the <a href="${process.env.NEXTAUTH_URL || "https://trustbridge.dev"}/dashboard">maintainer dashboard</a> for more details.</p>
  `.trim();
}

export interface TreasuryExportEmailDetails {
  totalContributors: number;
  readyCount: number;
  lowReserveCount?: number;
  notReadyCount?: number;
  staleCount?: number;
  filename: string;
  exportedAt?: string;
}

export function buildTreasuryExportEmailBody(
  details: TreasuryExportEmailDetails
): string {
  const exportedAt = details.exportedAt ?? new Date().toISOString();
  const readyPercent =
    details.totalContributors > 0
      ? Math.round((details.readyCount / details.totalContributors) * 100)
      : 0;

  const staleWarning =
    details.staleCount && details.staleCount > 0
      ? `<div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:12px;border-radius:4px;margin-bottom:16px;">
<strong>⚠️ Stale Data Warning:</strong> ${details.staleCount} of ${details.totalContributors} contributor records have not been verified within the configured freshness window.
</div>`
      : "";

  return `
<h2>Nightly Treasury Contributor Export</h2>
<p>The automated nightly contributor export has completed successfully for Wave payout preparation.</p>
${staleWarning}
<table style="border-collapse:collapse;width:100%;max-width:500px;margin-bottom:16px;">
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Exported At:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${exportedAt}</td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Total Contributors:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.totalContributors}</td></tr>
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Ready for Payout:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.readyCount} (${readyPercent}%)</td></tr>
  ${
    details.lowReserveCount !== undefined
      ? `<tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Low Reserve:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.lowReserveCount}</td></tr>`
      : ""
  }
  ${
    details.notReadyCount !== undefined
      ? `<tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Not Ready:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;">${details.notReadyCount}</td></tr>`
      : ""
  }
  <tr><td style="padding:8px;border-bottom:1px solid #ddd;"><strong>Attached File:</strong></td><td style="padding:8px;border-bottom:1px solid #ddd;"><code>${details.filename}</code></td></tr>
</table>
<p>The full CSV dataset with current Horizon verification details is attached to this email.</p>
<p>Visit the <a href="${process.env.NEXTAUTH_URL || "https://trustbridge.dev"}/dashboard">maintainer dashboard</a> to review individual contributor records.</p>
  `.trim();
}

// ---------------------------------------------------------------------------
// Digest email template
// ---------------------------------------------------------------------------

export interface DigestEmailDetails {
  /** "daily" or "weekly" — controls subject framing in the body. */
  cadence: "daily" | "weekly";
  totalContributors: number;
  readyCount: number;
  lowReserveCount: number;
  notReadyCount: number;
  /**
   * Per-contributor list. Only present when `DIGEST_INCLUDE_FULL_LIST=true`.
   * When absent the email contains counts + dashboard link only (privacy default).
   */
  notReadyList?: Array<{
    githubUsername: string;
    reason: "unfunded" | "no_trustline" | "low_reserve";
  }>;
  generatedAt?: string;
}

const REASON_LABELS: Record<string, string> = {
  unfunded: "Account not funded with XLM",
  no_trustline: "USDC trustline not established",
  low_reserve: "Insufficient spendable XLM balance",
};

/**
 * Build the HTML body for the scheduled not-ready contributor digest.
 *
 * Privacy default: sends aggregate counts + a direct link to the dashboard.
 * No contributor usernames, Stellar addresses, or emails appear unless
 * `notReadyList` is explicitly provided (opt-in via DIGEST_INCLUDE_FULL_LIST).
 */
export function buildDigestEmailBody(details: DigestEmailDetails): string {
  const generatedAt = details.generatedAt ?? new Date().toISOString();
  const dashboardUrl =
    (process.env.NEXTAUTH_URL?.trim() || "https://trustbridge.dev") +
    "/dashboard";

  const cadenceLabel = details.cadence === "weekly" ? "Weekly" : "Daily";
  const notReadyTotal = details.notReadyCount + details.lowReserveCount;

  const readyPercent =
    details.totalContributors > 0
      ? Math.round((details.readyCount / details.totalContributors) * 100)
      : 0;

  // ── Alert banner — shown only when there are blocked contributors ─────────
  const alertBanner =
    notReadyTotal > 0
      ? `<div style="background:#fff3cd;border:1px solid #ffeeba;color:#856404;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
  <strong>⚠️ Action required:</strong> ${notReadyTotal} contributor${notReadyTotal === 1 ? "" : "s"} cannot receive a Wave payout yet.
  Visit the <a href="${dashboardUrl}" style="color:#856404;">maintainer dashboard</a> to review and resolve.
</div>`
      : `<div style="background:#d4edda;border:1px solid #c3e6cb;color:#155724;padding:12px 16px;border-radius:4px;margin-bottom:20px;">
  <strong>✅ All contributors are ready</strong> for Wave payout as of this digest.
</div>`;

  // ── Summary stats table ───────────────────────────────────────────────────
  const statsTable = `
<table style="border-collapse:collapse;width:100%;max-width:500px;margin-bottom:20px;">
  <thead>
    <tr style="background:#f8f9fa;">
      <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:left;">Status</th>
      <th style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">Count</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">Total contributors</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.totalContributors}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;border:1px solid #dee2e6;">✅ Ready for payout</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.readyCount} (${readyPercent}%)</td>
    </tr>
    <tr>
      <td style="padding:8px 12px;border:1px solid #dee2e6;">⚠️ Low reserve</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.lowReserveCount}</td>
    </tr>
    <tr style="background:#f8f9fa;">
      <td style="padding:8px 12px;border:1px solid #dee2e6;">❌ Not ready</td>
      <td style="padding:8px 12px;border:1px solid #dee2e6;text-align:right;">${details.notReadyCount}</td>
    </tr>
  </tbody>
</table>`.trim();

  // ── Opt-in full list section ──────────────────────────────────────────────
  let fullListSection = "";
  if (details.notReadyList && details.notReadyList.length > 0) {
    const rows = details.notReadyList
      .map(
        (entry, i) =>
          `<tr${i % 2 === 0 ? "" : ' style="background:#f8f9fa;"'}>
        <td style="padding:6px 12px;border:1px solid #dee2e6;font-family:monospace;">@${escapeHtml(entry.githubUsername)}</td>
        <td style="padding:6px 12px;border:1px solid #dee2e6;">${escapeHtml(REASON_LABELS[entry.reason] ?? entry.reason)}</td>
      </tr>`
      )
      .join("\n");

    fullListSection = `
<h3 style="font-size:14px;margin-top:24px;margin-bottom:8px;">Not-ready contributors (${details.notReadyList.length})</h3>
<table style="border-collapse:collapse;width:100%;max-width:600px;font-size:13px;">
  <thead>
    <tr style="background:#f8f9fa;">
      <th style="padding:6px 12px;border:1px solid #dee2e6;text-align:left;">Contributor</th>
      <th style="padding:6px 12px;border:1px solid #dee2e6;text-align:left;">Reason</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<p style="font-size:12px;color:#6c757d;margin-top:8px;">
  This list is included because <code>DIGEST_INCLUDE_FULL_LIST=true</code> is set.
  Remove that setting to send counts-only digests.
</p>`.trim();
  }

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;color:#212529;">
  <h2 style="margin-bottom:4px;">${cadenceLabel} Contributor Readiness Digest</h2>
  <p style="color:#6c757d;font-size:13px;margin-top:0;margin-bottom:20px;">
    Generated ${generatedAt} · TrustBridge Dashboard
  </p>

  ${alertBanner}
  ${statsTable}
  ${fullListSection}

  <p style="margin-top:24px;">
    <a href="${dashboardUrl}"
       style="display:inline-block;background:#0d6efd;color:#fff;padding:10px 20px;border-radius:4px;text-decoration:none;font-size:14px;font-weight:500;">
      Open maintainer dashboard →
    </a>
  </p>

  <hr style="border:none;border-top:1px solid #dee2e6;margin:24px 0;" />
  <p style="font-size:12px;color:#6c757d;">
    You are receiving this digest because your address is configured as
    <code>DIGEST_EMAIL</code> (or <code>TREASURY_EXPORT_EMAIL</code>) for this
    TrustBridge deployment. To stop receiving these emails, remove your address
    from the environment variable.
  </p>
</div>
  `.trim();
}

/** Escape HTML special characters to prevent XSS in the template. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
