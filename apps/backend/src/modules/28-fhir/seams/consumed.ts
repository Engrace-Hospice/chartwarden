// apps/backend/src/modules/28-fhir/seams/consumed.ts — the seams M28 CONSUMES (§4.4, M28-T06).
//
// M28 owns no clinical PHI (§1.2): every FHIR resource is composed at read time from an OWNER module's
// data, reached through the M1 boot-registered seam registry — never a direct schema import (architecture
// §25.15; the dependency-cruiser boundary check blocks any `import` from a non-listed code path). Resolving
// through `getSeam` is why M28's manifest `dependsOn` carries M1 (the registry lives in
// `apps/backend/src/bootstrap`, which is M1 code); no other consumed module needs an edge, because the
// binding is runtime.
//
// ── THREE FLAVOURS, ONE RULE (fail CLOSED on an unbound upstream) ────────────────────────────────────
//
//   · LEAF-TYPED readers (M5/M7/M8/M11/M12/M13) — `getSeam` returns the real typed contract directly.
//   · OPAQUE rich-seams (M38/M39/M40 + M32's prompt registry) — their interfaces live in feature packages
//     this app-module may not import, so each is resolved to M28's OWN minimal consumer VIEW (the M27/M30
//     precedent) rather than importing the producer. The T05 egress gate + AI-block validator declared
//     their ports LOCAL in `@wardenx/fhir` precisely so this task binds them here.
//   · FORWARD-seams (M23 `ClaimReader`, M29 `LabObservationReader`) — required so a boot without the owner
//     module fails CLOSED. Both stay on the M1 deny-stub the whole of Phase 1: the Claim/EOB routes
//     short-circuit to 404 (§7.7, W-FHIR-07) before reaching `ClaimReader`, and the DiagnosticReport
//     projection refuses at egress until M29 registers `LabObservationReader`.
import type {
  FhirAiPromptRegistryPort,
  FhirDisclosureConsentEvaluator,
  LabObservationReader as FhirLabObservationReaderView,
} from "@wardenx/fhir";
import type {
  BillableEncounterReader,
  CarePlanReader,
  ElectionPeriodReader,
  MedicationAdministrationProvider,
  MedicationOrderProvider,
  OrderProvider,
  PatientReader,
  ReconciliationProvider,
  SignedEncountersReader,
} from "@wardenx/types";

import { getSeam } from "../../../bootstrap/index";

// ── leaf-typed reader accessors (§4.4) ──────────────────────────────────────────────────────────────
//
// `getSeam` is statically typed against `SeamContracts`, so each of these returns the real producer
// contract with no cast. They resolve to the M1 fail-closed deny-stub until the owner module registers
// its live impl (the FHIR mapper that calls one gets a LOUD `NotImplementedError`, never a silent empty).

/** M5 — the patient identity/demographics read the `Patient` projection + `?patient=:id` search read. */
export function getFhirPatientReader(): PatientReader {
  return getSeam("PatientReader");
}

/** M6 — the election/benefit-period read the `Coverage` / `Encounter` projections read. */
export function getFhirElectionPeriodReader(): ElectionPeriodReader {
  return getSeam("ElectionPeriodReader");
}

/** M7 — the care-plan read the `CarePlan` / `Goal` projections read. */
export function getFhirCarePlanReader(): CarePlanReader {
  return getSeam("CarePlanReader");
}

/** M8 — the signed-encounter digest read the `Encounter` projection reads. */
export function getFhirSignedEncountersReader(): SignedEncountersReader {
  return getSeam("SignedEncountersReader");
}

/** M8 — the per-encounter billability read the `Encounter` billing extension reads. */
export function getFhirBillableEncounterReader(): BillableEncounterReader {
  return getSeam("BillableEncounterReader");
}

/** M11 — the order read the `DiagnosticReport` metadata (D19) + Phase-2 `ServiceRequest` project from. */
export function getFhirOrderProvider(): OrderProvider {
  return getSeam("OrderProvider");
}

/** M12 — the medication-order read the `MedicationRequest` / `MedicationStatement` projections read. */
export function getFhirMedicationOrderProvider(): MedicationOrderProvider {
  return getSeam("MedicationOrderProvider");
}

/** M13 — the administration read the `MedicationAdministration` projection reads. */
export function getFhirMedicationAdministrationProvider(): MedicationAdministrationProvider {
  return getSeam("MedicationAdministrationProvider");
}

/** M13 — the reconciliation read the `MedicationStatement` reconciliation extension reads. */
export function getFhirReconciliationProvider(): ReconciliationProvider {
  return getSeam("ReconciliationProvider");
}

// ── opaque rich-seams — resolved to M28's own minimal consumer views ─────────────────────────────────

/**
 * §8.5 — the M38 `TerminologyProvider` slice M28's mappers use to validate a code before it enters a
 * `CodeableConcept`, and that R13 `CodeSystem/$validate-code` answers from. M38's rich interface lives in
 * `@wardenx/terminology` (not importable here); this is M28's minimal view.
 *
 * IT MUST MATCH THE REAL METHOD. This view used to declare `validateCode({ system, code })`, a method
 * `TerminologyProvider` has never had — the real one is `validate(system, code, asOf?)`. A structural view
 * over a seam resolved with `as` is only as true as the shape it asserts; nothing type-checks it against
 * the provider, so the mismatch would have surfaced as a runtime `not a function` on the first call. It
 * survived because there was no first call: the view was declared, exported, and used by nobody (#117).
 */
export interface FhirTerminologyView {
  /** `system` is an M38 `CodeSystemId` (`icd10cm`, `loinc`, …), never a FHIR canonical URI. */
  validate(system: string, code: string, asOf?: Date): Promise<{ valid: boolean; status?: string }>;
}

