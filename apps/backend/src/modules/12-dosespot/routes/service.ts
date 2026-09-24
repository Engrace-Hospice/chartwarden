// apps/backend/src/modules/12-dosespot/routes/service.ts — M12-T08 the §4.1 route service over an in-memory
// backend (the M8-T09 / M9-T05 / M10-T06 / M11-T06 in-mem-slice precedent; Drizzle in prod under
// `withOrgContext` so RLS backstops every read). The service composes the PURE M12 domain (`@wardenx/dosespot`):
// the §2.2 D2 medication-order lifecycle machine (`transitionMedicationOrder`), the §2.7 D9 refill-inbox
// machine (`transitionRefillRequest` / `buildRefillMintFacts`), and the §2.1 `MED_CLASS_CATALOG` / `isEpcsRequired`
// EPCS routing. Every state change records the §4.4 outbox event the relay publishes (drainable for tests).
//
// It "binds" the §4.1 cross-module surfaces through INJECTED validators (the M38 `TerminologyProvider` for the
// RxNorm/NDC code on the order, the M40 `MdmEntityProvider` for the prescribing physician + dispensing pharmacy
// + the prescriber's DEA roster, the M39 `ConsentEvaluator` for the §7.8 SUD-treatment-medication consent
// gate). All are resolved from the M1 seam registry at boot (seams/index.ts) and injected here; when absent
// (the in-mem slice default) the binding is skipped so the write path never blocks on an external dependency
// (the M10 §7.13 fail-open convention).
import {
  MED_CLASS_CATALOG,
  isEpcsRequired,
  transitionMedicationOrder,
  transitionRefillRequest,
  validateMedicationOrderData,
} from "@wardenx/dosespot";
import type {
  DeaSchedule,
  MedClass,
  MedicationOrderDiscontinuationReason,
  MedicationOrderStatus,
  RefillRequestStatus,
  RefillResponseChannel,
} from "@wardenx/types";
import { NotFoundError, ValidationError } from "@wardenx/types";
import { prescriberEligible } from "../prescriber-eligibility";

// ── injected cross-module validators (narrowed seam subsets; absent ⇒ binding skipped) ──────────────────
/** Minimal M38 `TerminologyProvider` subset the order service binds (RxNorm/NDC validity, as-of). */
export interface DoseSpotTerminologyValidator {
  isValidCode(input: { system: "RXNORM" | "NDC"; code: string; asOf?: string }): Promise<boolean>;
}
/** Minimal M40 `MdmEntityProvider` subset the order service binds (physician / pharmacy resolution). */
export interface DoseSpotMdmValidator {
  resolvePhysician(input: { organizationId: string; mdmId: string }): Promise<{
    active: boolean;
  } | null>;
  resolvePharmacy?(input: { organizationId: string; mdmId: string }): Promise<{
    active: boolean;
  } | null>;
}
/** Minimal M39 `ConsentEvaluator` subset the order service binds (SUD-treatment-medication disclosure gate). */
export interface DoseSpotConsentValidator {
  isSudMedicationDisclosureAllowed(input: {
    organizationId: string;
    patientId: string;
  }): Promise<boolean>;
}

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope) ────────────────────
export interface RecordedDoseSpotEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
}

// ── view DTOs (read projections; never the raw Drizzle row) ──────────────────────────────────────────────
export interface MedicationOrderView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly medClass: MedClass;
  readonly status: MedicationOrderStatus;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  /** Per-class payload; opaque until M12 publishes discriminated field schemas. */
  readonly data: unknown;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
  readonly version: number;
  readonly prescriberMembershipId: string;
  readonly prescriberDiscipline: string;
  readonly prescribingPhysicianMdmId: string;
  readonly dispensingPharmacyMdmId: string | null;
  readonly isControlledSubstance: boolean;
  readonly deaSchedule: DeaSchedule | null;
  readonly cosignRequired: boolean;
  readonly cosignStatus: "pending" | "attached" | null;
  readonly refillsRemaining: number;
  readonly refillsAuthorized: number;
  readonly derivedFromRefillId: string | null;
  readonly replacesMedicationOrderId: string | null;
  readonly signedAt: string | null;
  readonly signedBy: string | null;
  readonly transmittedAt: string | null;
  readonly discontinuedAt: string | null;
  readonly discontinuationReason: MedicationOrderDiscontinuationReason | null;
  readonly createdAt: string;
}

export interface RefillRequestView {
  readonly id: string;
  readonly patientId: string;
  readonly sourceMedicationOrderId: string;
  readonly status: RefillRequestStatus;
  readonly requestedAt: string;
  readonly prescriberMembershipId: string | null;
  readonly resultingMedicationOrderId: string | null;
}

export interface PrescriberRosterView {
  readonly membershipId: string;
  readonly enrolled: boolean;
  readonly deaAuthorizedSchedules: readonly DeaSchedule[];
  readonly ial2Status: string;
}

export interface RefillInboxPolicyView {
  readonly slaWarnHours: number;
  readonly slaCriticalHours: number;
  readonly platformFloorWarnHours: number;
  readonly platformFloorCriticalHours: number;
}

