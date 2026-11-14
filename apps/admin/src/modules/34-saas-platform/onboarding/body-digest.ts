// apps/admin/src/modules/34-saas-platform/onboarding — what an Idempotency-Key fingerprint is made of when the body holds a write-only
// secret: a DIGEST of the body, never the body. Lives in @chartwarden/ui now (the tenant wizard shares it, and it falls back where the
// browser has no crypto.subtle); re-exported so admin imports keep their path and names.
export { bodyFingerprint, sha256HexOfText as sha256Hex } from "@chartwarden/ui";
