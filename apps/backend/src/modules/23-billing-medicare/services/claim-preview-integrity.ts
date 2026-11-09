import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

export const CLAIM_PREVIEW_TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_VERSION = 1 as const;

export function notApplicableClaimRouteFingerprint(organizationId: string, providerEntityId: string): string {
  return createHash("sha256").update(`m23-route:not-applicable:v1:${organizationId}:${providerEntityId}`).digest("hex");
}

export interface ClaimPreviewScope {
  readonly organizationId: string;
  readonly claimId: string;
  readonly providerEntityId: string;
  readonly actorUserId: string;
  readonly claimVersion: number;
  readonly sourceFingerprint: string;
  readonly routeFingerprint: string;
  readonly accountReference: string;
  readonly usage: "test" | "production";
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly version: typeof TOKEN_VERSION;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("preview fingerprint contains a non-finite number");
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  throw new Error("preview fingerprint contains an unsupported value");
}

function tokenKey(key: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(key, "utf8"), Buffer.from("chartwarden-m23-preview-v1"), Buffer.from("confirmation-token-aes-256-gcm"), 32));
}

/** HMAC the final mapped business input before envelope allocation. Sensitive values never leave this function. */
export function fingerprintClaim837iBusinessInput(
  input: Readonly<Record<string, unknown>>,
  key: string,
  binding: Readonly<Record<string, unknown>>,
): string {
  if (key.length < 32) throw new Error("claim preview integrity key is unavailable");
  const { envelope: _envelope, ...business } = input;
  const claim = business.claim;
  const claimWithoutControl = claim && typeof claim === "object"
    ? Object.fromEntries(Object.entries(claim as Record<string, unknown>).filter(([name]) => name !== "controlNumber"))
    : claim;
  const payload = canonical({ schema: "m23-837i-business-v1", binding, business: { ...business, claim: claimWithoutControl } });
  return createHmac("sha256", key).update("chartwarden:m23:claim-preview:fingerprint:v1\0").update(payload).digest("hex");
}

export function issueClaimPreviewToken(
  input: Omit<ClaimPreviewScope, "version">,
  key: string,
): string {
  if (key.length < 32) throw new Error("claim preview integrity key is unavailable");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(key), nonce);
  cipher.setAAD(Buffer.from("chartwarden:m23:claim-preview:token:v1"));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ ...input, version: TOKEN_VERSION } satisfies ClaimPreviewScope), "utf8"),
    cipher.final(),
  ]);
  return `v1.${nonce.toString("base64url")}.${encrypted.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}`;
}

export function verifyClaimPreviewToken(
  token: string,
  key: string,
  expected: Pick<ClaimPreviewScope, "organizationId" | "claimId" | "providerEntityId" | "actorUserId">,
  now = Date.now(),
): ClaimPreviewScope | null {
  if (key.length < 32 || token.length > 4096) return null;
  const [version, nonceText, encryptedText, tagText, extra] = token.split(".");
  if (version !== "v1" || !nonceText || !encryptedText || !tagText || extra !== undefined) return null;
  try {
    const nonce = Buffer.from(nonceText, "base64url");
    const encrypted = Buffer.from(encryptedText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(key), nonce);
    decipher.setAAD(Buffer.from("chartwarden:m23:claim-preview:token:v1"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const value = JSON.parse(plaintext) as ClaimPreviewScope;
    if (value.version !== TOKEN_VERSION || value.issuedAt > now || value.expiresAt <= now || value.expiresAt - value.issuedAt > CLAIM_PREVIEW_TOKEN_TTL_MS) return null;
    if (value.organizationId !== expected.organizationId || value.claimId !== expected.claimId ||
      value.providerEntityId !== expected.providerEntityId || value.actorUserId !== expected.actorUserId) return null;
    if (!/^[0-9a-f]{64}$/.test(value.sourceFingerprint) || !/^[0-9a-f]{64}$/.test(value.routeFingerprint) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(value.accountReference) || !Number.isInteger(value.claimVersion)) return null;
    return value;
  } catch { return null; }
}

/** Decide the worker fail-closed case. Claim.MD requires a snapshot even for pre-upgrade queued work. */
export function reviewedClaimSourceIsStale(
  reviewed: string | null,
  current: string | null,
  requireReviewedIdentity: boolean,
): boolean {
  if (reviewed === null) return requireReviewedIdentity;
  return current === null || current !== reviewed;
}
