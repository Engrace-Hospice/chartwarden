// @wardenx/auth · identity — the published `AuditorSessionMinter` seam (M2-T07; M2 spec §4.7 D4).
//
// Resolved-as-D4 split: Module 3 owns the `auditor_engagement` entity + the `/auditors/invite`
// endpoint (it owns the scope + window); Module 2 owns session mechanics and exposes this
// boot-validated minter that M3 calls. Registering it at boot means an engagement that cannot
// mint a session fails at startup, not at the auditor's first click. The contract type lives in
// @wardenx/types (leaf); the IMPLEMENTATION here is injected at boot and validated by validateSeams().
//
// SLICE NOTE: the actual magic-link mint (Valkey one-time token + TTL, the `auditor`
// session-class row) is an injected `AuditorMagicLinkIssuer` port — the slice has no live
// Valkey. Production injects the issuer that mints the one-time token bound to the engagement
// window and starts the `auditor`-class session on consumption.
import type { AuditorSessionMinter } from "@wardenx/types";

/** The engagement-scoped input M3 hands the minter (mirror of the §4.7 contract). */
export interface AuditorSessionMintInput {
  engagementId: string;
  organizationId: string;
  identity: { name: string; email: string };
  window: { start: Date; end: Date };
}

/** Mints the one-time auditor magic-link token (Valkey TTL + token store in production). */
export interface AuditorMagicLinkIssuer {
  issue(
    input: AuditorSessionMintInput,
  ): Promise<{ magicLinkToken: string }> | { magicLinkToken: string };
}

/** Build the `AuditorSessionMinter` seam over an `AuditorMagicLinkIssuer`. */
export function createAuditorSessionMinter(issuer: AuditorMagicLinkIssuer): AuditorSessionMinter {
  return {
    async mintAuditorSession(input) {
      // The window must be a real forward interval — an engagement that cannot bound a
      // session (start ≥ end) is a misconfiguration; refuse rather than mint an open token.
      if (input.window.start.getTime() >= input.window.end.getTime()) {
        throw new Error("auditor engagement window must have start < end");
      }
      return issuer.issue(input);
    },
  };
}

/** In-memory issuer exposing the minted tokens for assertions (slice/test default). */
export function createInMemoryAuditorMagicLinkIssuer(): {
  issuer: AuditorMagicLinkIssuer;
  minted(): { engagementId: string; magicLinkToken: string }[];
} {
  const minted: { engagementId: string; magicLinkToken: string }[] = [];
  return {
    issuer: {
      issue(input) {
        const magicLinkToken = crypto.randomUUID();
        minted.push({ engagementId: input.engagementId, magicLinkToken });
        return { magicLinkToken };
      },
    },
    minted: () => [...minted],
  };
}
