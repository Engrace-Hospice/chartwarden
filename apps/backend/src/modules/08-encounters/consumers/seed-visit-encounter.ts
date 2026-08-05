// apps/backend/src/modules/08-encounters/consumers/seed-visit-encounter.ts — the M8 side of the M17
// visit-publication consumer (M8-T11, spec §4.7 / line 65). PURE DECISION CORE.
//
// M17 (Scheduling) owns the `visit` row and emits `m17.visit.published` after the pre-schedule gate.
// M8 subscribes: a scheduled visit SEEDS a draft `encounter` so the clinician opens an already-
// prepared note instead of creating one from scratch. The seed opens a draft only — authoring, vitals,
// finalize, and signing all happen through M8's own §2.3 lifecycle/routes; the consumer mints the draft
// row through the published `EncounterCreator` seam (§4.7) and never touches the encounter again.
//
// The live binding lives in ./../outbox-consumers/m17-visit-scheduled.ts. This PURE decision core remains
// useful for policy tests: given the parsed payload + the facts the worker
// reads (idempotency — is a draft already bracketing this visit; is the patient on active service), it
// returns the {@link VisitSeedingAction} descriptor the live worker executes through `EncounterCreator`.
// The consumed event name is a STRING literal only (no M17 schema import): M8 reads M17 solely through
// the foundation outbox, never via a `dependsOn` edge (§4 boundary rule), so M17 (17) is NOT in M8's
// `dependsOn`. The seed input is the leaf-typed {@link CreateEncounterInput} the seam already accepts.
import type {
  AdmissionId,
  CreateEncounterInput,
  EncounterDiscipline,
  EncounterType,
  LocalDate,
  MembershipId,
  PatientId,
  VisitId,
} from "@wardenx/types";

// ── The visit-published payload M8 consumes (M17 owns the canonical wire shape) ───────────────────────

/** The `m17.visit.published` payload subset M8 reads. M8 does not import M17 implementation types. */
export interface VisitPublishedPayload {
  readonly visitId: VisitId;
  readonly patientId: PatientId;
  readonly admissionId: AdmissionId;
  readonly organizationId: string;
  /** The encounter type the scheduled visit implies (routine_visit, face_to_face, volunteer_visit, …). */
  readonly encounterType: EncounterType;
  /** The discipline of the clinician the visit is assigned to (stamped on the draft). */
  readonly assignedDiscipline: EncounterDiscipline;
  /** The scheduled service date (the draft's `serviceDate`; D11 vocab is pinned later, at sign). */
  readonly serviceDate: LocalDate;
  /** The membership the visit is assigned to — becomes the draft's author. */
  readonly assignedMembershipId: MembershipId;
}

/** @deprecated Use the canonical visit-publication contract name. */
export type VisitScheduledPayload = VisitPublishedPayload;

// ── The facts the worker reads before deciding (resolved by the live consumer from M8 + M6 reads) ─────

/** Everything the worker must read before it can decide, surfaced as data so {@link decideVisitSeeding}
 * stays pure. The Wave-F consumer resolves these from M8's own `encounter` table (a draft already
 * bracketing `visitId` → idempotent) and the M6 `AdmissionStatusReader` seam (patient on active service). */
export interface VisitSeedingFacts {
  /** A draft `encounter` already brackets this `visitId` — a redelivery is a no-op (idempotent). */
  readonly alreadySeeded: boolean;
  /** The admission is active (patient on service) — authoring is only possible on an active admission. */
  readonly patientOnService: boolean;
}

// ── The effect descriptor the decider returns (executed by the Wave-F consumer) ───────────────────────

/** Why a `m17.visit.published` delivery seeded nothing (audited for reconciliation, never a hard error). */
export type VisitSeedingSkipReason = "already_seeded" | "patient_not_on_service";

/** The effect the worker resolved for a delivery: either a no-op skip (with reason) or seed a draft. */
export type VisitSeedingAction =
  /** A redelivery (draft exists) or a non-active admission — skip, audit the reason, no encounter minted. */
  | { readonly kind: "skip"; readonly reason: VisitSeedingSkipReason }
  /** The happy path — open a draft encounter through the `EncounterCreator` seam with these fields. */
  | { readonly kind: "seed"; readonly input: CreateEncounterInput };

// ── The pure decision core (§4.7 / line 65) ───────────────────────────────────────────────────────────

/**
 * Decide the single effect to apply for an `m17.visit.published` delivery (pure). The worker resolves
 * {@link VisitSeedingFacts}, then this returns the {@link VisitSeedingAction}. Idempotency is checked
 * first (a draft already bracketing the visit → skip), then the active-service guard (authoring requires
 * an active admission per §0 "the patient-on-service signal that makes encounter authoring possible");
 * the surviving delivery becomes a {@link CreateEncounterInput} seed carrying the visit's `visitId`.
 */
export function decideVisitSeeding(
  payload: VisitPublishedPayload,
  facts: VisitSeedingFacts,
): VisitSeedingAction {
  // Idempotent on visitId: a draft already brackets this visit (a redelivery) — seed nothing.
  if (facts.alreadySeeded) return { kind: "skip", reason: "already_seeded" };

  // Authoring is only possible while the admission is active (patient on service) — defer otherwise.
  if (!facts.patientOnService) return { kind: "skip", reason: "patient_not_on_service" };

  return {
    kind: "seed",
    input: {
      patientId: payload.patientId,
      admissionId: payload.admissionId,
      encounterType: payload.encounterType,
      discipline: payload.assignedDiscipline,
      serviceDate: payload.serviceDate,
      authorMembershipId: payload.assignedMembershipId,
      visitId: payload.visitId,
    },
  };
}
