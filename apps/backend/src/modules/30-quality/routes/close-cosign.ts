// apps/backend/src/modules/30-quality/routes/close-cosign.ts — GAP-088 / GAP-046: the service-layer two-person
// guard for the QAPI PIP close (R-31, V-11) and the SRA cycle close (R-47, V-12).
//
// SPEC (docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md): D12 (line 3576) — SRA close = Security
// Officer + Compliance Officer, PIP close = QAPI Coordinator + Medical Director, "distinct individuals",
// enforced at the application layer AND the DB; §4.7 (lines 2106/2108) — the caller holds one role of the
// pair and the SECOND co-signer holds the OTHER; line 3804 — both closes require a recent step-up.
//
// PENDING CLOSE + NOMINEE CONFIRMATION (GAP-046): closing is two-step. The closer INITIATES (stamps their own
// slot, names the nominee; the record stays OPEN). The nominee then CONFIRMS in their OWN authenticated,
// step-up-fresh session (`resolveCloseConfirmation`), stamps their slot, and only then is `closed_at` written
// and the `*_closed` event published. Migration 0701 restored the DB CHECK so a closed row needs both signatures.
//
// The FIRST signer is the authenticated caller (`actor.membershipId`, server-assembled) — it is never read
// off the wire. The SECOND signer is the only id the body supplies at initiation, and it is validated here
// against facts the service loads inside its own org-scoped tx (`cosignerRoleKeys`: `null` ⇒ not an ACTIVE
// membership of this org). The route composes the same rule as a `requireAbac` preHandler; this guard repeats
// it so a worker/other caller of the service cannot bypass the route. The confirmer is never named on the wire:
// it is the nominee persisted on the row, compared with the session's membership id.
import { ConflictError, ForbiddenError, StepUpRequiredError } from "@wardenx/types";
import {
  ROLE_COMPLIANCE_OFFICER,
  ROLE_MEDICAL_DIRECTOR,
  ROLE_QAPI_COORDINATOR,
  ROLE_SECURITY_OFFICER,
} from "../abac-predicates";

/** The two complementary roles of one closing ceremony (order is not significant). */
export type CloseRolePair = readonly [string, string];

/** V-11 — a PIP is closed by a QAPI Coordinator + a Medical Director. */
export const PIP_CLOSE_ROLES: CloseRolePair = [ROLE_QAPI_COORDINATOR, ROLE_MEDICAL_DIRECTOR];
/** V-12 — an SRA cycle is closed by a Security Officer + a Compliance Officer. */
export const SRA_CLOSE_ROLES: CloseRolePair = [ROLE_SECURITY_OFFICER, ROLE_COMPLIANCE_OFFICER];

export interface CloseCosignInput {
  /** The authenticated caller's membership id (session-derived; the FIRST signer). */
  readonly actorMembershipId: string;
  /** The caller's roles from the session. */
  readonly actorRoles: readonly string[];
  /** The body-supplied SECOND signer. */
  readonly cosignerMembershipId: string;
  /** The co-signer's live role keys, or `null` when it is not an active membership of the caller's org. */
  readonly cosignerRoleKeys: readonly string[] | null;
  /** Real step-up freshness derived from the request context (never a body field or a constant). */
  readonly recentStepUp: boolean;
  readonly roles: CloseRolePair;
}

export interface CloseCosigners {
  readonly first: string;
  readonly second: string;
  /** The role the caller signs under (the nominee holds the other one). */
  readonly callerRole: string;
  /** The role the nominated co-signer holds (the complement of `callerRole`). */
  readonly nomineeRole: string;
}

/** A close that has been initiated and awaits the nominee's own confirmation. */
export interface PendingClose {
  readonly closedBy: string;
  readonly closerRole: string;
  readonly nominee: string;
  readonly nomineeRole: string;
}

/** Who signed a CONFIRMED close: the closer (initiate) and the nominee (confirm, in their own session). */
export interface CloseAttestation {
  readonly closedBy: { readonly membershipId: string; readonly role: string };
  /** The second signer. Kept under its 0335 name so existing event consumers keep parsing the payload. */
  readonly nominatedCosigner: { readonly membershipId: string; readonly role: string };
  /** Always `true` on the emitted `*_closed` event: it is only published once the nominee has attested. */
  readonly cosignerAttested: true;
}

