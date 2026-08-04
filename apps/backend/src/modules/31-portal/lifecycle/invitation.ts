// apps/backend/src/modules/31-portal/lifecycle/invitation.ts — M31-T03 (§2.2.4, §2.6, §7.1, §8.1, §8.3).
//
// The magic-link invitation state machine as a PURE core: issuance (TTL floor 72h / ceiling 7-day, single-
// use token, hashed at rest), acceptance (not-expired, not-revoked, not-already-bound, scope resolves), and
// the §2.6 idempotent replay (a replay by the SAME accepted account returns the existing binding, not a new
// one). M2 owns the magic-link token primitive and mints the session (§2.2.4 — "M2's magic-link consumer is
// the entry point; M31's `acceptInvitation()` runs after M2 validates the token and creates the session");
// M31 owns the invitation LIFECYCLE decision. `portal_invitation` is NOT an M31-owned table (the manifest
// owns three tables — [[m31-portal-telehealth]]); this evaluator drives the invitation state the route +
// M2-collaborator-invite layer persists (M31-T07). Facts in, a decision out — the caller passes `nowMs`.
import type {
  PortalAccessGrantKind,
  PortalAccountRelationship,
  PortalDataCategory,
  PortalScopeSet,
} from "@wardenx/types";
import { PortalStateError, requirePortal } from "./errors";
import { validateScopeSet } from "./scope-set";

/** §6.4 magic-link invite TTL — platform floor 72h, ceiling 7 days (per-tenant, clamped to this band). */
export const INVITATION_TTL_FLOOR_MS = 72 * 60 * 60_000;
export const INVITATION_TTL_CEILING_MS = 7 * 24 * 60 * 60_000;

/** Clamp a requested invite TTL into the §6.4 band. A tenant may tighten to the 24h floor the spec §2.2.4
 *  allows below the recommended 72h; we honor the §6.4 platform floor of 72h as the shipped default and
 *  never exceed the 7-day ceiling. */
export function resolveInvitationTtlMs(requestedMs?: number): number {
  if (requestedMs === undefined) return INVITATION_TTL_FLOOR_MS;
  return Math.min(Math.max(requestedMs, INVITATION_TTL_FLOOR_MS), INVITATION_TTL_CEILING_MS);
}

/** The relationship → grant-kind mapping the invite carries so acceptance can resolve the grant scope. */
const RELATIONSHIP_TO_GRANT_KIND: Record<PortalAccountRelationship, PortalAccessGrantKind> = {
  patient_self: "patient_self",
  family_caregiver: "family_caregiver",
  dpoa_healthcare_agent: "dpoa_healthcare",
  personal_representative_post_death: "personal_representative",
  bereaved_family_member: "bereaved_family",
};

/** The grant kind an invite for a given relationship will mint on acceptance (§7.1 step 2). */
export function grantKindForRelationship(rel: PortalAccountRelationship): PortalAccessGrantKind {
  return RELATIONSHIP_TO_GRANT_KIND[rel];
}

/** The issued invitation state (the route + M2-collaborator-invite layer persists this, M31-T07). */
export interface PortalInvitation {
  readonly tokenHash: string;
  readonly patientId: string;
  readonly relationship: PortalAccountRelationship;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  /** Per-category tenant tightening carried on the invite (§2.2.2 — "the invitation carried the proposed
   *  scope_set"); resolved against the grant kind's floor at acceptance. */
  readonly proposedScopeOverlay?: { readonly [K in PortalDataCategory]?: boolean };
  /** Set once accepted (§2.6 idempotency key = the account that bound the token). */
  readonly acceptedByPortalAccountId: string | null;
  readonly acceptedAtMs: number | null;
  /** Set if staff revoked the invite before acceptance (§2.2.4 soft state). */
  readonly revokedAtMs: number | null;
}

