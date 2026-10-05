// apps/backend/src/modules/30-quality/routes/close-cosign.ts — GAP-088: the service-layer two-person guard for
// the QAPI PIP close (R-31, V-11) and the SRA cycle close (R-47, V-12).
//
// SPEC (docs/modules/WARDENX_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md): D12 (line 3576) — SRA close = Security
// Officer + Compliance Officer, PIP close = QAPI Coordinator + Medical Director, "distinct individuals",
// enforced at the application layer AND the DB; §4.7 (lines 2106/2108) — the caller holds one role of the
// pair and the SECOND co-signer holds the OTHER; line 3804 — both closes require a recent step-up.
//
// NOMINEE-BASED ONE-STEP CLOSE (decision on GAP-088): the nominee never authenticates in this request, so
// only the CLOSER (`actor.membershipId`) is a signer. The other party is a `nominatedCosigner` — validated as
// an eligible person but NOT recorded as having attested (`cosignerAttested: false`, see
// `buildCloseAttestation`). A pending-close + nominee-confirmation flow (the nominee signs in their own
// session) is the logged follow-up; until then no field/label may present the nominee as a signer.
//
// The FIRST signer is the authenticated caller (`actor.membershipId`, server-assembled) — it is never read
// off the wire. The SECOND signer is the only id the body supplies, and it is validated here against facts
// the service loads inside its own org-scoped tx (`cosignerRoleKeys`: `null` ⇒ not an ACTIVE membership of
// this org). The route composes the same rule as a `requireAbac` preHandler; this guard repeats it so a
// worker/other caller of the service cannot bypass the route.
import { ForbiddenError, StepUpRequiredError } from "@wardenx/types";
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

/** Who is recorded for a close: the closer signed; the nominee did NOT (nominee-based one-step close). */
export interface CloseAttestation {
  readonly closedBy: { readonly membershipId: string; readonly role: string };
  readonly nominatedCosigner: { readonly membershipId: string; readonly role: string };
  /** Always `false` today: the nominee does not authenticate in the one-step close. */
  readonly cosignerAttested: false;
}

/** The honest closure record: the closer is the signer, the second party is only a nominee. */
export function buildCloseAttestation(signers: CloseCosigners): CloseAttestation {
  return {
    closedBy: { membershipId: signers.first, role: signers.callerRole },
    nominatedCosigner: { membershipId: signers.second, role: signers.nomineeRole },
    cosignerAttested: false,
  };
}

/** Validate the two-person close; returns the two distinct, authorized signers or throws (403). */
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