export interface ControlledSubstancePolicyView {
  readonly scheduleIiMaxRefills: number;
  readonly scheduleIiiToVMaxRefills: number;
  readonly epcsCertificationStatus: string;
}

// ── input args ───────────────────────────────────────────────────────────────────────────────────────────
export interface CreateMedicationOrderArgs {
  readonly patientId: string;
  readonly admissionId: string;
  readonly medClass: MedClass;
  readonly rxnormRxcui: string | null;
  readonly ndc: string | null;
  readonly drugName: string;
  readonly strength: string;
  readonly doseForm: string;
  readonly route: string;
  readonly data: unknown;
  readonly prescriberDiscipline: string;
  readonly prescribingPhysicianMdmId: string;
  readonly dispensingPharmacyMdmId?: string;
  readonly deaSchedule?: DeaSchedule;
  readonly containsControlled?: boolean;
  readonly refillsAuthorized: number;
  readonly derivedFromRefillId?: string;
  readonly replacesMedicationOrderId?: string;
}
export interface SignArgs {
  readonly signerDiscipline: string;
  readonly signedAtClient: string;
  readonly signerIsOrderingPhysician?: boolean;
}
export interface RecordVerbalArgs {
  readonly recorderDiscipline: string;
  readonly verbalAttestation: string;
  readonly receivedAt: string;
  readonly namedPrescriberMdmId: string;
}
export interface CosignArgs {
  readonly cosignerRole: "rn_case_manager" | "clinical_supervisor" | "medical_director";
  readonly attestationText: string;
}
export interface DiscontinueArgs {
  readonly reason: "clinical_judgement" | "patient_request" | "adverse_event";
  readonly effectiveAt: string;
  readonly notes?: string;
}
export interface ApproveRefillArgs {
  readonly refillsAuthorized: number;
  readonly responseChannel?: RefillResponseChannel;
  readonly notes?: string;
}
export interface DenyRefillArgs {
  readonly denialReason: string;
  readonly responseChannel?: RefillResponseChannel;
}

// ── §4.7 ABAC resolver ─────────────────────────────────────────────────────────────────────────────────
/** The §4.7 facts the refill resolver loads for `refill_inbox_scope` (named-prescriber + caseload axis). */
export interface RefillScopeFacts {
  readonly isNamedPrescriber: boolean;
  readonly patientInCaseload: boolean;
}

/**
 * The acting identity a §4.7 resolver read is scoped to — BOTH ids, deliberately (GAP-026).
 *
 * M12's two axes key on two DIFFERENT id spaces and the single `userId` string this used to take
 * could only ever be one of them:
 *   · the named-prescriber axis compares against `*_membership_id` columns → `membershipId`;
 *   · the caseload axis goes through M5's `CaseloadProvider`, which reads
 *     `patient_assignment.clinician_user_id` → `userId` (the M2 user id).
 *
 * The route layer's `actorOf()` resolves `context.attributes.membershipId` and calls it `userId` (the
 * codebase-wide "acting membership" convention), but the ABAC layer passed the raw `context.userId`
 * to the SAME resolver method — so in production `isNamedPrescriber` compared a user id against a
 * membership id and could never be true. Naming both fields is what stops that recurring.
 */
export interface DoseSpotAbacActor {
  /** M2 user id (`user.id`) — what M5's `CaseloadProvider` keys on. */
  readonly userId: string;
  /** The actor's ACTIVE membership id — what every `*_membership_id` column keys on; null ⇒ deny. */
  readonly membershipId: string | null;
}

/** The resolver the §4.7 ABAC predicates read facts through (the slice implements it in-memory). */
export interface DoseSpotAbacResolver {
  /**
   * `dosespot_prescriber.dea_authorized_schedules` for the actor's MEMBERSHIP (null = no roster row).
   * The parameter is a membership id — `dosespot_prescriber.membership_id` — never a user id.
   */
  loadAuthorizedSchedules(
    organizationId: string,
    membershipId: string,
  ): Promise<readonly string[] | null>;
  /** The `refill_inbox_scope` facts for a refill id + actor (null = absent / cross-tenant). */
  loadRefillScope(
    organizationId: string,
    refillId: string,
    actor: DoseSpotAbacActor,
  ): Promise<RefillScopeFacts | null>;
}

