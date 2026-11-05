// M06 ADR-0107 (PROPOSED) — "may this M06 record be sent to the patient for portal signature?", asked when staff create the request so a wrong
// target fails at send time instead of when the patient tries to sign. M31's staff routes are bound to this at the composition root.
//   election_statement        — the id of a statement that is still `drafted` and belongs to THIS patient
//   notice_of_patient_rights  — the id of an admission of THIS patient whose notice has not been acknowledged
// Every "no" is the same boolean (absent, another patient's, already signed): nothing about the other record is disclosed.
import type { AdmissionRouteService } from "./routes/service";

type TargetService = Pick<
  AdmissionRouteService,
  "getElectionStatement" | "getAdmission" | "getNor"
>;
/** The admission-scope resolver's election lookup: the patient a statement belongs to (a statement carries no patient id of its own). */
interface ElectionScope {
  loadElectionStatementScope(
    organizationId: string,
    id: string,
  ): Promise<{ readonly patientId: string } | null>;
}

export function createPortalSigningTargetCheck(service: TargetService, electionScope: ElectionScope) {
  return async (input: {
    readonly organizationId: string;
    readonly docKind: "election_statement" | "notice_of_patient_rights";
    readonly patientId: string;
    readonly targetRef: string;
  }): Promise<boolean> => {
    const { organizationId, patientId, targetRef } = input;
    if (input.docKind === "election_statement") {
      const [statement, scope] = await Promise.all([
        service.getElectionStatement(organizationId, targetRef),
        electionScope.loadElectionStatementScope(organizationId, targetRef),
      ]);
      return statement?.state === "drafted" && scope?.patientId === patientId;
    }
    const admission = await service.getAdmission(organizationId, targetRef);
    if (!admission || admission.patientId !== patientId) return false;
    return (await service.getNor(organizationId, targetRef)) === null;
  };
}
