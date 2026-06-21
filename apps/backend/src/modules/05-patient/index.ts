// apps/backend/src/modules/05-patient — Module 5 (Patient & Demographics) backend surface,
// owned per module-manifest.ts codePath `apps/backend/src/modules/05-patient`. M5 has NO package —
// its code lives only here; the cross-module CONTRACTS (identifier strategy, outbox event names,
// PatientReader data shape) live in the leaf @wardenx/types (M5-T01, re-exported below).
//
// Build order (Wave C plan): T01 enums + layout + identifier strategy (this) → T02/T03/T04 schema
// (packages/db) → T05 RLS/audit/migration → T06 matching pipeline → T07 CaseloadProvider seam
// (closes the M3 boot-gate) → T08 PatientReader + PatientMutator seams → T09 routes + perm keys →
// T10 outbox/jobs/privacy-flag recompute/SUD enforcement → T11 M29 proposal consumer (deny-stub) +
// deceased cascade → T12 screens/audit/eraser/DR-INT/tests.
//
// DR/INT (ADR-0009): M5 is **DR Tier 1** — the patient master record is on the critical path for
// every clinical and billing workflow; a degradation blocks admissions and chart access.
export {
  PATIENT_IDENTIFIER_RULES,
  MBI_ALLOWED_LETTERS,
  M5_PATIENT_EVENT_NAMES,
  type PatientIdentifierKind,
  type PatientIdentifierRule,
  type M5PatientEventName,
  type PatientIdentity,
  type ExternalMrn,
} from "@wardenx/types";

// M5-T07/T08 — the three boot-gate seams: CaseloadProvider (§4.1, + caseload_membership predicate),
// PatientReader (§4.8, merge-redirect), PatientMutator (§4.9, D12 strip). registerPatientSeams closes
// all three for validateSeams().
export {
  type PatientSeamDeps,
  type CaseloadStore,
  type CaseloadSeamDeps,
  type SeedAssignment,
  type PatientReaderStore,
  type PatientMutatorStore,
  CASELOAD_MEMBERSHIP_PREDICATE,
  FORBIDDEN_PATCH_FIELDS,
  MAX_MERGE_HOPS,
  createCaseloadProvider,
  createInMemoryCaseloadStore,
  createPatientReader,
  createInMemoryPatientReaderStore,
  createPatientMutator,
  createInMemoryPatientMutatorStore,
  getCaseloadProvider,
  getPatientReader,
  getPatientMutator,
  registerPatientSeams,
} from "./seams/index";

// M5-T09 — the §4.2 route inventory behind requirePermission on the §4.7 keys + the route service.
export { type PatientRouteDeps, registerPatientRoutes } from "./routes/patient-routes";
export {
  type PatientRouteService,
  type AdmitInput,
  type AdmitResult,
  type PatientView,
  type AmendmentView,
  type InMemoryPatientSeed,
  createInMemoryPatientRouteService,
} from "./routes/service";

// M5-T10 — outbox events (§4.6), jobs (§4.5 geocode), privacy-flag recompute + SUD enforcement (§7.6).
export { M5_OUTBOX_EVENTS } from "./events-by-m5";
export {
  M5_QUEUES,
  M5_JOB_SCHEDULES,
  runGeocodeAddress,
  type M5QueueName,
  type GeocodeAddressPorts,
  type GeocodeResult,
} from "./jobs/index";
export {
  type PrivacyFlag,
  type ConsentSignal,
  type M39ConsentChangedPayload,
  type PrivacySnapshotPorts,
  SudConsentRequiredError,
  M39_CONSENT_CONSUMER_DEFERRED,
  recomputePrivacyFlags,
  isSudReadAllowed,
  assertSudReadAllowed,
  applyConsentChanged,
} from "./privacy/index";

// M5-T11 — the deceased cascade (§7.8) + the M29 proposal-accept consumer (§4.10, forward-seam/deny-stub).
export {
  DECEASED_CASCADE_TARGETS,
  InvalidDeceasedDateError,
  recordDeath,
  type DeceasedCascadePorts,
  type RecordDeathResult,
} from "./deceased";
export {
  M29_PROPOSAL_CONSUMER,
  M29_PROPOSAL_CONSUMER_DEFERRED,
  decideProposalApply,
  type ProposalAcceptedPayload,
  type ProposedPatientCandidate,
  type ProposalDecision,
} from "./outbox-consumers/m29-proposal-accepted";

// M5-T12 — the `clinical_record` destruction eraser (§8/§10, D7/D8). Screens DEFER (no apps/web
// codePath in the M5 manifest — the entity/admit/merge screens are tracked for the ADR-0030 UI
// follow-up). DR Tier 1 (the patient spine is on every clinical/billing critical path) — see
// M5_DR_INT_INVENTORY.md. The m5.patient.mutator_applied audit action ships in @wardenx/audit.
export {
  type PatientEraserDeps,
  type PatientEraseStore,
  type PatientEraseCounts,
  erasePatientClinicalRecord,
  createInMemoryPatientEraseStore,
  registerPatientErasers,
} from "./erasers/patient-eraser";
export { createDbPatientRouteService } from "./patient-route-service-db";

import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { createDbPatientRouteService as _dbPatientService } from "./patient-route-service-db";
import { registerPatientRoutes as _registerPatientRoutes } from "./routes/patient-routes";

/**
 * Mount the M5 patient REST routes (census list, chart-resolve, admit, addresses, amendments) on a
 * server (composition root, when a DB client is present). The READS (list / getPatient) run on the real
 * Drizzle PatientRouteService over `patient` under RLS; the WRITES are still in-memory (the Drizzle
 * admission store is a follow-up). Backs the Patient List/Census + the Patient Chart banner with real
 * data.
 */
export function mountPatientRoutes(app: FastifyInstance, db: DbClient): void {
  _registerPatientRoutes(app, { service: _dbPatientService(db) });
}
