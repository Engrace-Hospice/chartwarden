// apps/backend/src/modules/17-scheduling/credential-grant-guard.ts — the guards on the professional-licence roster's write routes
// (CW-AC-46 follow-up).
//
// WHY. `membership_credential` is the fact the visit-create credential gate (M17 D8) trusts, and the one the HOPE signer-licence
// check (CW-AC-46, #1206, through the `CredentialReader` seam) reads. Its grant route used to need only `membership_credential.grant`, so a
// holder could record a licence on their OWN membership and then act on it. Two controls close that, and both live here so the route
// and the store cannot drift:
//
//   1. a fresh step-up on the grant and the revoke (`CREDENTIAL_STEP_UP_KEY`, mounted as `requireStepUp` by the route; the
//      operation key lets a tenant tighten its freshness window), and
//   2. no self-grant: the target membership may not be the caller's own (403 CREDENTIAL_SELF_GRANT_REFUSED). A DIFFERENT membership
//      holding the permission can record it. That is the decision this file records: one other membership, not a second approver
//      (it cannot tell two accounts of one person apart: the roster has no identity proofing). The grant row carries
//      `granted_by_membership_id`, the grant is audited by the M4 row trigger, and a refused attempt writes
//      `m17.credential.self_grant_refused` (reviewed by CW-MON-01). A pending-then-approved grant (a four-eyes workflow, which
//      would defeat two colluding permission holders) is a new table and routes: it stays the register's remainder.
//
// The route refuses and audits; the Drizzle credential store (the one place the row is written) refuses again as the backstop.
// A revoke of one's own licence is NOT refused: it only removes a fact.
import { type AuditContext, audit } from "@chartwarden/audit";
import type { DbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError } from "@chartwarden/types";

/** The step-up operation key of the grant and the revoke (a tenant can tighten its freshness window per key). */
export const CREDENTIAL_STEP_UP_KEY = "membership_credential.manage";
/** The code of a refused self-grant: 403 in the standard envelope, distinct from FORBIDDEN so a client can word it. */
export const CREDENTIAL_SELF_GRANT_REFUSED_CODE = "CREDENTIAL_SELF_GRANT_REFUSED";
/** The explicit audit event of a refused self-grant (packages/audit/src/actions/m17.ts). */
export const CREDENTIAL_SELF_GRANT_AUDIT_EVENT = "m17.credential.self_grant_refused";

const HTTP_FORBIDDEN = 403;
const MEMBERSHIP_RESOURCE_KIND = "membership";

/** True when the membership the licence is recorded on is the caller's own. Ids are compared case-insensitively (uuid text). */
export function isCredentialSelfGrant(
  actorMembershipId: string,
  targetMembershipId: string,
): boolean {
  return actorMembershipId.toLowerCase() === targetMembershipId.toLowerCase();
}

/** The typed refusal: a code, a message that names the remedy, no id and no echo of the request. */
export function credentialSelfGrantRefusal(): ChartWardenError {
  return new ChartWardenError(
    CREDENTIAL_SELF_GRANT_REFUSED_CODE,
    "You cannot record a professional licence on your own membership. Ask another administrator to record it.",
    HTTP_FORBIDDEN,
  );
}

export interface SelfGrantRefusalFacts {
  readonly organizationId: string;
  /** The caller's membership (the refused grantor, and the target). */
  readonly membershipId: string;
  /** The closed `credential_discipline` enum value the caller tried to record. */
  readonly credentialType: string;
}

/**
 * Write the refusal's audit event on its OWN transaction: the refused request wrote nothing, so there is no transaction to
 * ride. Ids and the closed discipline enum only. Throws when the write fails: the CALLER decides that a failed audit write is
 * reported and never replaces the refusal (the route logs the error class and still answers 403).
 */
export async function recordCredentialSelfGrantRefusal(
  db: DbClient,
  auditContext: AuditContext,
  facts: SelfGrantRefusalFacts,
): Promise<void> {
  await withOrgContext(
    db,
    { organizationId: facts.organizationId, userId: facts.membershipId },
    (tx) =>
      audit(tx as unknown as DbClient, auditContext, {
        eventType: CREDENTIAL_SELF_GRANT_AUDIT_EVENT,
        resourceKind: MEMBERSHIP_RESOURCE_KIND,
        resourceId: facts.membershipId,
        outcome: "denied",
        severity: "warn",
        retentionClass: "compliance",
        context: {
          denial: CREDENTIAL_SELF_GRANT_REFUSED_CODE,
          membershipId: facts.membershipId,
          credentialType: facts.credentialType,
        },
      }),
  );
}
