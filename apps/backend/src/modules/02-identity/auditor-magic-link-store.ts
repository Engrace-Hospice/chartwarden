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
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuditorMagicLinkIssuer } from "@chartwarden/auth";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
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

// ── Redemption primitives (the auditor session redemption flow, `auditor-redemption.ts`) ────────────────

/** Where a presented link stands. Order matters: a revoked link is revoked even if it also expired. */
export type AuditorLinkState = "live" | "consumed" | "revoked" | "expired" | "not_yet_open";

/** The `auditor_magic_link` row, never including the token hash. */
export interface AuditorLinkRow {
  readonly id: string;
  readonly organizationId: string;
  readonly engagementId: string;
  readonly auditorEmail: string;
  readonly auditorName: string;
  readonly windowStart: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** Pure: classify a link at `now` (injectable clock). */
export function classifyAuditorLink(
  row: Pick<AuditorLinkRow, "windowStart" | "expiresAt" | "consumedAt" | "revokedAt">,
  now: Date,
): AuditorLinkState {
  if (row.revokedAt) return "revoked";
  if (row.consumedAt) return "consumed";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  if (row.windowStart.getTime() > now.getTime()) return "not_yet_open";
  return "live";
}

/**
 * Constant-time comparison of two hex sha-256 digests. The row is found by an indexed equality on the hash,
 * so the database comparison is already over a 256-bit one-way digest of a 256-bit random secret (nothing a
 * timing channel can usefully probe); this is the defence-in-depth application-level check the redemption
 * contract asks for, and it also refuses any malformed stored value instead of comparing it.
 */
export function auditorTokenHashMatches(storedHashHex: string, candidateHashHex: string): boolean {
  if (storedHashHex.length !== candidateHashHex.length) return false;
  const a = Buffer.from(storedHashHex, "hex");
  const b = Buffer.from(candidateHashHex, "hex");
  if (a.length === 0 || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const LINK_COLUMNS = {
  id: LINK.id,
  organizationId: LINK.organizationId,
  engagementId: LINK.engagementId,
  auditorEmail: LINK.auditorEmail,
  auditorName: LINK.auditorName,
  windowStart: LINK.windowStart,
  expiresAt: LINK.expiresAt,
  consumedAt: LINK.consumedAt,
  revokedAt: LINK.revokedAt,
  tokenHash: LINK.tokenHash,
} as const;

/** The scoped transaction handle `withOrgContext` passes — callers cast it to a DbClient, the repo's pattern. */
type LinkTx = DbClient;

/**
 * Find the link a presented token names, tenant-scoped (RLS + explicit predicate), optionally taking a row
 * lock so two concurrent redemptions serialize. `null` for an unknown token or a non-matching digest.
 */
export async function findAuditorLinkByToken(
  tx: LinkTx,
  organizationId: string,
  token: string,
  opts: { readonly lock: boolean },
): Promise<AuditorLinkRow | null> {
  const candidate = hashAuditorToken(token);
  const base = tx
    .select(LINK_COLUMNS)
    .from(LINK)
    .where(and(eq(LINK.organizationId, organizationId), eq(LINK.tokenHash, candidate)))
    .limit(1);
  const rows = await (opts.lock ? base.for("update") : base);
  const row = rows[0];
  if (!row || !auditorTokenHashMatches(row.tokenHash, candidate)) return null;
  const { tokenHash: _omit, ...link } = row;
  return link;
}

/**
 * Single-use consume of a specific link row. Matches on the row id AND the still-live predicate and asserts
 * the RETURNING, so a lost race (or a link revoked a moment ago) reports `false` instead of silently succeeding.
 */
export async function consumeAuditorLinkRow(
  tx: LinkTx,
  link: Pick<AuditorLinkRow, "id" | "organizationId">,
  now: Date,
): Promise<boolean> {
  const rows = await tx
    .update(LINK)
    .set({ consumedAt: now })
    .where(
      and(
        eq(LINK.id, link.id),
        eq(LINK.organizationId, link.organizationId),
        isNull(LINK.consumedAt),
        isNull(LINK.revokedAt),
        lte(LINK.windowStart, now),
        gt(LINK.expiresAt, now),
      ),
    )
    .returning({ id: LINK.id });
  return rows.length === 1;
}
