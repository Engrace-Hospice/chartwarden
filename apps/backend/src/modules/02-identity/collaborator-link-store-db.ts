// apps/backend/src/modules/02-identity/collaborator-link-store-db.ts — the DURABLE `CollaboratorLinkStore`
// (GAP-115 follow-up; migration 0521) behind `POST /collaborators/invite|consume` and `POST /funeral/invite`.
//
// What the per-process Map got wrong, and this gets right:
//   • HASHED AT REST. Only the sha256 of a 256-bit random secret is stored; the raw token is returned to the caller
//     once (for the delivery port) and exists nowhere else. The token is `<organizationId>.<secret>` — the org
//     prefix is not secret; it lets the unauthenticated redeem route open the right tenant under RLS.
//   • ORG-SCOPED. Every statement runs inside `withOrgContext` (RLS pins `app.org_id`) AND names the organization in
//     its WHERE, so a token minted by tenant A is invisible when presented as tenant B's: the lookup finds no row.
//   • BOUNDED USE, ATOMIC. A redemption is ONE conditional UPDATE (`use_count < max_uses`, not revoked, not expired,
//     using the database clock) that returns the row; exactly one of N concurrent redeemers wins, and the loser is
//     classified AFTER the fact (expired / used) for the response and the audit, never to decide the claim.
//   • CONSTANT-TIME CHECK. The lookup key is the digest of the presented token, so no byte of the secret is ever
//     compared in variable time against anything an attacker can probe; the returned digest is additionally compared
//     with `timingSafeEqual` against the one computed, as a belt-and-suspenders against an index/collation surprise.
//   • FAIL CLOSED. A malformed token, an unknown org, a cross-tenant token, a revoked, expired or spent link all
//     answer the same typed `LinkError`; only the AUDIT (never the client) learns which.
//
// The credential-less PRINCIPAL. Better Auth's `session.user_id` is NOT NULL, so a redeemed link needs a `user`. The
// first redemption creates one synthetic user per link (`link-<linkId>@principals.wardenx.invalid` - an address that
// cannot receive mail, with no password, no `account` row and no membership), so it can authenticate ONLY through this
// link and holds no staff permission. It is created in the same transaction as the use-count claim: a failure to
// create it rolls the claim back.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { ChartWardenError } from "@wardenx/types";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  type CollaboratorLinkStore,
  type CollaboratorScope,
  FUNERAL_LINK_TTL_SEC,
  LinkError,
  type RefusedLinkInfo,
} from "./identity-ports";

const LINKS = schema.collaboratorLinks;
const USERS = schema.users;
/** A consumer is not a request: the context carries no acting user (the audit trigger maps "" to NULL). */
const NO_USER = "";
/** A collaborator link is redeemable for 30 minutes (M2 §7.6); a funeral-home link for 72 hours (§3.6). */
const COLLABORATOR_LINK_TTL_SEC = 30 * 60;
const DEFAULT_COLLAB_SESSION_TTL_SEC = 8 * 3600;
const TOKEN_SECRET_BYTES = 32;
/** The synthetic principal's domain: reserved by RFC 6761 - it can never receive mail. */
const PRINCIPAL_EMAIL_DOMAIN = "principals.wardenx.invalid";

/** `<orgId uuid>.<43 url-safe base64 chars>` - the shape of a 256-bit secret. */
const TOKEN_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i;

/** sha256 hex of the presented token - the ONLY form of the token the database ever sees. */
export const hashLinkToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Mint a fresh single-use token for an org. */
export const mintLinkToken = (organizationId: string): string =>
  `${organizationId}.${randomBytes(TOKEN_SECRET_BYTES).toString("base64url")}`;

/** The org a well-formed token names, or null. Case-folded: the prefix is an id, the secret is compared by digest. */
export function organizationOfLinkToken(token: string): string | null {
  const match = TOKEN_RE.exec(token);
  return match?.[1] ? match[1].toLowerCase() : null;
}

/** The patient's siting at issue time (M6), injected: M2 may not read the admission. */
export interface LinkPatientSitePort {
  siteForPatient(
    organizationId: string,
    patientId: string,
  ): Promise<{ providerEntityId: string; locationId: string | null } | null>;
}

