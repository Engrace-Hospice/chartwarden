// apps/backend/src/modules/02-identity/auditor-magic-link-store.ts — GAP-011 the durable
// `AuditorMagicLinkIssuer` behind M2's boot-validated `AuditorSessionMinter` seam.
//
// The default issuer was a per-process Map: the one-time token disappeared on restart and a second instance
// could never consume it. This one persists the sha256 HASH of a 256-bit random token in `auditor_magic_link`
// (migration 0402; the `organization_invitation.token_hash` precedent) bound to the engagement and its window.
// The raw token is returned to the caller exactly once and never stored.
//
//   • issue    — INSERT under the org's RLS context; expires_at = the engagement window's end.
//   • consume  — single-use: one UPDATE ... WHERE consumed_at IS NULL AND revoked_at IS NULL AND the window is
//                open RETURNING; a replay, an expired, revoked or not-yet-open link all return null.
//   • revoke   — authz.close_engagements calls it when an engagement closes/cancels, so an unconsumed link
//                dies with its engagement.
import { createHash, randomBytes } from "node:crypto";
import type { AuditorMagicLinkIssuer } from "@wardenx/auth";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gt, isNull, lte } from "drizzle-orm";

const LINK = schema.auditorMagicLinks;
const TOKEN_BYTES = 32;
/** A consumer is not a request: the context carries no acting user (the audit trigger maps "" to NULL). */
const NO_USER = "";

export const hashAuditorToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

export const generateAuditorToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

/** The engagement context a consumed link resolves to (what the session mint stamps on `scope`). */
export interface ConsumedAuditorLink {
  readonly organizationId: string;
  readonly engagementId: string;
  readonly auditorEmail: string;
  readonly auditorName: string;
  readonly expiresAt: Date;
}

export function createDbAuditorMagicLinkIssuer(db: DbClient): AuditorMagicLinkIssuer {
  return {
    async issue(input) {
      const token = generateAuditorToken();
      await withOrgContext(db, { organizationId: input.organizationId, userId: NO_USER }, (tx) =>
        tx.insert(LINK).values({
          organizationId: input.organizationId,
          engagementId: input.engagementId,
          auditorEmail: input.identity.email,
          auditorName: input.identity.name,
          tokenHash: hashAuditorToken(token),
          windowStart: input.window.start,
          expiresAt: input.window.end,
        }),
      );
      return { magicLinkToken: token };
    },
  };
}

/** Single-use consume. Returns null for an unknown, replayed, revoked, expired or not-yet-open token. */
export async function consumeAuditorMagicLink(
  db: DbClient,
  organizationId: string,
  token: string,
  now: Date = new Date(),
): Promise<ConsumedAuditorLink | null> {
  const rows = await withOrgContext(db, { organizationId, userId: NO_USER }, (tx) =>
    tx
      .update(LINK)
      .set({ consumedAt: now })
      .where(
        and(
          eq(LINK.organizationId, organizationId),
          eq(LINK.tokenHash, hashAuditorToken(token)),
          isNull(LINK.consumedAt),
          isNull(LINK.revokedAt),
          lte(LINK.windowStart, now),
          gt(LINK.expiresAt, now),
        ),
      )
      .returning({
        organizationId: LINK.organizationId,
        engagementId: LINK.engagementId,
        auditorEmail: LINK.auditorEmail,
        auditorName: LINK.auditorName,
        expiresAt: LINK.expiresAt,
      }),
  );
  return rows[0] ?? null;
}

/** Revoke every still-live link of an engagement; returns how many were revoked. Idempotent. */
export async function revokeAuditorMagicLinksForEngagement(
  db: DbClient,
  organizationId: string,
  engagementId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await withOrgContext(db, { organizationId, userId: NO_USER }, (tx) =>
    tx
      .update(LINK)
      .set({ revokedAt: now })
      .where(
        and(
          eq(LINK.organizationId, organizationId),
          eq(LINK.engagementId, engagementId),
          isNull(LINK.revokedAt),
        ),
      )
      .returning({ id: LINK.id }),
  );
  return rows.length;
}
