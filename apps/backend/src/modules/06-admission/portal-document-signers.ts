// M06 ADR-0107 (PROPOSED) — the portal sign seam for the Election Statement and the Notice of Patient Rights. M31's
// `AdmissionDocumentSigners.election / noticeOfRights` ports are bound to these at the composition root.
//
// Idempotent, because M06 and M31's request update are separate transactions: if the statement is already `signed` (or the notice already
// acknowledged) the existing record id is returned and nothing is signed twice. A signed election cannot be re-signed anyway
// (`drafted → signed` only), so this is the retry path after a crash between the two commits, not a way around R-EL-01 / R-EL-04: a fresh
// signature still goes through `signElection` and every M06 rule.
//
// The election records the PATIENT's name at signing (§418.24(b)(1)), never the signer's, so the name is resolved from the patient.
import type { AdmissionRouteService } from "./routes/service";

type SignerRole = "patient" | "legal_representative" | "caregiver_on_behalf";

export interface PortalAdmissionSignerDeps {
  readonly service: Pick<
    AdmissionRouteService,
    "getElectionStatement" | "signElection" | "getNor" | "acknowledgeNor"
  >;
  /** The patient's name as it should print on the statement; null when the patient cannot be read. */
  readonly readPatientName: (organizationId: string, patientId: string) => Promise<string | null>;
  readonly nowIso: () => string;
}

// M06's election role vocabulary has no "caregiver on behalf"; a non-patient signer is a representative for §418.24(b)(1) (see
// SIGNER_KIND_BY_ROLE). The portal request keeps the caregiver evidence; the matrix already denies a caregiver the election.
const ELECTION_ROLE = {
  patient: "patient",
  legal_representative: "legal_representative",
  caregiver_on_behalf: "caregiver",
} as const;
const NOR_ROLE = {
  patient: "patient",
  legal_representative: "legal_representative",
  caregiver_on_behalf: "legal_representative",
} as const;

/** The portal acts as no staff member, so both M06 calls get an empty actor id (the evidence row's created-by stays null). */
const PORTAL_ACTOR = "";

export function createPortalAdmissionSigners(deps: PortalAdmissionSignerDeps) {
  return {
    async election(input: {
      organizationId: string;
      electionStatementId: string;
      patientId: string;
      signerRole: SignerRole;
      signerName: string;
      signatureMethod: "electronic_portal";
    }): Promise<{ recordId: string }> {
      const current = await deps.service.getElectionStatement(
        input.organizationId,
        input.electionStatementId,
      );
      if (!current) throw new Error("election statement not found");
      if (current.state === "signed") return { recordId: current.id };
      const patientName = await deps.readPatientName(input.organizationId, input.patientId);
      if (!patientName) throw new Error("patient name unavailable for the election statement");
      const r = await deps.service.signElection(
        input.organizationId,
        current.id,
        current.version,
        PORTAL_ACTOR,
        {
          signingPatientName: patientName,
          signingRole: ELECTION_ROLE[input.signerRole],
          signatureMethod: input.signatureMethod,
        },
      );
      return { recordId: r.id };
    },

    async noticeOfRights(input: {
      organizationId: string;
      admissionId: string;
      signerRole: SignerRole;
      signerName: string;
      deliveryMethod: "electronic_portal";
    }): Promise<{ recordId: string }> {
      const existing = await deps.service.getNor(input.organizationId, input.admissionId);
      if (existing) return { recordId: existing.id };
      await deps.service.acknowledgeNor(
        input.organizationId,
        input.admissionId,
        {
          deliveryMethod: input.deliveryMethod,
          acknowledgedByRole: NOR_ROLE[input.signerRole],
          acknowledgedByName: input.signerName,
          acknowledgedAt: deps.nowIso(),
        },
        PORTAL_ACTOR,
      );
      const created = await deps.service.getNor(input.organizationId, input.admissionId);
      if (!created) throw new Error("notice of rights acknowledgment was not recorded");
      return { recordId: created.id };
    },
  };
}
