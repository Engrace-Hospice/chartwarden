// apps/backend/src/modules/20-field-safety/sos-recipient-count.ts — GAP-060: the `recipientCountFor` port of the
// M20 write service (`RaiseSosResponse.acknowledgersDispatched`).
//
// The count is the DISTINCT delivery targets of M20's own §4.3 supervisor registry (vacation forwarding applied,
// exactly as the §4.5 composed resolver does). It is a FLOOR: the D14 on-call parallel set is not added. So `0`
// is never answered — a floor of zero is "we could not confirm anyone", which the mobile client renders as the
// D15 `tel:` direct-dial fallback via `null`, not as a genuine coverage gap the tenant caused. An unreadable
// registry THROWS and the write service maps that to `null` the same way.
import type { MembershipId, OrgId } from "@chartwarden/types";
import { deliveryMembershipsFor } from "./alert-rules";

interface SupervisorRow {
  readonly supervisorMembershipId: MembershipId;
  readonly isVacationForwarded: boolean;
  readonly vacationForwardToMembershipId: MembershipId | null;
}

export interface SosRecipientCountPorts {
  supervisorsForClinician(
    orgId: OrgId,
    clinicianMembershipId: MembershipId,
    alertKind: "sos",
  ): Promise<readonly SupervisorRow[]>;
}

export interface SosRecipientCountInput {
  readonly organizationId: string;
  readonly clinicianMembershipId: string;
  readonly providerEntityId: string;
  readonly atIso: string;
}

export function createSosRecipientCounter(
  ports: SosRecipientCountPorts,
): (input: SosRecipientCountInput) => Promise<number | null> {
  return async (input) => {
    const supervisors = await ports.supervisorsForClinician(
      input.organizationId as OrgId,
      input.clinicianMembershipId as MembershipId,
      "sos",
    );
    const count = deliveryMembershipsFor(supervisors).length;
    return count > 0 ? count : null;
  };
}
