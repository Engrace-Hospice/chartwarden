// apps/backend/src/modules/05-patient/wristband-digest.ts -- GAP-020: the ONLY place a wristband token is hashed
// or minted. M5-private (the M13 arm never sees a token or a digest, only a verdict).
//
// digest = hex(sha256("wx.wristband.v1|" || organization_id || "|" || token)). Domain separation + the org salt
// stop two tenants' digests from ever being equal and keep the unique index meaningful; a 128-bit random token
// makes an unkeyed SHA-256 non-invertible, so no pepper / KMS key has to be managed (decision 2 of the design).
import { createHash, randomBytes } from "node:crypto";
import { WRISTBAND_TOKEN_BYTES, formatWristbandPayload } from "@chartwarden/types";

const DIGEST_DOMAIN = "wx.wristband.v1";

/** Org-salted SHA-256 of a parsed token (`WXB1.<base32>`, checksum excluded), as 64 lower-case hex chars. */
export function wristbandDigest(organizationId: string, token: string): string {
  return createHash("sha256").update(`${DIGEST_DOMAIN}|${organizationId}|${token}`).digest("hex");
}

/** A fresh printable payload from a CSPRNG (128 bits). The caller prints it once and never stores it. */
export function mintWristbandPayload(): string {
  return formatWristbandPayload(randomBytes(WRISTBAND_TOKEN_BYTES));
}
