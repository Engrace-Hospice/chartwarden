// apps/backend/src/modules/31-portal/provisioning/invitations.ts — GAP-092. The portal's account + grant PROVISIONING:
// the one production path that creates a `portal_account`, a `portal_invitation` and a `portal_access_grant`.
//
//   issue   — resolves what the invitation needs BEFORE it writes anything: the patient's provider entity (M6), the
//             governing M39 portal-access consent (no consent ⇒ no invitation), and the invitee's identity (M2). It
//             then creates the `invited` account (contact PHI sealed under the tenant DEK) and the invitation, whose
//             single-use token is stored ONLY as a SHA-256 digest (`<orgId>.<secret>` — the org prefix is not secret;
//             it lets the token-authenticated accept route open the right tenant under RLS).
//   accept  — the pure §2.6 acceptance decision (`acceptInvitation`), then ONE transaction: the invitation is
//             consumed (a conditional update, so exactly one concurrent accept wins), the account activates and the
//             grant is inserted under the consent record + version governing at that moment.
//   revoke / list — the staff view over outstanding invitations.
//
// The invitee's SIGN-IN credential is the M2 identity module's concern (magic link / password reset over the same
// verified email); this service provisions the account and the access, it does not mint a session.
import { createHash, randomBytes } from "node:crypto";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError, type PortalDataCategory, WardenXError } from "@wardenx/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import { type M31EventEmitter, emitGrantGranted } from "../events";
import { requirePortal } from "../lifecycle/errors";
import {
  type PortalInvitation,
  acceptInvitation,
  grantKindForRelationship,
  issueInvitation,
  resolveInvitationTtlMs,
} from "../lifecycle/invitation";
import {
  PORTAL_DATA_CATEGORIES,
  categoryAllowedByFloor,
  validateScopeSet,
} from "../lifecycle/scope-set";
import type { PortalPhiCipher } from "../portal-crypto";
import type {
  AcceptedInvitation,
  InvitationListItem,
  IssueInvitationInput,
  IssuedInvitation,
  PortalConsentPort,
  PortalInvitationDeliveryPort,
  PortalInviteeUserPort,
  PortalPatientSitePort,
} from "./types";

const ACC = schema.portalAccounts;
const INV = schema.portalInvitations;
const GRANT = schema.portalAccessGrants;
type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
type InvitationRow = typeof INV.$inferSelect;

/** §7.5/D6 — the platform's one floor-schema version (the two M16 consumers use the same constant). */
export const PORTAL_SCOPE_FLOOR_VERSION = "1";

/** An accept token: `<orgId>.<url-safe secret>`. */
const TOKEN_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{43}$/i;

export const hashInvitationToken = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex");

/** Mint a fresh single-use token for an org. */
export function mintInvitationToken(organizationId: string): string {
  return `${organizationId}.${randomBytes(32).toString("base64url")}`;
}

/**
 * Pure: the tenant overlay a proposed category list implies — a floor-allowed category the invitation does NOT
 * name is turned off (a tightening); naming everything (or nothing) leaves the floor. A name that is not a data
 * category, or is floor-DENIED for the kind, is refused (an invitation can never loosen the floor).
 */
export function overlayForProposedScope(
  grantKind: ReturnType<typeof grantKindForRelationship>,
  proposed: readonly string[],
): { readonly [K in PortalDataCategory]?: boolean } | undefined {
  if (proposed.length === 0) return undefined;
  const known = new Set<string>(PORTAL_DATA_CATEGORIES);
  for (const name of proposed) {
    if (!known.has(name)) {
      throw new WardenXError("VALIDATION_FAILED", `'${name}' is not a portal data category`, 422);
    }
    if (!categoryAllowedByFloor(grantKind, name as PortalDataCategory)) {
      throw new WardenXError(
        "VALIDATION_FAILED",
        `'${name}' is not available to a ${grantKind} grant`,
        422,
      );
    }
  }
  const named = new Set(proposed);
  const overlay: { [K in PortalDataCategory]?: boolean } = {};
  for (const cat of PORTAL_DATA_CATEGORIES) {
    if (categoryAllowedByFloor(grantKind, cat) && !named.has(cat)) overlay[cat] = false;
  }
  return Object.keys(overlay).length === 0 ? undefined : overlay;
}

const statusOf = (row: InvitationRow, nowMs: number): InvitationListItem["status"] =>
  row.acceptedAt
    ? "accepted"
    : row.revokedAt
      ? "revoked"
      : row.expiresAt.getTime() <= nowMs
        ? "expired"
        : "outstanding";

export interface PortalInvitations {
  issue(input: IssueInvitationInput): Promise<IssuedInvitation>;
  list(organizationId: string): Promise<InvitationListItem[]>;
  revoke(organizationId: string, actingUserId: string, invitationId: string): Promise<void>;
  accept(token: string): Promise<AcceptedInvitation>;
}