/** The §4.1 route service contract (the routes compose over it; in-mem slice + prod Drizzle both implement). */
export interface MedicationOrderRouteService extends DoseSpotAbacResolver {
  listOrders(
    organizationId: string,
    filter: { patientId?: string; prescriberId?: string; medClass?: string; status?: string },
  ): Promise<{ orders: MedicationOrderView[] }>;
  getOrder(organizationId: string, id: string): Promise<MedicationOrderView>;
  createDraft(
    organizationId: string,
    userId: string,
    args: CreateMedicationOrderArgs,
  ): Promise<MedicationOrderView>;
  editDraft(
    organizationId: string,
    id: string,
    patch: { data?: unknown; drugName?: string; strength?: string; refillsAuthorized?: number },
  ): Promise<MedicationOrderView>;
  requestSignature(
    organizationId: string,
    id: string,
    signerDiscipline: string,
  ): Promise<MedicationOrderView>;
  signOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: SignArgs,
  ): Promise<MedicationOrderView>;
  signControlledInitiate(
    organizationId: string,
    userId: string,
    id: string,
    schedule: DeaSchedule,
  ): Promise<{
    nonce: string;
    expiresAt: string;
    requiredFactor: "totp" | "passkey" | "push_confirm";
  }>;
  signControlledComplete(
    organizationId: string,
    userId: string,
    id: string,
  ): Promise<MedicationOrderView>;
  recordVerbal(
    organizationId: string,
    userId: string,
    id: string,
    args: RecordVerbalArgs,
  ): Promise<MedicationOrderView>;
  cosignOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CosignArgs,
  ): Promise<MedicationOrderView>;
  discontinueOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: DiscontinueArgs,
  ): Promise<MedicationOrderView>;
  completeOrder(
    organizationId: string,
    userId: string,
    id: string,
    reason?: string,
  ): Promise<MedicationOrderView>;
  correctOrder(
    organizationId: string,
    userId: string,
    id: string,
    args: CreateMedicationOrderArgs,
  ): Promise<{ newOrderId: string }>;
  retransmit(organizationId: string, userId: string, id: string): Promise<{ newOrderId: string }>;
  getTransmission(
    organizationId: string,
    id: string,
  ): Promise<{
    orderId: string;
    status: string;
    retryHistory: ReadonlyArray<{ attempt: number; at: string; errorClass: string | null }>;
  }>;
  activeMedications(
    organizationId: string,
    patientId: string,
  ): Promise<{ orders: MedicationOrderView[] }>;
  medicationHistory(
    organizationId: string,
    patientId: string,
  ): Promise<{ records: ReadonlyArray<{ id: string; drugName: string; source: string }> }>;
  refreshHistory(organizationId: string, patientId: string): Promise<{ jobId: string }>;
  reconcileHistory(
    organizationId: string,
    userId: string,
    historyRecordId: string,
    decision: "carry_forward" | "discontinue" | "document_only",
  ): Promise<{ resultingOrderId: string | null }>;
  /**
   * The §2.7 refill inbox, NARROWED to the caller's scope (GAP-026): the refills they are the named
   * prescriber of, plus those for patients on their caseload. Takes the full {@link DoseSpotAbacActor}
   * because those two axes key on two different id spaces — see that interface.
   *
   * The narrowing lives here rather than in the route's ABAC because `refill_inbox_scope` has no
   * per-row target on a list and therefore resolves to allow; the service IS the list-side control.
   */
  listRefills(
    organizationId: string,
    actor: DoseSpotAbacActor,
  ): Promise<{ refills: RefillRequestView[] }>;
  getRefill(organizationId: string, id: string): Promise<RefillRequestView>;
  approveRefill(
    organizationId: string,
    userId: string,
    id: string,
    args: ApproveRefillArgs,
  ): Promise<{ resultingOrderId: string }>;
  denyRefill(
    organizationId: string,
    userId: string,
    id: string,
    args: DenyRefillArgs,
  ): Promise<{ status: "denied" }>;
  rxBenefitLookup(
    organizationId: string,
    patientId: string,
    rxnormRxcui: string,
  ): Promise<{ covered: boolean; copayCents: number | null }>;
  listPrescribers(organizationId: string): Promise<{ prescribers: PrescriberRosterView[] }>;
  enrollPrescriber(
    organizationId: string,
    membershipId: string,
    deaAuthorizedSchedules: readonly DeaSchedule[],
  ): Promise<PrescriberRosterView>;
  revokePrescriber(
    organizationId: string,
    membershipId: string,
    reason: string,
  ): Promise<{ status: "revoked" }>;
  getRefillInboxPolicy(organizationId: string): Promise<RefillInboxPolicyView>;
  putRefillInboxPolicy(
    organizationId: string,
    patch: { slaWarnHours?: number; slaCriticalHours?: number },
  ): Promise<RefillInboxPolicyView>;
  getControlledSubstancePolicy(organizationId: string): Promise<ControlledSubstancePolicyView>;
  putControlledSubstancePolicy(
    organizationId: string,
    patch: { scheduleIiiToVMaxRefills?: number },
  ): Promise<ControlledSubstancePolicyView>;
  /** Drain (and clear) the §4.4 outbox events recorded since the last call (test/relay seam). */
  drainEvents(): RecordedDoseSpotEvent[];
}

// ── in-memory records ──────────────────────────────────────────────────────────────────────────────────
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
interface OrderRecord extends Mutable<MedicationOrderView> {
  organizationId: string;
  data: unknown;
  cosignerRoleNeeded: "rn_case_manager" | "clinical_supervisor" | "medical_director" | null;
}
interface RefillRecord extends Mutable<RefillRequestView> {
  organizationId: string;
}