/** Resolve M38's terminology provider as M28's view. */
export function getFhirTerminologyProvider(): FhirTerminologyView {
  return getSeam("TerminologyProvider") as FhirTerminologyView;
}

/**
 * §4.11.2 — the M40 master-data slice a `Practitioner` / `PractitionerRole` / `Organization` reference is
 * resolved through. M40's rich `MdmEntityProvider` lives in `@wardenx/mdm`; this is M28's minimal view —
 * "does this canonical entity exist for this tenant?", which is all a FHIR reference-target check needs.
 */
export interface FhirMdmEntityView {
  resolveEntity(input: {
    organizationId: string;
    kind: string;
    id: string;
  }): Promise<{ id: string } | null>;
}

/** Resolve M40's MDM provider as M28's reference-target view. */
export function getFhirMdmEntityProvider(): FhirMdmEntityView {
  return getSeam("MdmEntityProvider") as FhirMdmEntityView;
}

/**
 * §7.7 — the M40 BAA disclosure gate M28 consults, as-of the disclosure instant, before ANY PHI leaves
 * the perimeter (D3 companion to the SUD consent gate). M40's rich `BaaStatusProvider` lives in
 * `@wardenx/mdm`; this is M28's minimal "is a signed BAA in force right now?" view.
 */
export interface FhirBaaStatusView {
  isBaaActive(input: {
    organizationId: string;
    contractReference: string;
    asOf: string;
  }): Promise<boolean>;
}

/** Resolve M40's BAA status gate as M28's view. */
export function getFhirBaaStatusProvider(): FhirBaaStatusView {
  return getSeam("BaaStatusProvider") as FhirBaaStatusView;
}

/**
 * The M39 `ConsentEvaluator` disclosure port the T05 egress gate consults per resource (W-FHIR-03/D3).
 *
 * The real M39 evaluator (`@wardenx/consent`) returns a SUPERSET (HIV/MH/genetic/family-violence flags too)
 * and requires a `callerModule`; this adapter narrows it to the FHIR Phase-1 egress port
 * (`FhirDisclosureConsentEvaluator`, LOCAL in `@wardenx/fhir`), which governs only the 42 CFR Part 2 SUD
 * zone, and pins `callerModule: "m28"` so the §164.528 accounting on M39's side names the FHIR gateway.
 */
interface M39ConsentDisclosurePort {
  evaluateForDisclosure(args: {
    organizationId: string;
    patientId: string;
    recipientClientId?: string;
    asOf?: string;
    callerModule: string;
  }): Promise<{ allowed: boolean; redactSudContent: boolean }>;
}

/** Resolve M39's consent evaluator as the T05 egress gate's disclosure port. */
export function getFhirDisclosureConsentEvaluator(): FhirDisclosureConsentEvaluator {
  const evaluator = getSeam("ConsentEvaluator") as M39ConsentDisclosurePort;
  return {
    async evaluateForDisclosure(args) {
      const decision = await evaluator.evaluateForDisclosure({
        organizationId: args.organizationId,
        patientId: args.patientId,
        ...(args.recipientClientId === undefined
          ? {}
          : { recipientClientId: args.recipientClientId }),
        ...(args.asOf === undefined ? {} : { asOf: args.asOf }),
        callerModule: "m28",
      });
      return { allowed: decision.allowed, redactSudContent: decision.redactSudContent };
    },
  };
}

/**
 * The M32 `AIPromptRegistry` slice the T05 AI-block boot validator queries (W-FHIR-11/D14). M32-T05 wired
 * `getActivePromptsTargeting("fhir")` for exactly this consumer; the real registry is a superset of the
 * LOCAL `FhirAiPromptRegistryPort` M28 declared, so a direct structural cast binds it. Its M1 deny-stub
 * THROWS (an unwired registry answering `[]` would hand M28's boot a clean bill of health minted from
 * nothing), which is the fail-closed direction the boot validator relies on.
 */
export function getFhirAiPromptRegistry(): FhirAiPromptRegistryPort {
  return getSeam("AIPromptRegistry") as FhirAiPromptRegistryPort;
}

// ── forward-seams (fail CLOSED the whole of Phase 1) ─────────────────────────────────────────────────

/**
 * §4.4 / §7.7 — the M23 Claim/ClaimResponse/EOB FHIR projection (W-FHIR-07). `fhir.write` is OFF, so the
 * Claim/EOB routes return 404 (§7.7) BEFORE reaching this seam; the accessor exists so the day M23's D1
 * unlock lands, the route body binds a live reader with no registration change. M28's minimal view is a
 * single-resource read; the real M23 reader (`@wardenx/billing`) is a superset.
 */
export interface FhirClaimReaderView {
  findClaim(organizationId: string, claimId: string): Promise<{ id: string } | null>;
}

/** Resolve the M23 Claim FHIR forward-seam as M28's view (deny-stub throws until M23's D1 unlock). */
export function getFhirClaimReader(): FhirClaimReaderView {
  return getSeam("ClaimReader") as FhirClaimReaderView;
}

/**
 * §4.11.4 — the M29 `LabObservationReader` the `DiagnosticReport` projection reads its result values from.
 * M29 is a Phase-1 placeholder, so this stays on the fail-closed deny-stub and the DiagnosticReport
 * projection refuses at egress until M29 registers the real reader. M28's expected shape is the LOCAL
 * `LabObservationReader` its T04 projector was typed against (`@wardenx/fhir`).
 */
export function getFhirLabObservationReader(): FhirLabObservationReaderView {
  return getSeam("LabObservationReader") as unknown as FhirLabObservationReaderView;
}
