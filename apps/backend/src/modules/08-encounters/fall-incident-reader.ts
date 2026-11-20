// apps/backend/src/modules/08-encounters/fall-incident-reader.ts — M8's read of a patient's recorded falls (WF09).
//
// M30 (Quality) owns the incident register and publishes it through the `IncidentRegisterProvider` seam. M8 reads it there: no M30 import,
// no table access. The seam's own interface lives in `@chartwarden/quality`, so it is typed `unknown` in the M1 registry and narrowed
// here to the one call and the three fields M8 uses. A narrative, a witness or any other part of the report is never read.
import { getSeam } from "../../bootstrap/index";
import type { FallIncidentReader } from "./routes/fall-link";

interface IncidentRegisterSeam {
  listIncidents(
    organizationId: string,
    filter: {
      readonly kinds: readonly string[];
      readonly patientId: string;
      readonly occurredAfter: string;
    },
    actor: { readonly actorId: string; readonly permissions: readonly string[] },
  ): Promise<
    readonly { readonly id: string; readonly occurredAt: Date; readonly severity: string }[]
  >;
}

/** The production reader: M30's incident register through the M1 seam registry, resolved per call so a late-wired seam is picked up. */
export const seamFallIncidentReader: FallIncidentReader = {
  async recentFalls({ organizationId, patientId, actorMembershipId, occurredAfter }) {
    const register = getSeam("IncidentRegisterProvider") as unknown as IncidentRegisterSeam;
    const incidents = await register.listIncidents(
      organizationId,
      { kinds: ["fall"], patientId, occurredAfter: occurredAfter.toISOString() },
      { actorId: actorMembershipId ?? "", permissions: [] },
    );
    return incidents.map((i) => ({
      incidentId: i.id,
      occurredAt: i.occurredAt,
      severity: i.severity,
    }));
  },
};