export interface PortalInvitationsDeps {
  readonly db: DbClient;
  readonly cipher: PortalPhiCipher;
  readonly users: PortalInviteeUserPort;
  readonly consent: PortalConsentPort;
  readonly site: PortalPatientSitePort;
  readonly delivery?: PortalInvitationDeliveryPort;
  /**
   * GAP-158 - the caregiver -> M2 user link. When an invitation issued FOR a roster caregiver (`caregiverId`) is
   * accepted, the accept transaction stamps that caregiver's `user_id` through M5's `linkCaregiverToUserInTx`
   * (injected: M31 never writes M5's table). A `conflict` (the caregiver is already linked to a DIFFERENT login) or
   * a missing caregiver refuses the accept and rolls the whole transaction back - the token stays unconsumed.
   */
  readonly caregiverLink?: {
    linkInTx(
      tx: unknown,
      input: { organizationId: string; caregiverId: string; userId: string },
    ): Promise<"linked" | "already_linked" | "caregiver_not_found" | "conflict">;
  };
  /** GAP-159 - same-tx `m31.portal_account.invited` / `.activated` / `portal_access_grant.granted` emits. */
  readonly events?: M31EventEmitter;
  readonly now?: () => Date;
}

export function createPortalInvitations(deps: PortalInvitationsDeps): PortalInvitations {
  const now = deps.now ?? (() => new Date());
  const inOrg = <T>(
    organizationId: string,
    userId: string,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> => withOrgContext(deps.db, { organizationId, userId }, (tx) => fn(tx as Tx));

  return {
    async issue(input) {
      const grantKind = grantKindForRelationship(input.relationship);
      const overlay = overlayForProposedScope(grantKind, input.proposedScopeSet);
      const email = input.inviteeEmail.trim().toLowerCase();

      const site = await deps.site.siteForPatient(input.organizationId, input.patientId);
      if (!site) {
        throw new NotFoundError("patient");
      }
      const consent = await deps.consent.governingConsent({
        organizationId: input.organizationId,
        patientId: input.patientId,
        grantKind,
      });
      requirePortal(
        consent !== null,
        "PORTAL_CONSENT_ABSENT",
        "no active portal-access consent is on file for this patient; capture it before inviting",
      );

      const { userId } = await deps.users.ensureUser(input.organizationId, {
        email,
        displayName: input.inviteeDisplayName,
      });

      const token = mintInvitationToken(input.organizationId);
      const nowDate = now();
      // The pure §7.1 issuance: TTL clamp + the carried scope overlay.
      const issued = issueInvitation({
        tokenHash: hashInvitationToken(token),
        patientId: input.patientId,
        relationship: input.relationship,
        ttlMs: resolveInvitationTtlMs(),
        proposedScopeOverlay: overlay,
        nowMs: nowDate.getTime(),
      });
      // The overlay must resolve against the floor NOW (not at accept time, when the inviter is long gone).
      validateScopeSet(grantKind, PORTAL_SCOPE_FLOOR_VERSION, overlay);

      const [displayName, emailSealed, phoneSealed] = await Promise.all([
        deps.cipher.encrypt(
          input.organizationId,
          "portal_account.display_name_cipher",
          input.inviteeDisplayName,
        ),
        deps.cipher.encrypt(input.organizationId, "portal_account.email_cipher", email),
        input.inviteePhone
          ? deps.cipher.encrypt(
              input.organizationId,
              "portal_account.phone_cipher",
              input.inviteePhone,
            )
          : Promise.resolve(null),
      ]);

      const row = await inOrg(input.organizationId, input.actingUserId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(ACC)
          .where(
            and(
              eq(ACC.organizationId, input.organizationId),
              eq(ACC.userId, userId),
              eq(ACC.relationship, input.relationship),
              isNull(ACC.revokedAt),
            ),
          )
          .limit(1);
        let accountId: string;
        if (existing) {
          if (existing.status === "suspended") {
            throw new WardenXError(
              "PORTAL_ACCOUNT_SUSPENDED",
              "this person's portal account is suspended; reinstate it before inviting",
              409,
            );
          }
          const [liveGrant] = await tx
            .select({ id: GRANT.id })
            .from(GRANT)
            .where(
              and(
                eq(GRANT.portalAccountId, existing.id),
                eq(GRANT.patientId, input.patientId),
                isNull(GRANT.revokedAt),
              ),
            )
            .limit(1);
          if (liveGrant) {
            throw new WardenXError(
              "PORTAL_ACCESS_EXISTS",
              "this person already has portal access to this patient",
              409,
            );
          }
          accountId = existing.id;
        } else {
          const [created] = await tx
            .insert(ACC)
            .values({
              organizationId: input.organizationId,
              userId,
              relationship: input.relationship,
              status: "invited",
              displayNameCipher: displayName.envelope,
              emailCipher: emailSealed.envelope,
              phoneCipher: phoneSealed?.envelope ?? null,
              invitedAt: nowDate,
            })
            .returning({ id: ACC.id });
          if (!created) throw new Error("portal_account insert returned no row");
          accountId = created.id;
        }
        // Re-issuing replaces the outstanding invitation for the same account + patient.
        await tx
          .update(INV)
          .set({ revokedAt: nowDate })
          .where(
            and(
              eq(INV.portalAccountId, accountId),
              eq(INV.patientId, input.patientId),
              isNull(INV.acceptedAt),
              isNull(INV.revokedAt),
            ),
          );
        const [invitation] = await tx
          .insert(INV)
          .values({
            organizationId: input.organizationId,
            providerEntityId: site.providerEntityId,
            locationId: site.locationId,
            portalAccountId: accountId,
            patientId: input.patientId,
            relationship: input.relationship,
            grantKind,
            tokenHash: issued.tokenHash,
            proposedScopeOverlay: overlay ?? null,
            caregiverId: input.caregiverId ?? null,
            bereavedContactId: input.bereavedContactId ?? null,
            invitedByUserId: input.actingUserId === "" ? null : input.actingUserId,
            expiresAt: new Date(issued.expiresAtMs),
            createdAt: nowDate,
          })
          .returning();
        if (!invitation) throw new Error("portal_invitation insert returned no row");
        await deps.events?.emitInTx(
          tx,
          input.organizationId,
          "m31.portal_account.invited",
          { kind: "portal_account", id: accountId },
          {
            portalAccountId: accountId,
            patientId: input.patientId,
            relationship: input.relationship,
            issuedByMembershipId: input.actingUserId === "" ? "system" : input.actingUserId,
          },
        );
        return invitation;
      });

      // Best effort AFTER commit: a delivery failure never undoes a durably recorded invitation; the admin link is
      // the fallback (the M2 `deliverInvite` posture). With no delivery bound, the link is returned to the admin.
      let inviteUrl: string | null = null;
      if (deps.delivery) {
        try {
          const delivered = await deps.delivery.deliver({
            organizationId: input.organizationId,
            email,
            displayName: input.inviteeDisplayName,
            token,
            expiresAt: row.expiresAt,
          });
          inviteUrl = delivered.inviteUrl;
        } catch {
          inviteUrl = null;
        }
      }
      return {
        invitationId: row.id,
        portalAccountId: row.portalAccountId,
        status: "invited" as const,
        expiresAt: row.expiresAt.toISOString(),
        inviteUrl,
      };
    },

    async list(organizationId) {
      const nowMs = now().getTime();
      return inOrg(organizationId, "", async (tx) => {
        const rows = await tx
          .select()
          .from(INV)
          .where(eq(INV.organizationId, organizationId))
          .orderBy(desc(INV.createdAt))
          .limit(200);
        return rows.map((r) => ({
          invitationId: r.id,
          relationship: r.relationship,
          status: statusOf(r, nowMs),
          issuedAt: r.createdAt.toISOString(),
          expiresAt: r.expiresAt.toISOString(),
        }));
      });
    },

    async revoke(organizationId, actingUserId, invitationId) {
      await inOrg(organizationId, actingUserId, async (tx) => {
        const [row] = await tx
          .select()
          .from(INV)
          .where(and(eq(INV.organizationId, organizationId), eq(INV.id, invitationId)))
          .limit(1);
        if (!row) throw new NotFoundError("portal invitation");
        if (row.acceptedAt) {
          throw new WardenXError(
            "INVITATION_ALREADY_ACCEPTED",
            "this invitation was already accepted; revoke the account's grant instead",
            409,
          );
        }
        if (row.revokedAt) return; // idempotent
        await tx.update(INV).set({ revokedAt: now() }).where(eq(INV.id, row.id));
      });
    },

    async accept(token) {
      const match = TOKEN_RE.exec(token.trim());
      if (!match?.[1]) {
        throw new WardenXError("INVITATION_INVALID", "this invitation link is not valid", 404);
      }
      const organizationId = match[1].toLowerCase();
      const tokenHash = hashInvitationToken(token.trim());
      const nowDate = now();

      const outcome = await inOrg(organizationId, "", async (tx) => {
        const [row] = await tx
          .select()
          .from(INV)
          .where(and(eq(INV.organizationId, organizationId), eq(INV.tokenHash, tokenHash)))
          .limit(1);
        if (!row) {
          throw new WardenXError("INVITATION_INVALID", "this invitation link is not valid", 404);
        }
        const asState: PortalInvitation = {
          tokenHash,
          patientId: row.patientId,
          relationship: row.relationship,
          issuedAtMs: row.createdAt.getTime(),
          expiresAtMs: row.expiresAt.getTime(),
          proposedScopeOverlay:
            (row.proposedScopeOverlay as { [K in PortalDataCategory]?: boolean } | null) ??
            undefined,
          acceptedByPortalAccountId: row.acceptedAt ? row.portalAccountId : null,
          acceptedAtMs: row.acceptedAt ? row.acceptedAt.getTime() : null,
          revokedAtMs: row.revokedAt ? row.revokedAt.getTime() : null,
        };
        const decision = acceptInvitation(asState, {
          portalAccountId: row.portalAccountId,
          floorVersion: PORTAL_SCOPE_FLOOR_VERSION,
          nowMs: nowDate.getTime(),
        });
        const result = (replayed: boolean, userId: string | null) => ({
          accepted: {
            portalAccountId: row.portalAccountId,
            patientId: row.patientId,
            grantKind: decision.grantKind,
            status: "active" as const,
            replayed,
          },
          verifyUserId: userId,
        });
        if (decision.replayed) return result(true, null);

        const consent = await deps.consent.governingConsent({
          organizationId,
          patientId: row.patientId,
          grantKind: decision.grantKind,
        });
        requirePortal(
          consent !== null,
          "PORTAL_CONSENT_ABSENT",
          "no active portal-access consent is on file for this patient",
        );

        const [account] = await tx
          .select()
          .from(ACC)
          .where(and(eq(ACC.organizationId, organizationId), eq(ACC.id, row.portalAccountId)))
          .limit(1);
        if (!account || account.revokedAt || account.status === "suspended") {
          throw new WardenXError(
            "PORTAL_ACCOUNT_NOT_INVITABLE",
            "this portal account can no longer accept an invitation",
            409,
          );
        }
        // Exactly one concurrent accept consumes the token.
        const consumed = await tx
          .update(INV)
          .set({ acceptedAt: nowDate })
          .where(and(eq(INV.id, row.id), isNull(INV.acceptedAt), isNull(INV.revokedAt)))
          .returning({ id: INV.id });
        if (consumed.length === 0) {
          throw new WardenXError(
            "INVITATION_ALREADY_BOUND",
            "this invitation was already used or revoked",
            409,
          );
        }
        if (account.status === "invited") {
          await tx
            .update(ACC)
            .set({
              status: "active",
              activatedAt: nowDate,
              version: account.version + 1,
              updatedAt: nowDate,
            })
            .where(eq(ACC.id, account.id));
          await deps.events?.emitInTx(
            tx,
            organizationId,
            "m31.portal_account.activated",
            { kind: "portal_account", id: account.id },
            {
              portalAccountId: account.id,
              patientId: row.patientId,
              relationship: row.relationship,
              activatedAt: nowDate.toISOString(),
            },
          );
        }
        const [grant] = await tx
          .insert(GRANT)
          .values({
            organizationId,
            providerEntityId: row.providerEntityId,
            locationId: row.locationId,
            portalAccountId: row.portalAccountId,
            patientId: row.patientId,
            grantKind: decision.grantKind,
            scopeSetJsonb: decision.resolvedScope,
            sourceConsentRecordId: (consent as NonNullable<typeof consent>).consentRecordId,
            sourceConsentVersion: (consent as NonNullable<typeof consent>).consentVersion,
            grantedAt: nowDate,
            grantedByMembershipId: null,
          })
          .returning({ id: GRANT.id });
        if (!grant) throw new Error("portal_access_grant insert returned no row");
        await emitGrantGranted(deps.events, tx, organizationId, {
          id: grant.id,
          portalAccountId: row.portalAccountId,
          patientId: row.patientId,
          grantKind: decision.grantKind,
        });
        // GAP-158 - claim the roster caregiver this invitation was issued for (same tx as the consumed token).
        if (row.caregiverId && deps.caregiverLink) {
          const linked = await deps.caregiverLink.linkInTx(tx, {
            organizationId,
            caregiverId: row.caregiverId,
            userId: account.userId,
          });
          if (linked === "conflict" || linked === "caregiver_not_found") {
            throw new WardenXError(
              linked === "conflict" ? "CAREGIVER_ALREADY_LINKED" : "CAREGIVER_NOT_FOUND",
              linked === "conflict"
                ? "this caregiver record is already linked to a different portal login"
                : "the caregiver this invitation was issued for no longer exists",
              409,
            );
          }
        }
        return result(false, account.userId);
      });

      // The token reached the invitee's inbox, so possessing it verifies the address.
      if (outcome.verifyUserId) {
        await deps.users.markEmailVerified(organizationId, outcome.verifyUserId);
      }
      return outcome.accepted;
    },
  };
}