/** The honest closure record, built ONLY at confirmation, when both parties have authenticated and signed. */
export function buildConfirmedCloseAttestation(pending: PendingClose): CloseAttestation {
  return {
    closedBy: { membershipId: pending.closedBy, role: pending.closerRole },
    nominatedCosigner: { membershipId: pending.nominee, role: pending.nomineeRole },
    cosignerAttested: true,
  };
}

/** Marker columns shared by both closure tables (migrations 0335/0701): who initiated, who must confirm. */
interface PendingMarkerColumns {
  readonly closureClosedByMembershipId: string;
  readonly closureNomineeMembershipId: string;
  readonly closureCosignAttested: false;
  readonly closedAt: null;
}

function pendingMarkers(signers: CloseCosigners): PendingMarkerColumns {
  return {
    closureClosedByMembershipId: signers.first,
    closureNomineeMembershipId: signers.second,
    closureCosignAttested: false,
    closedAt: null,
  };
}

/**
 * The `qapi_pip` columns persisted by INITIATING a close (GAP-046): the closer's role slot is stamped at `at`;
 * the nominee's slot carries only the id and its `_at` stays NULL. `closed_at` stays NULL — the PIP is not
 * closed until the nominee confirms ({@link buildPipConfirmColumns}).
 */
export function buildPipPendingCloseColumns(signers: CloseCosigners, at: Date) {
  const callerIsCoordinator = signers.callerRole === ROLE_QAPI_COORDINATOR;
  return {
    cosignQapiCoordinatorMembershipId: callerIsCoordinator ? signers.first : signers.second,
    cosignQapiCoordinatorAt: callerIsCoordinator ? at : null,
    cosignMedicalDirectorMembershipId: callerIsCoordinator ? signers.second : signers.first,
    cosignMedicalDirectorAt: callerIsCoordinator ? null : at,
    ...pendingMarkers(signers),
  };
}

/** The `sra_cycle` counterpart of {@link buildPipPendingCloseColumns}. */
export function buildSraPendingCloseColumns(signers: CloseCosigners, at: Date) {
  const callerIsSecurityOfficer = signers.callerRole === ROLE_SECURITY_OFFICER;
  return {
    cosignSecurityOfficerMembershipId: callerIsSecurityOfficer ? signers.first : signers.second,
    cosignSecurityOfficerAt: callerIsSecurityOfficer ? at : null,
    cosignComplianceOfficerMembershipId: callerIsSecurityOfficer ? signers.second : signers.first,
    cosignComplianceOfficerAt: callerIsSecurityOfficer ? null : at,
    ...pendingMarkers(signers),
  };
}

/** The PIP columns written when the nominee confirms: their slot is stamped, the close becomes attested. */
export function buildPipConfirmColumns(pending: PendingClose, at: Date) {
  const nomineeSlot =
    pending.nomineeRole === ROLE_QAPI_COORDINATOR
      ? { cosignQapiCoordinatorAt: at }
      : { cosignMedicalDirectorAt: at };
  return { ...nomineeSlot, closureCosignAttested: true as const, closedAt: at };
}

/** The SRA counterpart of {@link buildPipConfirmColumns}. */
export function buildSraConfirmColumns(pending: PendingClose, at: Date) {
  const nomineeSlot =
    pending.nomineeRole === ROLE_SECURITY_OFFICER
      ? { cosignSecurityOfficerAt: at }
      : { cosignComplianceOfficerAt: at };
  return { ...nomineeSlot, closureCosignAttested: true as const, closedAt: at };
}

/** The persisted facts of a close row needed to recognise a pending close. */
export interface PendingCloseRow {
  readonly closedAt: Date | null;
  readonly closureClosedByMembershipId: string | null;
  readonly closureNomineeMembershipId: string | null;
  /** The two role slots in `CloseRolePair` order, each with its persisted membership id. */
  readonly slotMembershipIds: readonly [string | null, string | null];
}

