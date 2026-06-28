// apps/backend/src/modules/23-billing-medicare/services/boot-assembly.ts — the boot-time CLAIM-ASSEMBLY
// service the composition root binds into `mountM23Routes` (route #1 `POST /claims/assemble`).
//
// The real {@link buildClaimAssemblyService} depends on the full §4.4 CONSUMED reader-seam bundle
// (M5 patient-payer / M6 admission+election+cert+F2F+LOC / M8 billable+signed encounters / M18 EVV /
// M38 terminology / M40 MDM / the platform reference-data ports). Those cross-module seams are NOT members
// of the M1 SeamRegistry yet (M23's seam names are not in `SeamContracts`), so they cannot be resolved at
// boot. Per RULE 4 (fail-closed-unbound) we therefore bind a service whose reader seams are DENY-STUBS that
// throw a typed `SEAM_UNBOUND` (503) only when an assemble request actually runs — boot stays green, and the
// route never silently fabricates a claim from absent clinical facts. The pure rule registry (no I/O) is the
// real frozen platform-default registry so the service is otherwise fully constructed.
//
// When the M23 reader seams land in the M1 SeamRegistry (a foundation change, outside this slice), the
// composition root swaps this for `buildClaimAssemblyService(db, <live seams>)` — the route contract is
// unchanged. The same outbox publisher the write service uses is threaded in so a future live bundle commits
// the §4.10 `m23.claim.draft_created` emit in the assemble transaction (D2).
import { createDefaultBillingRegistry, repositories } from "@wardenx/billing";
import { WardenXError } from "@wardenx/types";

import {
  type AssemblyOutboxPort,
  type ClaimAssemblySeams,
  type ClaimAssemblyService,
  buildClaimAssemblyService,
} from "./claim-assembly";

type BillingDb = repositories.BillingDb;

/** Throw the typed fail-closed error every unbound assembly reader raises at call time (RULE 4). */
function unbound(seam: string): never {
  throw new WardenXError(
    "SEAM_UNBOUND",
    `M23 claim-assembly seam '${seam}' is not bound at boot — claim assembly is unavailable until the M5/M6/M8/M18/M38/M40 reader seams register in the M1 SeamRegistry`,
    503,
  );
}

/**
 * Build the boot-time claim-assembly service over the RLS-enforced primary `db`. Every cross-module reader
 * seam is a fail-closed deny-stub (throws `SEAM_UNBOUND` at call time); the rule registry is the real frozen
 * platform-default registry. The optional `outbox` threads the catalog-validating tx publisher through for a
 * future live bundle (the deny-stub readers throw before the emit is reached today).
 */
export function buildM23BootAssemblyService(
  db: BillingDb,
  ports: { readonly outbox?: AssemblyOutboxPort } = {},
): ClaimAssemblyService {
  const outbox: AssemblyOutboxPort =
    ports.outbox ?? {
      async publish() {
        unbound("AssemblyOutboxPort");
      },
    };

  const seams: ClaimAssemblySeams = {
    patientPayer: { medicarePrimaryForRange: () => unbound("PatientPayerReader") },
    admission: { resolveForRange: () => unbound("AdmissionContextReader") },
    electionPeriods: { coveringRange: () => unbound("ElectionPeriodReader") },
    certifications: { forPatient: () => unbound("CertificationReader") },
    faceToFace: { forPatient: () => unbound("FaceToFaceReader") },
    levelOfCare: { periodsInRange: () => unbound("LevelOfCareReader") },
    billableEncounters: { forRange: () => unbound("BillableEncounterReader") },
    signedEncounters: { inWindow: () => unbound("SignedEncountersReader") },
    evvCompliance: { bracketsForEncounters: () => unbound("EvvComplianceReader") },
    mdm: {
      resolveProviderEntity: () => unbound("MdmEntityProvider"),
      resolveClinicalParticipants: () => unbound("MdmEntityProvider"),
    },
    terminology: { resolveForClaim: () => unbound("TerminologyProvider") },
    referenceData: {
      hippsRateTable: () => unbound("BillingReferenceDataReader"),
      chcHourlyRateCents: () => unbound("BillingReferenceDataReader"),
      wageIndexForCcn: () => unbound("BillingReferenceDataReader"),
      activeSequestrationPolicy: () => unbound("BillingReferenceDataReader"),
    },
    ruleRegistry: createDefaultBillingRegistry(),
    outbox,
  };

  return buildClaimAssemblyService(db, seams);
}