export interface DbCollaboratorLinkStoreDeps {
  readonly site: LinkPatientSitePort;
  /** Injected only so a unit test can pin "now" for the typed-expiry maths; SQL decisions use the DB clock. */
  readonly now?: () => Date;
}

type LinkKindValue = "external_collaborator" | "funeral_home";

const refusedInfo = (
  row: { id: string; kind: string },
  organizationId: string,
  reason: RefusedLinkInfo["reason"],
): RefusedLinkInfo => ({
  linkId: row.id,
  organizationId,
  kind: row.kind as LinkKindValue,
  reason,
});

export function createDbCollaboratorLinkStore(
  db: DbClient,
  deps: DbCollaboratorLinkStoreDeps,
): CollaboratorLinkStore {
  const now = deps.now ?? (() => new Date());

  return {
    async create(input) {
      const kind: LinkKindValue = input.kind ?? "external_collaborator";
      const site = await deps.site.siteForPatient(input.organizationId, input.patientId);
      if (!site) {
        // The patient has no siting (no admission to resolve a provider entity from): a link pinned to them could
        // not carry the ARCH-011 columns, and minting one anyway would be an unscoped grant. Refuse.
        throw new ChartWardenError(
          "LINK_PATIENT_SITE_UNAVAILABLE",
          "the patient's site could not be resolved; a link cannot be issued",
          409,
        );
      }
      const linkTtlSec =
        input.ttlSec ??
        (kind === "funeral_home" ? FUNERAL_LINK_TTL_SEC : COLLABORATOR_LINK_TTL_SEC);
      const sessionTtlSec =
        input.sessionTtlSec ??
        (kind === "funeral_home" ? FUNERAL_LINK_TTL_SEC : DEFAULT_COLLAB_SESSION_TTL_SEC);
      const maxUses = input.maxUses ?? 1;
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 10) {
        throw new ChartWardenError("VALIDATION_FAILED", "maxUses must be an integer from 1 to 10", 422);
      }
      const token = mintLinkToken(input.organizationId);
      const expiresAt = new Date(now().getTime() + linkTtlSec * 1000);
      const [row] = await withOrgContext(
        db,
        { organizationId: input.organizationId, userId: NO_USER },
        (tx) =>
          tx
            .insert(LINKS)
            .values({
              organizationId: input.organizationId,
              providerEntityId: site.providerEntityId,
              locationId: site.locationId,
              patientId: input.patientId,
              kind,
              invitedByMembershipId: input.invitedByMembershipId,
              tokenHash: hashLinkToken(token),
              expiresAt,
              sessionTtlSec,
              maxUses,
            })
            .returning({ id: LINKS.id, expiresAt: LINKS.expiresAt }),
      );
      if (!row) throw new Error("collaborator link insert returned no row");
      return { linkId: row.id, expiresAt: row.expiresAt.toISOString(), token };
    },

    async consume(token): Promise<CollaboratorScope> {
      const organizationId = organizationOfLinkToken(token);
      if (!organizationId) throw new LinkError("expired", "link invalid or expired");
      const tokenHash = hashLinkToken(token);

      const outcome = await withOrgContext(db, { organizationId, userId: NO_USER }, async (tx) => {
        // The claim: one conditional UPDATE on the database clock. Zero rows ⇒ not claimable (classified below).
        const claimed = await tx
          .update(LINKS)
          .set({
            useCount: sql`${LINKS.useCount} + 1`,
            firstRedeemedAt: sql`COALESCE(${LINKS.firstRedeemedAt}, now())`,
            consumedAt: sql`CASE WHEN ${LINKS.useCount} + 1 >= ${LINKS.maxUses} THEN now() ELSE ${LINKS.consumedAt} END`,
          })
          .where(
            and(
              eq(LINKS.organizationId, organizationId),
              eq(LINKS.tokenHash, tokenHash),
              isNull(LINKS.revokedAt),
              sql`${LINKS.useCount} < ${LINKS.maxUses}`,
              sql`${LINKS.expiresAt} > now()`,
            ),
          )
          .returning({
            id: LINKS.id,
            tokenHash: LINKS.tokenHash,
            patientId: LINKS.patientId,
            kind: LINKS.kind,
            sessionTtlSec: LINKS.sessionTtlSec,
            useCount: LINKS.useCount,
            principalUserId: LINKS.principalUserId,
          });
        const row = claimed[0];
        if (!row) {
          const [known] = await tx
            .select({
              id: LINKS.id,
              kind: LINKS.kind,
              revokedAt: LINKS.revokedAt,
              expired: sql<boolean>`${LINKS.expiresAt} <= now()`,
              spent: sql<boolean>`${LINKS.useCount} >= ${LINKS.maxUses}`,
            })
            .from(LINKS)
            .where(and(eq(LINKS.organizationId, organizationId), eq(LINKS.tokenHash, tokenHash)))
            .limit(1);
          return { claimed: null, known: known ?? null } as const;
        }
        // Belt and suspenders: the digest the database returned is the one we computed, compared in constant time.
        const a = Buffer.from(row.tokenHash, "utf8");
        const b = Buffer.from(tokenHash, "utf8");
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          throw new Error("collaborator link digest mismatch");
        }
        // The credential-less principal, created in the SAME transaction as the claim (a failure rolls the claim back).
        const principalUserId =
          row.principalUserId ?? (await ensurePrincipal(tx as unknown as DbClient, row));
        return { claimed: { ...row, principalUserId }, known: null } as const;
      });

      if (outcome.claimed) {
        const row = outcome.claimed;
        return {
          patientId: row.patientId,
          organizationId,
          kind: row.kind as LinkKindValue,
          linkId: row.id,
          principalUserId: row.principalUserId,
          sessionTtlSec: row.sessionTtlSec,
          useCount: row.useCount,
        };
      }
      const known = outcome.known;
      if (!known) throw new LinkError("expired", "link invalid or expired");
      if (known.revokedAt)
        throw new LinkError(
          "expired",
          "link invalid or expired",
          refusedInfo(known, organizationId, "revoked"),
        );
      if (known.expired)
        throw new LinkError(
          "expired",
          "link invalid or expired",
          refusedInfo(known, organizationId, "expired"),
        );
      throw new LinkError("used", "link already used", refusedInfo(known, organizationId, "used"));
    },

    async release({ organizationId, linkId }) {
      await withOrgContext(db, { organizationId, userId: NO_USER }, (tx) =>
        tx
          .update(LINKS)
          .set({
            useCount: sql`GREATEST(${LINKS.useCount} - 1, 0)`,
            consumedAt: null,
          })
          .where(
            and(
              eq(LINKS.id, linkId),
              eq(LINKS.organizationId, organizationId),
              sql`${LINKS.useCount} > 0`,
              isNull(LINKS.revokedAt),
            ),
          ),
      );
    },

    async revoke({ organizationId, linkId }) {
      await withOrgContext(db, { organizationId, userId: NO_USER }, (tx) =>
        tx
          .update(LINKS)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(LINKS.id, linkId),
              eq(LINKS.organizationId, organizationId),
              isNull(LINKS.revokedAt),
            ),
          ),
      );
    },

    async revokeForPatient({ organizationId, patientId }) {
      const rows = await withOrgContext(db, { organizationId, userId: NO_USER }, (tx) =>
        tx
          .update(LINKS)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(LINKS.organizationId, organizationId),
              eq(LINKS.patientId, patientId),
              isNull(LINKS.revokedAt),
            ),
          )
          .returning({ id: LINKS.id }),
      );
      return rows.length;
    },
  };
}

/** Find-or-create the link's synthetic principal user and pin it on the link row. Runs inside the claim's tx. */
async function ensurePrincipal(tx: DbClient, row: { id: string; kind: string }): Promise<string> {
  const email = `link-${row.id}@${PRINCIPAL_EMAIL_DOMAIN}`;
  await tx
    .insert(USERS)
    .values({
      email,
      emailVerified: true,
      name: row.kind === "funeral_home" ? "Funeral home visitor" : "External collaborator",
      status: "active",
    })
    .onConflictDoNothing({ target: USERS.email });
  const [user] = await tx
    .select({ id: USERS.id })
    .from(USERS)
    .where(eq(USERS.email, email))
    .limit(1);
  if (!user) throw new Error("collaborator link principal resolution failed");
  const pinned = await tx
    .update(LINKS)
    .set({ principalUserId: user.id })
    .where(and(eq(LINKS.id, row.id), isNull(LINKS.principalUserId)))
    .returning({ id: LINKS.id });
  // Another redeemer pinned it first: both resolved the SAME email, so the id is identical either way.
  void pinned;
  return user.id;
}
