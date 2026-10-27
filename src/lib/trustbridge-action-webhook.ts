import crypto from "crypto";

/**
 * Verifies the trustbridge-action webhook signature to ensure the request is authentic.
 * trustbridge-action sends the signature in the X-TrustBridge-Signature header in `sha256=<hex>` format.
 *
 * Lives here (not in the route module) because Next.js route modules may
 * only export handlers — see src/app/api/webhooks/trustbridge-action/route.ts.
 */
export function verifySignature(payload: Buffer, signature: string | undefined): boolean {
  const secret = process.env.TRUSTBRIDGE_ACTION_SECRET?.trim();
  if (!secret) {
    console.warn("TRUSTBRIDGE_ACTION_SECRET not configured — webhook signature verification failed");
    return false;
  }

  if (!signature) {
    console.warn("Missing X-TrustBridge-Signature header");
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const digest = `sha256=${hmac.digest("hex")}`;

  const digestBuf = Buffer.from(digest);
  const sigBuf = Buffer.from(signature);
  if (digestBuf.length !== sigBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(digestBuf, sigBuf);
}