/** §7.1 — issue an invitation. PURE: the caller supplies the hashed token and `nowMs`. */
export function issueInvitation(input: {
  tokenHash: string;
  patientId: string;
  relationship: PortalAccountRelationship;
  ttlMs?: number;
  proposedScopeOverlay?: { readonly [K in PortalDataCategory]?: boolean };
  nowMs: number;
}): PortalInvitation {
  const ttl = resolveInvitationTtlMs(input.ttlMs);
  return {
    tokenHash: input.tokenHash,
    patientId: input.patientId,
    relationship: input.relationship,
    issuedAtMs: input.nowMs,
    expiresAtMs: input.nowMs + ttl,
    proposedScopeOverlay: input.proposedScopeOverlay,
    acceptedByPortalAccountId: null,
    acceptedAtMs: null,
    revokedAtMs: null,
  };
}

/** The outcome of an acceptance decision. `replayed` marks the §2.6 idempotent no-op (same account). */
export interface InvitationAcceptance {
  readonly invitation: PortalInvitation;
  readonly grantKind: PortalAccessGrantKind;
  readonly resolvedScope: PortalScopeSet;
  readonly replayed: boolean;
}

/**
 * §7.1 / §2.6 / §8.3 — accept an invitation for `portalAccountId`. Fails CLOSED on an expired / revoked /
 * already-bound token; resolves the grant scope from the invite's proposed overlay against the grant
 * kind's floor. Idempotent on `token_hash` (§2.6): a replay by the SAME accepted account returns the
 * existing binding with `replayed=true`; a different account against an already-accepted token is a
 * collision (`INVITATION_ALREADY_BOUND`), never a silent re-bind.
 */
export function acceptInvitation(
  invitation: PortalInvitation,
  input: { portalAccountId: string; floorVersion: string; nowMs: number },
): InvitationAcceptance {
  const grantKind = grantKindForRelationship(invitation.relationship);

  // §2.6 idempotent replay — the same account re-hitting an accepted token gets the existing binding.
  if (invitation.acceptedByPortalAccountId !== null) {
    requirePortal(
      invitation.acceptedByPortalAccountId === input.portalAccountId,
      "INVITATION_ALREADY_BOUND",
      "this invitation was already accepted by a different portal account",
    );
    return {
      invitation,
      grantKind,
      resolvedScope: validateScopeSet(
        grantKind,
        input.floorVersion,
        invitation.proposedScopeOverlay,
      ),
      replayed: true,
    };
  }

  requirePortal(
    invitation.revokedAtMs === null,
    "INVITATION_REVOKED",
    "this invitation was revoked",
  );
  requirePortal(
    input.nowMs < invitation.expiresAtMs,
    "INVITATION_EXPIRED",
    "this invitation has expired",
  );

  // §2.3 — the proposed scope must resolve against the kind's floor (throws INVITATION_SCOPE_INVALID-worthy
  // SCOPE_SET_LOOSENS_FLOOR if the overlay loosens; re-thrown as the invite-specific code for the §5 screen).
  let resolvedScope: PortalScopeSet;
  try {
    resolvedScope = validateScopeSet(
      grantKind,
      input.floorVersion,
      invitation.proposedScopeOverlay,
    );
  } catch {
    throw new PortalStateError(
      "INVITATION_SCOPE_INVALID",
      "the invitation's proposed scope does not resolve against the grant floor",
    );
  }

  return {
    invitation: {
      ...invitation,
      acceptedByPortalAccountId: input.portalAccountId,
      acceptedAtMs: input.nowMs,
    },
    grantKind,
    resolvedScope,
    replayed: false,
  };
}

/** Whether an invitation is still outstanding (neither accepted, revoked, nor expired) as-of `nowMs`. */
export function isInvitationOutstanding(invitation: PortalInvitation, nowMs: number): boolean {
  return (
    invitation.acceptedByPortalAccountId === null &&
    invitation.revokedAtMs === null &&
    nowMs < invitation.expiresAtMs
  );
}