export interface DoseSpotRouteSeed {
  readonly orders?: ReadonlyArray<
    Partial<OrderRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      admissionId: string;
      medClass: MedClass;
    }
  >;
  readonly refills?: ReadonlyArray<
    Partial<RefillRecord> & {
      id: string;
      organizationId: string;
      patientId: string;
      sourceMedicationOrderId: string;
    }
  >;
  readonly prescribers?: ReadonlyArray<{
    organizationId: string;
    membershipId: string;
    deaAuthorizedSchedules?: readonly DeaSchedule[];
    ial2Status?: string;
  }>;
  readonly caseloadPatientIds?: ReadonlyArray<{
    organizationId: string;
    userId: string;
    patientId: string;
  }>;
  readonly now?: () => string;
  /** Injected M38 terminology validator (absent ⇒ code binding skipped). */
  readonly terminology?: DoseSpotTerminologyValidator;
  /** Injected M40 master-data validator (absent ⇒ physician/pharmacy binding skipped). */
  readonly mdm?: DoseSpotMdmValidator;
  /** Injected M39 consent validator (absent ⇒ SUD gate defaults to allowed). */
  readonly consent?: DoseSpotConsentValidator;
}

let idCounter = 0x120a0000;
function nextId(): string {
  idCounter += 1;
  const hex = idCounter.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

/** The disciplines eligible to SIGN a medication order (§4.6 — prescriber-only; RN drafts, never signs). */
const SIGNER_DISCIPLINES: ReadonlySet<string> = new Set([
  "hospice_physician",
  "medical_director",
  "np",
  "pa",
]);
const signerEligibleForMed = (discipline: string): boolean =>
  SIGNER_DISCIPLINES.has(discipline.toLowerCase());

/** Whether `medClass` (+ runtime flag) routes through the EPCS controlled-substance branch (§2.4). */
function isControlled(medClass: MedClass, containsControlled: boolean): boolean {
  return isEpcsRequired(medClass, containsControlled);
}

/** Construct the in-memory M12 route backend (the slice). Returns the service (also the ABAC resolver). */
export function createInMemoryDoseSpotBackend(
  seed: DoseSpotRouteSeed = {},
): MedicationOrderRouteService {
  const now = seed.now ?? (() => new Date().toISOString());
  const orders = new Map<string, OrderRecord>();
  const refills = new Map<string, RefillRecord>();
  const prescribers = new Map<
    string,
    {
      organizationId: string;
      membershipId: string;
      enrolled: boolean;
      deaAuthorizedSchedules: readonly DeaSchedule[];
      ial2Status: string;
    }
  >();
  const events: RecordedDoseSpotEvent[] = [];
  const { terminology, mdm, consent } = seed;
  const caseload = new Set<string>(
    (seed.caseloadPatientIds ?? []).map((c) => `${c.organizationId}:${c.userId}:${c.patientId}`),
  );
  let refillPolicy: RefillInboxPolicyView = {
    slaWarnHours: 48,
    slaCriticalHours: 72,
    platformFloorWarnHours: 48,
    platformFloorCriticalHours: 72,
  };
  let csPolicy: ControlledSubstancePolicyView = {
    scheduleIiMaxRefills: 0,
    scheduleIiiToVMaxRefills: 5,
    epcsCertificationStatus: "not_certified",
  };

  for (const s of seed.orders ?? [])
    orders.set(s.id, {
      status: "draft",
      drugName: "",
      strength: "",
      doseForm: "",
      route: "",
      rxnormRxcui: null,
      ndc: null,
      version: 1,
      prescriberMembershipId: "system",
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: "00000000-0000-4000-8000-0000000000ff",
      dispensingPharmacyMdmId: null,
      isControlledSubstance: false,
      deaSchedule: null,
      cosignRequired: false,
      cosignStatus: null,
      refillsRemaining: 0,
      refillsAuthorized: 0,
      derivedFromRefillId: null,
      replacesMedicationOrderId: null,
      signedAt: null,
      signedBy: null,
      transmittedAt: null,
      discontinuedAt: null,
      discontinuationReason: null,
      createdAt: now(),
      data: {},
      cosignerRoleNeeded: null,
      ...s,
    } as OrderRecord);
  for (const s of seed.refills ?? [])
    refills.set(s.id, {
      status: "pending",
      requestedAt: now(),
      prescriberMembershipId: null,
      resultingMedicationOrderId: null,
      ...s,
    } as RefillRecord);
  for (const p of seed.prescribers ?? [])
    prescribers.set(`${p.organizationId}:${p.membershipId}`, {
      organizationId: p.organizationId,
      membershipId: p.membershipId,
      enrolled: true,
      deaAuthorizedSchedules: p.deaAuthorizedSchedules ?? [],
      ial2Status: p.ial2Status ?? "not_started",
    });

  const emit = (
    eventName: string,
    payload: Record<string, unknown>,
    idempotencyKey: string,
  ): void => {
    events.push({ eventName, payload, idempotencyKey });
  };
  /** Emit every `m12.*` outbox event the machine's effect list carries (§2.8 → §4.4). */
  const emitEffects = (
    effects: ReadonlyArray<{ kind: string; event?: string }>,
    id: string,
    payload: Record<string, unknown>,
  ): void => {
    for (const e of effects)
      if (e.kind === "outbox" && e.event)
        emit(e.event, { ...payload, orderId: id }, `${id}:${e.event}`);
  };
  const view = (r: OrderRecord): MedicationOrderView => {
    const { organizationId: _o, cosignerRoleNeeded: _c, ...v } = r;
    return v;
  };
  const viewRefill = (r: RefillRecord): RefillRequestView => {
    const { organizationId: _o, ...v } = r;
    return v;
  };
  const find = (organizationId: string, id: string): OrderRecord => {
    const r = orders.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`medication order ${id} not found`);
    return r;
  };
  const findRefill = (organizationId: string, id: string): RefillRecord => {
    const r = refills.get(id);
    if (!r || r.organizationId !== organizationId)
      throw new NotFoundError(`refill request ${id} not found`);
    return r;
  };

  /** §4.1 bind — validate the RxNorm/NDC code (M38) + the prescribing physician / pharmacy (M40) when bound. */
  async function bindCrossModuleRefs(
    organizationId: string,
    args: CreateMedicationOrderArgs,
  ): Promise<void> {
    if (terminology) {
      const code = args.rxnormRxcui
        ? { system: "RXNORM" as const, code: args.rxnormRxcui }
        : args.ndc
          ? { system: "NDC" as const, code: args.ndc }
          : null;
      if (code) {
        const ok = await terminology.isValidCode({ ...code, asOf: now() });
        if (!ok)
          throw new NotFoundError(`${code.system} code '${code.code}' is not valid as-of ${now()}`);
      }
    }
    if (mdm) {
      const phys = await mdm.resolvePhysician({
        organizationId,
        mdmId: args.prescribingPhysicianMdmId,
      });
      if (phys && !phys.active)
        throw new NotFoundError(
          `prescribing physician ${args.prescribingPhysicianMdmId} is not an active master-data record`,
        );
      if (args.dispensingPharmacyMdmId && mdm.resolvePharmacy) {
        const pharm = await mdm.resolvePharmacy({
          organizationId,
          mdmId: args.dispensingPharmacyMdmId,
        });
        if (pharm && !pharm.active)
          throw new NotFoundError(
            `dispensing pharmacy ${args.dispensingPharmacyMdmId} is not an active master-data record`,
          );
      }
    }
  }

  /** §7.8 — the SUD-treatment-medication consent gate (default allowed when M39 is unbound). */
  async function sudConsentSatisfied(organizationId: string, patientId: string): Promise<boolean> {
    if (!consent) return true;
    return consent.isSudMedicationDisclosureAllowed({ organizationId, patientId });
  }

  async function createInternal(
    organizationId: string,
    userId: string,
    args: CreateMedicationOrderArgs,
    fromExtraction: boolean,
  ): Promise<OrderRecord> {
    const draftFindings = validateMedicationOrderData(args.medClass, undefined, args.data, false);
    if (draftFindings.length) throw new ValidationError("medication draft validation failed", draftFindings);
    await bindCrossModuleRefs(organizationId, args);
    const controlled = isControlled(args.medClass, args.containsControlled ?? false);
    const id = nextId();
    const rec: OrderRecord = {
      id,
      organizationId,
      patientId: args.patientId,
      admissionId: args.admissionId,
      medClass: args.medClass,
      status: "draft",
      drugName: args.drugName,
      strength: args.strength,
      doseForm: args.doseForm,
      route: args.route,
      rxnormRxcui: args.rxnormRxcui,
      ndc: args.ndc,
      version: 1,
      prescriberMembershipId: userId,
      prescriberDiscipline: args.prescriberDiscipline,
      prescribingPhysicianMdmId: args.prescribingPhysicianMdmId,
      dispensingPharmacyMdmId: args.dispensingPharmacyMdmId ?? null,
      isControlledSubstance: controlled,
      deaSchedule: args.deaSchedule ?? null,
      cosignRequired: false,
      cosignStatus: null,
      refillsRemaining: args.refillsAuthorized,
      refillsAuthorized: args.refillsAuthorized,
      derivedFromRefillId: args.derivedFromRefillId ?? null,
      replacesMedicationOrderId: args.replacesMedicationOrderId ?? null,
      signedAt: null,
      signedBy: null,
      transmittedAt: null,
      discontinuedAt: null,
      discontinuationReason: null,
      createdAt: now(),
      data: args.data,
      cosignerRoleNeeded: null,
    };
    orders.set(id, rec);
    emit(
      fromExtraction
        ? "m12.medication_order.draft_created_from_extraction"
        : "m12.medication_order.draft_created",
      {
        orderId: id,
        patientId: args.patientId,
        medClass: args.medClass,
        isControlledSubstance: controlled,
      },
      `${id}:draft_created`,
    );
    return rec;
  }

  return {
    async listOrders(organizationId, filter) {
      const all = [...orders.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          (!filter.patientId || r.patientId === filter.patientId) &&
          (!filter.prescriberId || r.prescriberMembershipId === filter.prescriberId) &&
          (!filter.medClass || r.medClass === filter.medClass) &&
          (!filter.status || r.status === filter.status),
      );
      return { orders: all.map(view) };
    },
    async getOrder(organizationId, id) {
      return view(find(organizationId, id));
    },
    async createDraft(organizationId, userId, args) {
      return view(await createInternal(organizationId, userId, args, false));
    },
    async editDraft(organizationId, id, patch) {
      const r = find(organizationId, id);
      if (r.status !== "draft")
        throw new NotFoundError(`medication order ${id} is not a draft and cannot be edited`);
      if (patch.data !== undefined) {
        const findings = validateMedicationOrderData(r.medClass, undefined, patch.data, false);
        if (findings.length) throw new ValidationError("medication draft validation failed", findings);
        r.data = patch.data;
      }
      if (patch.drugName !== undefined) r.drugName = patch.drugName;
      if (patch.strength !== undefined) r.strength = patch.strength;
      if (patch.refillsAuthorized !== undefined) {
        r.refillsAuthorized = patch.refillsAuthorized;
        r.refillsRemaining = patch.refillsAuthorized;
      }
      r.version += 1;
      return view(r);
    },
    async requestSignature(organizationId, id, _signerDiscipline) {
      const r = find(organizationId, id);
      const findings = validateMedicationOrderData(r.medClass, undefined, r.data, true);
      if (findings.length) throw new ValidationError("medication order is not ready for signature", findings);
      const t = transitionMedicationOrder(r.status, {
        type: "requestSignature",
        medClass: r.medClass,
        containsControlled: r.isControlledSubstance,
        requiredDataComplete: true,
        prescriberEligible: prescriberEligible(r.prescriberDiscipline, r.medClass),
        allergyCheckPassed: true,
        sudConsentSatisfied: await sudConsentSatisfied(organizationId, r.patientId),
        tenantEpcsCertified: csPolicy.epcsCertificationStatus === "certified",
      });
      r.status = t.to;
      emitEffects(t.effects, id, { patientId: r.patientId });
      return view(r);
    },
    async signOrder(organizationId, userId, id, args) {
      const r = find(organizationId, id);
      const t = transitionMedicationOrder(r.status, {
        type: "sign",
        medClass: r.medClass,
        containsControlled: r.isControlledSubstance,
        signerEligible: signerEligibleForMed(args.signerDiscipline),
        signerIsOrderingPhysician: args.signerIsOrderingPhysician ?? r.status !== "verbal_pending",
      });
      r.status = t.to;
      r.signedAt = now();
      r.signedBy = userId;
      r.version += 1;
      emitEffects(t.effects, id, {
        signerMembershipId: userId,
        signedAt: r.signedAt,
        patientId: r.patientId,
      });
      return view(r);
    },
    async signControlledInitiate(organizationId, _userId, id, _schedule) {
      const r = find(organizationId, id);
      // EPCS is OFF in Phase 1 (D18): the machine guard refuses unless the tenant is certified.
      transitionMedicationOrder(r.status, {
        type: "signControlled",
        medClass: r.medClass,
        containsControlled: r.isControlledSubstance,
        deaScheduleAuthorized: true,
        prescriberIal2Verified: true,
        tenantEpcsCertified: csPolicy.epcsCertificationStatus === "certified",
      });
      return { nonce: nextId(), expiresAt: now(), requiredFactor: "totp" as const };
    },
    async signControlledComplete(organizationId, userId, id) {
      const r = find(organizationId, id);
      // Phase-1 deny-stub: completing requires the order to be in epcs_identity_pending, only reachable when
      // EPCS is certified (OFF in Phase 1) — the machine refuses the transition otherwise.
      const t = transitionMedicationOrder(r.status, {
        type: "completeSecondFactor",
        challengeCompletedInTime: true,
        secondFactorType: "totp",
      });
      r.status = t.to;
      r.signedAt = now();
      r.signedBy = userId;
      r.version += 1;
      emitEffects(t.effects, id, {
        signerMembershipId: userId,
        signedAt: r.signedAt,
        viaEpcs: true,
      });
      return view(r);
    },
    async recordVerbal(organizationId, userId, id, args) {
      const r = find(organizationId, id);
      const t = transitionMedicationOrder(r.status, {
        type: "recordVerbal",
        medClass: r.medClass,
        containsControlled: r.isControlledSubstance,
        recorderEligible: true,
        namedPrescriberPresent: args.namedPrescriberMdmId.length > 0,
        attestationRecorded: args.verbalAttestation.length >= 100,
      });
      r.status = t.to;
      r.prescribingPhysicianMdmId = args.namedPrescriberMdmId;
      emitEffects(t.effects, id, {
        recordingMembershipId: userId,
        namedPrescriberMdmId: args.namedPrescriberMdmId,
        patientId: r.patientId,
      });
      return view(r);
    },
    async cosignOrder(organizationId, userId, id, _args) {
      const r = find(organizationId, id);
      if (r.prescriberMembershipId === userId)
        throw new NotFoundError("a medication order may not be cosigned by its own drafter (§7.3)");
      // The cosignature primitive is M11's `OrderSignatureProvider` (signature_kind='cosignature'); the in-mem
      // slice records the attach locally. No M12-owned outbox event (M12 does not own a cosign event).
      r.cosignStatus = "attached";
      return view(r);
    },
    async discontinueOrder(organizationId, userId, id, args) {
      const r = find(organizationId, id);
      const t = transitionMedicationOrder(r.status, { type: "discontinue", reason: args.reason });
      r.status = t.to;
      r.discontinuedAt = now();
      r.discontinuationReason = args.reason;
      r.version += 1;
      emitEffects(t.effects, id, {
        reason: args.reason,
        actorMembershipId: userId,
        effectiveAt: args.effectiveAt,
      });
      return view(r);
    },
    async completeOrder(organizationId, _userId, id, _reason) {
      const r = find(organizationId, id);
      const t = transitionMedicationOrder(r.status, { type: "complete", criterionMet: true });
      r.status = t.to;
      emitEffects(t.effects, id, { completedAt: now() });
      return view(r);
    },
    async correctOrder(organizationId, userId, id, args) {
      const original = find(organizationId, id);
      const correction = await createInternal(
        organizationId,
        userId,
        { ...args, replacesMedicationOrderId: id },
        false,
      );
      original.version += 1;
      return { newOrderId: correction.id };
    },
    async retransmit(organizationId, userId, id) {
      const original = find(organizationId, id);
      if (original.status !== "transmission_failed")
        throw new NotFoundError(
          `medication order ${id} is ${original.status}; only a transmission_failed order may be retransmitted`,
        );
      const correction = await createInternal(
        organizationId,
        userId,
        {
          patientId: original.patientId,
          admissionId: original.admissionId,
          medClass: original.medClass,
          rxnormRxcui: original.rxnormRxcui,
          ndc: original.ndc,
          drugName: original.drugName,
          strength: original.strength,
          doseForm: original.doseForm,
          route: original.route,
          data: original.data,
          prescriberDiscipline: original.prescriberDiscipline,
          prescribingPhysicianMdmId: original.prescribingPhysicianMdmId,
          dispensingPharmacyMdmId: original.dispensingPharmacyMdmId ?? undefined,
          deaSchedule: original.deaSchedule ?? undefined,
          containsControlled: original.isControlledSubstance,
          refillsAuthorized: original.refillsRemaining,
          replacesMedicationOrderId: id,
        },
        false,
      );
      return { newOrderId: correction.id };
    },
    async getTransmission(organizationId, id) {
      const r = find(organizationId, id);
      return {
        orderId: r.id,
        status: r.transmittedAt ? "transmitted" : "not_transmitted",
        retryHistory: [],
      };
    },
    async activeMedications(organizationId, patientId) {
      const all = [...orders.values()].filter(
        (r) =>
          r.organizationId === organizationId && r.patientId === patientId && r.status === "active",
      );
      return { orders: all.map(view) };
    },
    async medicationHistory(_organizationId, _patientId) {
      return { records: [] };
    },
    async refreshHistory(_organizationId, patientId) {
      return { jobId: `dosespot.fetch_medhx:${patientId}` };
    },
    async reconcileHistory(_organizationId, _userId, _historyRecordId, decision) {
      return { resultingOrderId: decision === "carry_forward" ? nextId() : null };
    },
    async listRefills(organizationId, actor) {
      const all = [...refills.values()].filter(
        (r) =>
          r.organizationId === organizationId &&
          ((actor.membershipId !== null && r.prescriberMembershipId === actor.membershipId) ||
            caseload.has(`${organizationId}:${actor.userId}:${r.patientId}`)),
      );
      return { refills: all.map(viewRefill) };
    },
    async getRefill(organizationId, id) {
      return viewRefill(findRefill(organizationId, id));
    },
    async approveRefill(organizationId, userId, id, args) {
      const r = findRefill(organizationId, id);
      const source = orders.get(r.sourceMedicationOrderId);
      const t = transitionRefillRequest(r.status, id, {
        type: "approve",
        actorInScope: true,
        sourceOrderActive: source?.status === "active",
        deaSchedule: source?.deaSchedule ?? null,
        refillsAuthorized: args.refillsAuthorized,
        tenantMaxOverride: csPolicy.scheduleIiiToVMaxRefills,
        responseChannel: args.responseChannel ?? "electronic_via_dosespot",
      });
      r.status = t.to;
      const minted = await createInternal(
        organizationId,
        userId,
        {
          patientId: r.patientId,
          admissionId: source?.admissionId ?? nextId(),
          medClass: source?.medClass ?? "standard",
          rxnormRxcui: source?.rxnormRxcui ?? null,
          ndc: source?.ndc ?? null,
          drugName: source?.drugName ?? "",
          strength: source?.strength ?? "",
          doseForm: source?.doseForm ?? "",
          route: source?.route ?? "",
          data: source?.data ?? {},
          prescriberDiscipline: source?.prescriberDiscipline ?? "hospice_physician",
          prescribingPhysicianMdmId: source?.prescribingPhysicianMdmId ?? r.sourceMedicationOrderId,
          containsControlled: source?.isControlledSubstance ?? false,
          refillsAuthorized: args.refillsAuthorized,
          derivedFromRefillId: id,
        },
        false,
      );
      r.resultingMedicationOrderId = minted.id;
      r.prescriberMembershipId = userId;
      emit(
        "m12.refill_request_approved",
        { refillRequestId: id, resultingOrderId: minted.id, approvedByMembershipId: userId },
        `${id}:approved`,
      );
      return { resultingOrderId: minted.id };
    },
    async denyRefill(organizationId, userId, id, args) {
      const r = findRefill(organizationId, id);
      const t = transitionRefillRequest(r.status, id, {
        type: "deny",
        actorInScope: true,
        denialReasonPresent: args.denialReason.length >= 10,
        responseChannel: args.responseChannel ?? "electronic_via_dosespot",
      });
      r.status = t.to;
      emit(
        "m12.refill_request_denied",
        { refillRequestId: id, deniedByMembershipId: userId, denialReason: args.denialReason },
        `${id}:denied`,
      );
      return { status: "denied" };
    },
    async rxBenefitLookup(_organizationId, _patientId, _rxnormRxcui) {
      return { covered: true, copayCents: null };
    },
    async listPrescribers(organizationId) {
      const all = [...prescribers.values()].filter((p) => p.organizationId === organizationId);
      return {
        prescribers: all.map((p) => ({
          membershipId: p.membershipId,
          enrolled: p.enrolled,
          deaAuthorizedSchedules: p.deaAuthorizedSchedules,
          ial2Status: p.ial2Status,
        })),
      };
    },
    async enrollPrescriber(organizationId, membershipId, deaAuthorizedSchedules) {
      const key = `${organizationId}:${membershipId}`;
      const row = {
        organizationId,
        membershipId,
        enrolled: true,
        deaAuthorizedSchedules,
        ial2Status: "not_started",
      };
      prescribers.set(key, row);
      emit(
        "m12.prescriber_enrolled",
        { membershipId, dosespotPrescriberId: nextId() },
        `${membershipId}:enrolled`,
      );
      return { membershipId, enrolled: true, deaAuthorizedSchedules, ial2Status: row.ial2Status };
    },
    async revokePrescriber(organizationId, membershipId, reason) {
      const key = `${organizationId}:${membershipId}`;
      const row = prescribers.get(key);
      if (!row) throw new NotFoundError(`prescriber roster entry for ${membershipId} not found`);
      row.enrolled = false;
      emit("m12.prescriber_revoked", { membershipId, reason }, `${membershipId}:revoked`);
      return { status: "revoked" };
    },
    async getRefillInboxPolicy(_organizationId) {
      return refillPolicy;
    },
    async putRefillInboxPolicy(_organizationId, patch) {
      // Tighten-only: never raise the SLA above the platform floor (a smaller window is stricter).
      const warn = patch.slaWarnHours ?? refillPolicy.slaWarnHours;
      const critical = patch.slaCriticalHours ?? refillPolicy.slaCriticalHours;
      if (
        warn > refillPolicy.platformFloorWarnHours ||
        critical > refillPolicy.platformFloorCriticalHours
      )
        throw new NotFoundError(
          "refill SLA policy is tighten-only; cannot exceed the platform floor",
        );
      refillPolicy = { ...refillPolicy, slaWarnHours: warn, slaCriticalHours: critical };
      return refillPolicy;
    },
    async getControlledSubstancePolicy(_organizationId) {
      return csPolicy;
    },
    async putControlledSubstancePolicy(_organizationId, patch) {
      const max = patch.scheduleIiiToVMaxRefills ?? csPolicy.scheduleIiiToVMaxRefills;
      if (max > 5)
        throw new NotFoundError(
          "controlled-substance refill policy is tighten-only (21 CFR 1306.22 ≤ 5)",
        );
      csPolicy = { ...csPolicy, scheduleIiiToVMaxRefills: max };
      emit(
        "m12.controlled_substance_policy_changed",
        { before: csPolicy.scheduleIiiToVMaxRefills, after: max },
        `cs_policy:${now()}`,
      );
      return csPolicy;
    },

    // ── §4.7 ABAC resolver ────────────────────────────────────────────────────────────────────────────
    async loadAuthorizedSchedules(organizationId, userId) {
      const row = prescribers.get(`${organizationId}:${userId}`);
      return row ? row.deaAuthorizedSchedules : null;
    },
    async loadRefillScope(organizationId, refillId, actor) {
      const r = refills.get(refillId);
      if (!r || r.organizationId !== organizationId) return null;
      const source = orders.get(r.sourceMedicationOrderId);
      // Each axis reads the id space it actually keys on (GAP-026). The seeded `caseloadPatientIds`
      // fixtures are keyed by USER id, matching `patient_assignment.clinician_user_id` in prod.
      const { userId, membershipId } = actor;
      return {
        isNamedPrescriber:
          membershipId !== null &&
          (r.prescriberMembershipId === membershipId ||
            source?.prescriberMembershipId === membershipId),
        patientInCaseload: caseload.has(`${organizationId}:${userId}:${r.patientId}`),
      };
    },

    drainEvents() {
      const drained = [...events];
      events.length = 0;
      return drained;
    },
  };
}

// Re-export the catalog reference so consumers can confirm the slice composes the pure domain.
export { MED_CLASS_CATALOG };