/** The pending close recorded on a row, or `null` when there is none (never initiated, or already closed). */
export function readPendingClose(row: PendingCloseRow, roles: CloseRolePair): PendingClose | null {
  const closedBy = row.closureClosedByMembershipId;
  const nominee = row.closureNomineeMembershipId;
  if (row.closedAt !== null || !closedBy || !nominee) return null;
  const roleOf = (membershipId: string): string | undefined => {
    const index = row.slotMembershipIds.indexOf(membershipId);
    return index === -1 ? undefined : roles[index];
  };
  const closerRole = roleOf(closedBy);
  const nomineeRole = roleOf(nominee);
  return closerRole && nomineeRole ? { closedBy, closerRole, nominee, nomineeRole } : null;
}

export interface ConfirmCloseInput {
  readonly pending: PendingClose | null;
  /** The authenticated caller's membership id (session-derived — never a body field). */
  readonly actorMembershipId: string;
  /** The caller's roles from the session. */
  readonly actorRoles: readonly string[];
  /** The caller's live role keys in this org, or `null` when they are not an active member. */
  readonly actorLiveRoleKeys: readonly string[] | null;
  readonly recentStepUp: boolean;
}

/**
 * GAP-046 — validate the nominee's confirmation. The confirmer must BE the nominee the closer named, authenticate
 * as themselves with a fresh step-up, and still hold the complementary role. Returns the pending close to complete.
 */
export function resolveCloseConfirmation(input: ConfirmCloseInput): PendingClose {
  if (!input.recentStepUp) throw new StepUpRequiredError();
  const { pending } = input;
  if (!pending) throw new ConflictError("no close is pending confirmation");
  if (!input.actorMembershipId || input.actorMembershipId !== pending.nominee) {
    throw new ForbiddenError("only the nominated co-signer can confirm this close");
  }
  if (input.actorLiveRoleKeys === null) {
    throw new ForbiddenError("the co-signer must be an active member of this organization");
  }
  if (
    !input.actorRoles.includes(pending.nomineeRole) ||
    !input.actorLiveRoleKeys.includes(pending.nomineeRole)
  ) {
    throw new ForbiddenError(`confirming this close requires the ${pending.nomineeRole} role`);
  }
  return pending;
}

/** The pending-close projection both closure views expose (GAP-046), so a UI can show "awaiting <nominee>". */
export function pendingCloseView(row: {
  readonly closedAt: Date | null;
  readonly closureNomineeMembershipId: string | null;
  readonly closureCosignAttested: boolean;
}): { readonly closePending: boolean; readonly closeNomineeMembershipId: string | null } {
  const pending =
    row.closedAt === null && row.closureNomineeMembershipId !== null && !row.closureCosignAttested;
  return {
    closePending: pending,
    closeNomineeMembershipId: pending ? row.closureNomineeMembershipId : null,
  };
}

/** Validate the two-person close initiation; returns the two distinct, authorized signers or throws (403). */
export function resolveCloseCosigners(input: CloseCosignInput): CloseCosigners {
  const { actorMembershipId, cosignerMembershipId, cosignerRoleKeys, roles } = input;
  if (!input.recentStepUp) throw new StepUpRequiredError();
  if (!actorMembershipId) {
    throw new ForbiddenError("closing requires an authenticated membership");
  }
  if (cosignerMembershipId === actorMembershipId) {
    throw new ForbiddenError("the co-signer must be a distinct person from the closer");
  }
  if (cosignerRoleKeys === null) {
    throw new ForbiddenError("the co-signer must be an active member of this organization");
  }
  const [roleA, roleB] = roles;
  const complementOf = (role: string): string => (role === roleA ? roleB : roleA);
  const callerRole = roles.find(
    (role) => input.actorRoles.includes(role) && cosignerRoleKeys.includes(complementOf(role)),
  );
  if (callerRole) {
    return {
      first: actorMembershipId,
      second: cosignerMembershipId,
      callerRole,
      nomineeRole: complementOf(callerRole),
    };
  }
  if (!roles.some((role) => input.actorRoles.includes(role))) {
    throw new ForbiddenError(`closing requires the ${roleA} or ${roleB} role`);
  }
  throw new ForbiddenError(
    `the co-signer must hold the complementary role (${roleA} + ${roleB} are the two signers)`,
  );
}
