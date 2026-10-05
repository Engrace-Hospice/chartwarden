// apps/backend/src/modules/33-reporting/jobs/snapshot-recipient-gate.ts — M33 scheduled-run recipient gate.
//
// Wraps the worker's `RecipientScopeValidationPort` so a recipient is dropped (and audited by the runner as
// lost-access) unless they are entitled to the rows the snapshot is rendered under. The snapshot scope is
// the same decision the snapshot builder makes (view owner an org admin => `org`, else `self`), so both go
// through `snapshotScopeKind`.
//
// BEHAVIOUR CHANGE — stricter than the interactive ladder: only `org_admin` is resolvable on a queue with
// no session (AdminMembershipReader). A `compliance_officer` recipient of an admin-owned org-scope
// snapshot is therefore DROPPED, although they could open that view interactively. This stays until the
// team/location scope work (a supervisor-resolution seam) lands; the error points toward less disclosure.
//
// Fail closed: any throw while resolving the owner or admin set drops the recipient (the runner audits it).
import type { RecipientScopeValidationPort } from "@wardenx/reporting";
import type { AdminMembershipReader } from "@wardenx/types";
import { snapshotRecipientAllowed, snapshotScopeKind } from "../routes/schedule-authz";

export interface SnapshotRecipientGateDeps {
  /** The view's owner membership (the identity the snapshot's scope is resolved from), or null if absent. */
  readonly findViewOwner: (reportViewId: string) => Promise<string | null>;
  /** ABSENT => nobody is an admin: scope narrows to `self` and only the owner is delivered to. */
  readonly adminMemberships?: AdminMembershipReader;
}

export function gateRecipientsBySnapshotScope(
  base: RecipientScopeValidationPort,
  deps: SnapshotRecipientGateDeps,
): RecipientScopeValidationPort {
  return {
    async isRecipientEntitled(membershipId, organizationId, reportViewId) {
      if (!(await base.isRecipientEntitled(membershipId, organizationId, reportViewId)))
        return false;
      try {
        const ownerMembershipId = await deps.findViewOwner(reportViewId);
        if (ownerMembershipId === null) return false;
        const admins = deps.adminMemberships
          ? await deps.adminMemberships.adminMembershipIds(organizationId)
          : new Set<string>();
        return snapshotRecipientAllowed({
          scopeKind: snapshotScopeKind(admins.has(ownerMembershipId)),
          ownerMembershipId,
          recipientMembershipId: membershipId,
          recipientIsAdmin: admins.has(membershipId),
        });
      } catch {
        return false;
      }
    },
  };
}
