// apps/backend/src/modules/13-emar/routes/service.ts — M13-T08 the §4.1 route service over an in-memory
// backend (the M8-T09 / M9-T05 / M10-T06 / M11-T06 / M12-T08 in-mem-slice precedent; Drizzle in prod under
// `withOrgContext` so RLS backstops every read). The service composes the PURE M13 domain (`@wardenx/emar`):
// the §2.5 D8 late-entry tier (`resolveLateEntryTier`), the §2.8 reconciliation finalize/decision rules, the
// §2.7 comfort-kit drawdown — and emits the §4.4 outbox events the relay publishes (drainable for tests).
//
// It "binds" the §4.1 cross-module surfaces through an INJECTED M8 `SignedEncountersReader` (D9 encounter
// auto-linkage at administration time). The reader is resolved from the M1 seam registry at boot
// (seams/index.ts); when absent (the in-mem slice default) the auto-link is skipped so the administration
// write path never blocks on an external dependency (the M10 §7.13 fail-open convention). The bidirectional
// M12 consistency check (D6) is the `MedicationOrderProvider.getAdministrationContext` consult M13 owns; the
// in-mem slice treats every seeded order as administerable.
//
// This service ALSO implements {@link EmarAbacResolver} so the §4.7 predicates resolve over the same dataset
// (M12-T08 precedent: the backend is both the route service and the ABAC resolver).
import {
  ADMINISTRATION_MODE_CATALOG,
  AdministrationStateError,
  type BarcodeMatchResult,
  type BarcodeScanInput,
  type FiveRightsOrderContext,
  type IvSegment,
  type IvSegmentMode,
  type ReconciliationLineKind,
  type ReconciliationMedicationDetails,
  assertFiveRights,
  barcodeScanBlocks,
  composeIvSession,
  deriveIvSessionState,
  evaluateBarcodeScan,
  planIvSegment,
  planReconciliationDecision,
  resolveLateEntryTier,
} from "@wardenx/emar";
import type {
  AdministrationActorKind,
  AdministrationLateEntryTier,
  AdministrationMode,
  AdministrationStatus,
  ReconciliationDecisionKind,
  ReconciliationTriggerKind,
  ReconciliationWorksheetStatus,
  ScheduledDoseStatus,
  SignedEncountersReader,
} from "@wardenx/types";
import { NotFoundError, ValidationError } from "@wardenx/types";
import type {
  CaregiverReviewAbacFacts,
  EmarAbacResolver,
  WitnessAbacFacts,
} from "../abac-predicates";

// ── §4.4 outbox events the service records (the relay wraps them in the M1 envelope) ────────────────────
export interface RecordedEmarEvent {
  readonly eventName: string;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string;
}

// ── view DTOs (read projections; never the raw Drizzle row) ──────────────────────────────────────────────
export interface AdministrationView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly medicationOrderId: string;
  readonly mode: AdministrationMode;
  readonly status: AdministrationStatus;
  readonly actorKind: AdministrationActorKind;
  readonly administeredAt: string;
  readonly recordedAt: string;
  readonly lateEntryTier: AdministrationLateEntryTier;
  readonly administeringClinicianMembershipId: string | null;
  readonly witnessMembershipId: string | null;
  readonly encounterId: string | null;
  readonly scheduledDoseId: string | null;
  readonly comfortKitDeploymentId: string | null;
  readonly ivSessionId: string | null;
  readonly isControlledSubstance: boolean;
  readonly isComfortKitDrawdown: boolean;
  readonly requiresRnReview: boolean;
  readonly supersededById: string | null;
  /** §2.9 BCMA — the canonical `barcode_scan_event.match_result` for this dose, or null when no scan was captured. */
  readonly barcodeMatchResult: BarcodeMatchResult | null;
}

export interface ScheduledDoseView {
  readonly id: string;
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly dueAt: string;
  readonly status: ScheduledDoseStatus;
}

export interface MissedDoseView {
  readonly id: string;
  readonly patientId: string;
  readonly scheduledDoseId: string;
  readonly medicationOrderId: string;
  readonly dueAt: string;
  readonly acknowledgedAt: string | null;
}

export interface ReconciliationDecisionView {
  readonly lineId: string;
  readonly lineKind: string;
  readonly sourceId: string;
  readonly decision: ReconciliationDecisionKind;
  /** §2.8 D17 — the M12 draft this decision produced, once sent to the prescriber (F-031). */
  readonly resultingMedicationOrderId: string | null;
}

export interface WorksheetView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly status: ReconciliationWorksheetStatus;
  readonly lineCount: number;
  readonly decisions: readonly ReconciliationDecisionView[];
}

export interface DeploymentView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly disposalStatus: string;
}

export interface AdministrationPolicyView {
  readonly graceWindowMinutes: number;
  readonly prnMinimumIntervalMinutes: number;
  readonly emarPdfOnCommit: boolean;
}

export interface IvSessionView {
  readonly sessionId: string;
  readonly medicationOrderId: string;
  /** The `iv_continuous_start` segment's clinical instant — the FHIR `effectivePeriod.start`. */
  readonly startedAt: string;
  /** The `iv_continuous_stop` segment's instant, or null while the session is open. */
  readonly endedAt: string | null;
  /**
   * §2.11 — the state the segment sequence derives (`running` / `paused` / `stopped`). Published so a
   * client can offer the segments `IV_SESSION_GRAPH` accepts NEXT instead of offering all five and
   * discovering the illegal ones as 409s at the bedside. The server still decides: this is the same
   * derivation `assertIvSegmentLegal` runs on the write.
   */
  readonly state: "none" | "running" | "paused" | "stopped";
  readonly segments: readonly {
    kind: AdministrationMode;
    recordedAt: string;
    /** The infusion rate this segment carries (start/rate_change); null for pause/resume/stop. */
    rate: number | null;
    rateUnit: string | null;
  }[];
}

// ── input args ───────────────────────────────────────────────────────────────────────────────────────────
export interface RecordAdministrationArgs {
  readonly medicationOrderId: string;
  readonly medClass: string;
  readonly mode: AdministrationMode;
  readonly administeredAt: string;
  readonly scheduledDoseId?: string;
  readonly comfortKitDeploymentId?: string;
  readonly encounterId?: string;
  /**
   * §2.11 D11 — the IV-continuous session this segment belongs to. REQUIRED for `rate_change` / `pause` /
   * `resume` / `stop` (they continue a session) and REFUSED for `iv_continuous_start` (which mints one).
   */
  readonly ivSessionId?: string;
  /**
   * The per-mode body (§2.1 mode catalog). Carried opaquely from the route — the server discriminates on
   * `mode` — and persisted onto the row, which is where the IV rate, the titration reason and the wastage
   * live. `route` / `doseAmount` / `doseUnit` below are the discrete fields lifted out of it for the
   * §5.11 five-rights checks and the snapshot columns.
   */
  readonly data?: unknown;
  readonly prn?: { triggeringPrnReason: string; requestedByKind: string };
  readonly lateEntryReason?: string;
  readonly offlineCapture?: { deviceId: string; localId: string; capturedAt: string };
  readonly witnessToken?: string;
  /** §2.9 BCMA — the bedside scan re-verified against the M12 order + patient wristband at write time. */
  readonly barcodeScan?: BarcodeScanInput;
  /** The per-dose route (lifted from the per-mode `data` body) for the §5.11 five-rights `route` right. */
  readonly route?: string;
  /** The administered amount + unit (from `data`) for the §5.11 `dose` right. */
  readonly doseAmount?: number | null;
  readonly doseUnit?: string | null;
}
export interface RecordCaregiverAttestedArgs {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly administeredAt: string;
  readonly caregiverSessionId: string;
  /** §2.9 — the caregiver-entered route/dose, run through the SAME §5.11 five-rights validator as the clinician path. */
  readonly route: string;
  readonly doseAmount: number;
  readonly doseUnit: string;
  /** §2.9 BCMA — a caregiver-side scan, when the home kit medication is barcoded. */
  readonly barcodeScan?: BarcodeScanInput;
}
export interface WitnessAttestArgs {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly administeringClinicianMembershipId: string;
}
export interface RecordRefusalArgs {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly medClass: string;
  readonly scheduledDoseId?: string;
  readonly refusedAt: string;
}
export interface RecordDecisionArgs {
  readonly lineKind: ReconciliationLineKind;
  readonly sourceId: string;
  readonly decision: ReconciliationDecisionKind;
  /** Real, caller-typed drug content for a decision that mints an M12 draft (`carry_forward` of a
   *  `caregiver_reported` line, or any `new_order`) — required in that case, never fabricated. See
   *  `@wardenx/emar`'s `ReconciliationMedicationDetails` for why `m12_medhx` cannot use this at all yet. */
  readonly medicationDetails?: ReconciliationMedicationDetails;
}

/** The §4.1 route surface the Fastify handlers compose over. */
export interface EmarRouteService extends EmarAbacResolver {
  recordAdministration(
    orgId: string,
    userId: string,
    args: RecordAdministrationArgs,
  ): Promise<AdministrationView>;
  mintWitnessToken(
    orgId: string,
    userId: string,
    args: WitnessAttestArgs,
  ): Promise<{ token: string; expiresInSeconds: number }>;
  recordCaregiverAttested(
    orgId: string,
    args: RecordCaregiverAttestedArgs,
  ): Promise<AdministrationView>;
  acknowledgeCaregiver(orgId: string, userId: string, id: string): Promise<AdministrationView>;
  disputeCaregiver(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
  ): Promise<AdministrationView>;
  correctAdministration(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
  ): Promise<AdministrationView>;
  voidAdministration(
    orgId: string,
    userId: string,
    id: string,
    reason: string,
  ): Promise<AdministrationView>;
  getAdministration(orgId: string, id: string): Promise<AdministrationView>;
  listAdministrations(
    orgId: string,
    q: { patient: string; since?: string; until?: string },
  ): Promise<AdministrationView[]>;
  getIvSession(orgId: string, sessionId: string): Promise<IvSessionView>;
  recordRefusal(
    orgId: string,
    userId: string,
    args: RecordRefusalArgs,
  ): Promise<AdministrationView>;
  offlineSync(
    orgId: string,
    userId: string,
    rows: RecordAdministrationArgs[],
  ): Promise<{ synced: number; results: AdministrationView[] }>;
  listScheduledDoses(
    orgId: string,
    q: { patient: string; from?: string; to?: string },
  ): Promise<ScheduledDoseView[]>;
  intentionalHold(orgId: string, userId: string, id: string): Promise<ScheduledDoseView>;
  listMissedDoses(orgId: string, q: { patient: string; since?: string }): Promise<MissedDoseView[]>;
  acknowledgeMissed(orgId: string, userId: string, id: string): Promise<MissedDoseView>;
  listWorksheets(orgId: string, patient: string): Promise<WorksheetView[]>;
  getWorksheet(orgId: string, id: string): Promise<WorksheetView>;
  recordDecision(
    orgId: string,
    userId: string,
    id: string,
    args: RecordDecisionArgs,
  ): Promise<WorksheetView>;
  updateDecision(
    orgId: string,
    userId: string,
    id: string,
    lineId: string,
    decision: ReconciliationDecisionKind,
    resultingMedicationOrderId?: string,
  ): Promise<WorksheetView>;
  addCaregiverReportedLine(orgId: string, id: string, drugName: string): Promise<WorksheetView>;
  finalizeReconciliation(orgId: string, userId: string, id: string): Promise<WorksheetView>;
  voidWorksheet(orgId: string, userId: string, id: string, reason: string): Promise<WorksheetView>;
  listDeployments(orgId: string, patient: string): Promise<DeploymentView[]>;
  getDeployment(orgId: string, id: string): Promise<DeploymentView>;
  acknowledgeReturn(orgId: string, userId: string, id: string): Promise<DeploymentView>;
  getPolicy(orgId: string): Promise<AdministrationPolicyView>;
  putPolicy(
    orgId: string,
    patch: Partial<AdministrationPolicyView>,
  ): Promise<AdministrationPolicyView>;
  drainEvents(): RecordedEmarEvent[];
}

// ── in-memory seed shapes ────────────────────────────────────────────────────────────────────────────────
export interface EmarMembershipSeed {
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  readonly discipline: string;
  readonly active?: boolean;
  readonly isCaregiver?: boolean;
}
export interface EmarAdministrationSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly medicationOrderId: string;
  readonly actorKind?: AdministrationActorKind;
  readonly requiresRnReview?: boolean;
  readonly status?: AdministrationStatus;
}
export interface EmarScheduledDoseSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly dueAt: string;
  readonly status?: ScheduledDoseStatus;
}
export interface EmarMissedDoseSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly scheduledDoseId: string;
  readonly medicationOrderId: string;
  readonly dueAt: string;
}
export interface EmarWorksheetSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly triggerKind: ReconciliationTriggerKind;
  readonly status?: ReconciliationWorksheetStatus;
  readonly lineCount?: number;
}
export interface EmarDeploymentSeed {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly disposalStatus?: string;
}
/** A seeded M12 order projection (the slice's `MedicationOrderProvider.getAdministrationContext` D6 + the
 * §5.11 five-rights order context + the §2.9 BCMA drug identity). Absent → the slice treats the order as freely
 * administerable and skips the order-context gates (the existing in-mem default). */
export interface EmarOrderSeed {
  readonly medicationOrderId: string;
  readonly patientId: string;
  /** GAP-005 — the order's class. The DB backend always has it (M12); absent here, the slice falls back to
   *  the body's claim so older fixtures keep working — production never does. */
  readonly medClass?: "standard" | "controlled_substance" | "compounded";
  readonly route: string;
  readonly doseAmount?: number | null;
  readonly doseUnit?: string | null;
  /** D6 — `getAdministrationContext.allowAdministration`; false → the write returns 422 ADMINISTRATION_BLOCKED. */
  readonly administerable?: boolean;
  readonly blockedReasons?: readonly string[];
  readonly rxnormRxcui?: string | null;
  readonly ndc?: string | null;
  /** §2.11 D11 — the titration bounds this order authorises. ABSENT means it authorises no titration, so
   *  a `rate_change` against it is refused (`IV_RATE_OUT_OF_RANGE`) rather than treated as unbounded. */
  readonly ivContinuousPolicy?: { readonly minRate: number; readonly maxRate: number } | null;
}
/** A seeded patient identity for the §2.9 BCMA wristband match. */
export interface EmarPatientSeed {
  readonly patientId: string;
  readonly wristbandPayloadDigest?: string | null;
}
export interface EmarRouteSeed {
  readonly now?: () => string;
  readonly witnessSecret?: string;
  readonly memberships?: readonly EmarMembershipSeed[];
  /** patientId → the userId of the patient's RN case manager (M5 CaseloadProvider analog). */
  readonly caseManagers?: Readonly<Record<string, string>>;
  readonly administrations?: readonly EmarAdministrationSeed[];
  readonly scheduledDoses?: readonly EmarScheduledDoseSeed[];
  readonly missedDoses?: readonly EmarMissedDoseSeed[];
  readonly worksheets?: readonly EmarWorksheetSeed[];
  readonly deployments?: readonly EmarDeploymentSeed[];
  readonly orders?: readonly EmarOrderSeed[];
  readonly patients?: readonly EmarPatientSeed[];
  readonly signedEncountersReader?: SignedEncountersReader;
}

interface AdminRow {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  medicationOrderId: string;
  mode: AdministrationMode;
  status: AdministrationStatus;
  actorKind: AdministrationActorKind;
  administeredAt: string;
  recordedAt: string;
  lateEntryTier: AdministrationLateEntryTier;
  administeringClinicianMembershipId: string | null;
  witnessMembershipId: string | null;
  encounterId: string | null;
  scheduledDoseId: string | null;
  comfortKitDeploymentId: string | null;
  ivSessionId: string | null;
  isControlledSubstance: boolean;
  isComfortKitDrawdown: boolean;
  requiresRnReview: boolean;
  supersededById: string | null;
  barcodeMatchResult: BarcodeMatchResult | null;
  /** §2.1 per-mode body — where the IV rate/titration reason/wastage live (F-031). */
  data?: unknown;
}
/** The rate a slice-stored segment carries — the same `data` keys the Drizzle path and the seam read. */
function sliceIvRateOf(data: unknown): { rate?: number; rateUnit?: string } {
  const d = (data ?? {}) as Record<string, unknown>;
  const rate = [d.infusionRate, d.newRate, d.rate].find((v) => typeof v === "number") as
    | number
    | undefined;
  const rateUnit = [d.rateUnit, d.infusionRateUnit].find((v) => typeof v === "string") as
    | string
    | undefined;
  return {
    ...(rate !== undefined ? { rate } : {}),
    ...(rateUnit !== undefined ? { rateUnit } : {}),
  };
}

/** The seeded order's titration bounds, or null when it authorises none. */
function sliceIvPolicyOf(order: EmarOrderSeed | undefined): {
  minRate: number;
  maxRate: number;
} | null {
  const p = order?.ivContinuousPolicy;
  return p ? { minRate: p.minRate, maxRate: p.maxRate } : null;
}

interface WorksheetRow {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  triggerKind: ReconciliationTriggerKind;
  status: ReconciliationWorksheetStatus;
  lineCount: number;
  decisions: Map<string, ReconciliationDecisionView>;
}

const ENCOUNTER_LINK_TOLERANCE_MS = 30 * 60 * 1000; // D9 — administeredAt ± 30 minutes
let _seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(++_seq).toString(16).padStart(12, "0")}`;

/**
 * The in-memory M13 route backend (the slice/test default; Drizzle in prod under `withOrgContext`). Implements
 * both {@link EmarRouteService} and {@link EmarAbacResolver}. Every read narrows on `organizationId` first
 * (RLS backstops in prod). Mutations record the §4.4 outbox event the relay publishes (drainable for tests).
 */
export function createInMemoryEmarBackend(seed: EmarRouteSeed = {}): EmarRouteService {
  const now = seed.now ?? (() => new Date().toISOString());
  const witnessSecret = seed.witnessSecret ?? "test-witness-secret";
  const reader = seed.signedEncountersReader;
  const memberships = new Map<string, EmarMembershipSeed>(); // userId → membership
  for (const m of seed.memberships ?? []) memberships.set(m.userId, m);
  const caseManagers = seed.caseManagers ?? {};

  const admins = new Map<string, AdminRow>();
  for (const a of seed.administrations ?? []) {
    admins.set(a.id, {
      id: a.id,
      organizationId: a.organizationId,
      patientId: a.patientId,
      admissionId: a.admissionId,
      medicationOrderId: a.medicationOrderId,
      mode: "single_dose",
      status:
        a.status ??
        (a.actorKind === "caregiver_attested" ? "pending_caregiver_review" : "committed"),
      actorKind: a.actorKind ?? "clinician",
      administeredAt: now(),
      recordedAt: now(),
      lateEntryTier: "normal",
      administeringClinicianMembershipId: null,
      witnessMembershipId: null,
      encounterId: null,
      scheduledDoseId: null,
      comfortKitDeploymentId: null,
      ivSessionId: null,
      isControlledSubstance: false,
      isComfortKitDrawdown: false,
      requiresRnReview: a.requiresRnReview ?? a.actorKind === "caregiver_attested",
      supersededById: null,
      barcodeMatchResult: null,
    });
  }
  const orders = new Map<string, EmarOrderSeed>();
  for (const o of seed.orders ?? []) orders.set(o.medicationOrderId, o);
  const patients = new Map<string, EmarPatientSeed>();
  for (const p of seed.patients ?? []) patients.set(p.patientId, p);
  const scheduled = new Map<string, EmarScheduledDoseSeed & { status: ScheduledDoseStatus }>();
  for (const s of seed.scheduledDoses ?? [])
    scheduled.set(s.id, { ...s, status: s.status ?? "pending" });
  const missed = new Map<string, EmarMissedDoseSeed & { acknowledgedAt: string | null }>();
  for (const m of seed.missedDoses ?? []) missed.set(m.id, { ...m, acknowledgedAt: null });
  const worksheets = new Map<string, WorksheetRow>();
  for (const w of seed.worksheets ?? []) {
    worksheets.set(w.id, {
      id: w.id,
      organizationId: w.organizationId,
      patientId: w.patientId,
      admissionId: w.admissionId,
      triggerKind: w.triggerKind,
      status: w.status ?? "in_progress",
      lineCount: w.lineCount ?? 1,
      decisions: new Map(),
    });
  }
  const deployments = new Map<string, EmarDeploymentSeed & { disposalStatus: string }>();
  for (const d of seed.deployments ?? [])
    deployments.set(d.id, { ...d, disposalStatus: d.disposalStatus ?? "deployed" });
  const policy: AdministrationPolicyView = {
    graceWindowMinutes: 30,
    prnMinimumIntervalMinutes: 60,
    emarPdfOnCommit: false,
  };
  const witnessTokens = new Map<
    string,
    {
      patientId: string;
      medicationOrderId: string;
      administeringMembershipId: string;
      witnessMembershipId: string;
      expiresAt: number;
    }
  >();

  const events: RecordedEmarEvent[] = [];
  const emit = (eventName: string, payload: Record<string, unknown>): void => {
    events.push({ eventName, payload, idempotencyKey: nextId("evt") });
  };

  const view = (r: AdminRow): AdministrationView => ({ ...r });
  const wView = (w: WorksheetRow): WorksheetView => ({
    id: w.id,
    patientId: w.patientId,
    admissionId: w.admissionId,
    triggerKind: w.triggerKind,
    status: w.status,
    lineCount: w.lineCount,
    decisions: [...w.decisions.values()],
  });

  const requireAdmin = (orgId: string, id: string): AdminRow => {
    const r = admins.get(id);
    if (!r || r.organizationId !== orgId) throw new NotFoundError("administration not found");
    return r;
  };
  const requireWorksheet = (orgId: string, id: string): WorksheetRow => {
    const w = worksheets.get(id);
    if (!w || w.organizationId !== orgId)
      throw new NotFoundError("reconciliation worksheet not found");
    return w;
  };

  async function autoLinkEncounter(
    orgId: string,
    patientId: string,
    administeredAt: string,
    mode: AdministrationMode,
  ): Promise<string | null> {
    // D9 — IV-continuous session events carry a nullable encounter; only single_dose auto-links.
    if (mode !== "single_dose" || !reader) return null;
    const since = new Date(Date.parse(administeredAt) - ENCOUNTER_LINK_TOLERANCE_MS).toISOString();
    const digests = await reader.signedEncountersForPatientSince(orgId, patientId, since);
    const at = Date.parse(administeredAt);
    const within = digests.filter(
      (d) => Math.abs(Date.parse(d.signedAt) - at) <= ENCOUNTER_LINK_TOLERANCE_MS,
    );
    return within.length > 0 ? within[within.length - 1]!.encounterId : null;
  }

  // D6 — the bidirectional-consistency consult against M12's `getAdministrationContext`. The slice resolves the
  // order from its seed; an unseeded order is treated as freely administerable (the in-mem default). A seeded
  // order with `administerable=false` blocks the write with 422 ADMINISTRATION_BLOCKED, echoing the reasons.
  function assertAdministerable(medicationOrderId: string): void {
    const o = orders.get(medicationOrderId);
    if (o && o.administerable === false) {
      const reasons =
        o.blockedReasons && o.blockedReasons.length > 0
          ? o.blockedReasons.join(", ")
          : "order not active";
      throw new AdministrationStateError(
        "ADMINISTRATION_BLOCKED",
        `administration blocked by M12 order state: ${reasons}`,
      );
    }
  }

  // §5.11 — run the five-rights validator against the seeded M12 order context. Skipped when the order is not
  // seeded (the slice's default; the real path always has an M12 projection). `route`/`doseAmount`/`doseUnit`
  // come from the per-mode `data` body (clinician) or the caregiver request body.
  function assertFiveRightsForOrder(
    medicationOrderId: string,
    patientId: string,
    req: { route?: string; doseAmount?: number | null; doseUnit?: string | null },
    administeredAt: string,
  ): void {
    const o = orders.get(medicationOrderId);
    if (!o || req.route === undefined) return;
    const orderContext: FiveRightsOrderContext = {
      patientId: o.patientId,
      medicationOrderId: o.medicationOrderId,
      route: o.route,
      doseAmount: o.doseAmount ?? null,
      doseUnit: o.doseUnit ?? null,
    };
    assertFiveRights(
      {
        patientId,
        medicationOrderId,
        route: req.route,
        doseAmount: req.doseAmount ?? null,
        doseUnit: req.doseUnit ?? null,
        administeredAt,
      },
      orderContext,
      now(),
    );
  }

  // §2.9 BCMA — re-derive the canonical barcode `match_result` against the seeded order + patient wristband, and
  // refuse the write on an unsafe result (wrong_patient/wrong_drug/expired). Records nothing in the slice beyond
  // the `barcodeMatchResult` carried on the administration view; returns null when no scan was captured.
  function evaluateBarcode(
    medicationOrderId: string,
    patientId: string,
    scan: BarcodeScanInput | undefined,
    administeredAt: string,
  ): BarcodeMatchResult | null {
    if (!scan) return null;
    const o = orders.get(medicationOrderId);
    const orderContext = o
      ? {
          orderActive: o.administerable !== false,
          rxnormRxcui: o.rxnormRxcui ?? null,
          ndc: o.ndc ?? null,
        }
      : null;
    const p = patients.get(patientId);
    const result = evaluateBarcodeScan(
      scan,
      orderContext,
      { wristbandPayloadDigest: p?.wristbandPayloadDigest ?? null },
      administeredAt.slice(0, 10),
    );
    if (barcodeScanBlocks(result))
      throw new AdministrationStateError(
        "BARCODE_VERIFICATION_FAILED",
        `barcode verification failed: ${result}`,
      );
    return result;
  }

  return {
    // ── EmarAbacResolver ─────────────────────────────────────────────────────────────────────────────────
    async loadWitnessFacts(orgId: string, witnessUserId: string): Promise<WitnessAbacFacts | null> {
      const m = memberships.get(witnessUserId);
      if (!m) return null;
      return {
        witnessMembershipId: m.membershipId,
        witnessDiscipline: m.discipline,
        witnessMembershipActive: m.active ?? true,
        sameTenant: m.organizationId === orgId,
        witnessIsCaregiver: m.isCaregiver ?? false,
        witnessIsBreakGlass: false,
      };
    },
    async loadCaregiverReviewFacts(
      orgId,
      administrationId,
      actorUserId,
    ): Promise<CaregiverReviewAbacFacts | null> {
      const r = admins.get(administrationId);
      if (!r || r.organizationId !== orgId) return null;
      return {
        requiresRnReview: r.requiresRnReview,
        actorIsRnCaseManager: caseManagers[r.patientId] === actorUserId,
      };
    },
    async loadWorksheetTriggerKind(orgId, worksheetId): Promise<ReconciliationTriggerKind | null> {
      const w = worksheets.get(worksheetId);
      return w && w.organizationId === orgId ? w.triggerKind : null;
    },
    async loadScopePatientId(orgId, kind, id): Promise<string | null> {
      const inOrg = <T extends { organizationId: string; patientId: string }>(r: T | undefined) =>
        r && r.organizationId === orgId ? r.patientId : null;
      switch (kind) {
        case "administrationId":
          return inOrg(admins.get(id));
        case "ivSessionId":
          return inOrg([...admins.values()].find((a) => a.ivSessionId === id));
        case "scheduledDoseId":
          return inOrg(scheduled.get(id));
        case "missedDoseId":
          return inOrg(missed.get(id));
        case "worksheetId":
          return inOrg(worksheets.get(id));
        case "deploymentId":
          return inOrg(deployments.get(id));
        case "medicationOrderId":
          // The slice's orders carry no org; an unseeded order is the slice's permissive default.
          return orders.get(id)?.patientId ?? null;
      }
    },
    async loadOrderMedClass(_orgId, medicationOrderId): Promise<string | null> {
      // Slice default: an unseeded or class-less order is `standard` (the DB backend has no default).
      return orders.get(medicationOrderId)?.medClass ?? "standard";
    },

    // ── §4.1 routes ──────────────────────────────────────────────────────────────────────────────────────
    async recordAdministration(orgId, userId, args): Promise<AdministrationView> {
      const m = memberships.get(userId);
      const recordedAt = args.offlineCapture ? now() : now();
      const lateEntryTier = resolveLateEntryTier(args.administeredAt, recordedAt);
      const orderClass = orders.get(args.medicationOrderId)?.medClass;
      if (orderClass && args.medClass !== undefined && args.medClass !== orderClass)
        throw new ValidationError("medClass does not match the medication order", [
          { field: "medClass", code: "MED_CLASS_MISMATCH", message: `the order is ${orderClass}` },
        ]);
      const isControlled = (orderClass ?? args.medClass) === "controlled_substance";
      let witnessMembershipId: string | null = null;
      if (isControlled) {
        // D7 — controlled administration requires a consumed witness-attestation token.
        const claim = args.witnessToken ? witnessTokens.get(args.witnessToken) : undefined;
        if (!claim || claim.expiresAt < Date.parse(now()))
          throw new ValidationError(
            "a controlled-substance administration requires a witness attestation",
            [
              {
                field: "X-Witness-Attestation",
                code: "WITNESS_REQUIRED",
                message: "witness attestation missing or expired",
              },
            ],
          );
        witnessMembershipId = claim.witnessMembershipId;
        witnessTokens.delete(args.witnessToken!); // single-use, burned on consume
      }
      const isComfortKitDrawdown = Boolean(args.comfortKitDeploymentId);
      // §2.11 D11 — the slice runs the SAME pure core the Drizzle path does (F-031/#134), so a boot-
      // without-DB run refuses an out-of-sequence segment and an out-of-bounds titration identically.
      const modeMeta = ADMINISTRATION_MODE_CATALOG[args.mode];
      let ivSessionId: string | null = null;
      if (modeMeta.isIvContinuous) {
        if (modeMeta.ivSessionRole === "mint") {
          if (args.ivSessionId)
            throw new ValidationError("an IV-continuous start mints its own session", [
              {
                field: "ivSessionId",
                code: "INVALID",
                message: "iv_continuous_start must not name an existing session",
              },
            ]);
        } else if (!args.ivSessionId) {
          throw new ValidationError("this IV segment must name its session", [
            {
              field: "ivSessionId",
              code: "REQUIRED",
              message: `${args.mode} continues an existing IV session and requires its ivSessionId`,
            },
          ]);
        }
        const prior: IvSegment[] = args.ivSessionId
          ? [...admins.values()]
              .filter(
                (r) =>
                  r.organizationId === orgId &&
                  r.ivSessionId === args.ivSessionId &&
                  r.status !== "voided",
              )
              .sort(
                (a, b) =>
                  Date.parse(a.administeredAt) - Date.parse(b.administeredAt) ||
                  Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
              )
              .map((r) => ({
                mode: r.mode as IvSegmentMode,
                administeredAt: r.administeredAt,
                ...sliceIvRateOf(r.data),
              }))
          : [];
        if (args.ivSessionId && prior.length === 0) throw new NotFoundError("iv session not found");
        const body = (args.data ?? {}) as { newRate?: unknown; wastageAmount?: unknown };
        const plan = planIvSegment(deriveIvSessionState(prior), {
          mode: args.mode as IvSegmentMode,
          isControlled,
          newRate: typeof body.newRate === "number" ? body.newRate : null,
          policy: sliceIvPolicyOf(orders.get(args.medicationOrderId)),
          wastageAmount: typeof body.wastageAmount === "number" ? body.wastageAmount : null,
        });
        ivSessionId = plan.mintsSession ? nextId("ivs") : (args.ivSessionId ?? null);
      }
      const id = nextId("adm");
      // The patient/admission are resolved from M12 in prod; the slice derives from the scheduled dose or seed.
      const sched = args.scheduledDoseId ? scheduled.get(args.scheduledDoseId) : undefined;
      const patientId =
        sched?.patientId ?? orders.get(args.medicationOrderId)?.patientId ?? findPatient(args);
      // D6 + §5.11 + §2.9 BCMA — the order-context gates run before any state mutation.
      assertAdministerable(args.medicationOrderId);
      assertFiveRightsForOrder(args.medicationOrderId, patientId, args, args.administeredAt);
      const barcodeMatchResult = evaluateBarcode(
        args.medicationOrderId,
        patientId,
        args.barcodeScan,
        args.administeredAt,
      );
      const encounterId =
        args.encounterId ??
        (await autoLinkEncounter(orgId, patientId, args.administeredAt, args.mode));
      const row: AdminRow = {
        id,
        organizationId: orgId,
        patientId,
        admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId,
        mode: args.mode,
        status: "committed",
        actorKind: "clinician",
        administeredAt: args.administeredAt,
        recordedAt,
        lateEntryTier,
        administeringClinicianMembershipId: m?.membershipId ?? userId,
        witnessMembershipId,
        encounterId,
        scheduledDoseId: args.scheduledDoseId ?? null,
        comfortKitDeploymentId: args.comfortKitDeploymentId ?? null,
        ivSessionId,
        isControlledSubstance: isControlled,
        isComfortKitDrawdown,
        requiresRnReview: false,
        supersededById: null,
        barcodeMatchResult,
        data: args.data,
      };
      admins.set(id, row);
      if (sched) sched.status = "administered";
      emit("m13.administration.recorded", {
        administrationRecordId: id,
        patientId,
        admissionId: row.admissionId,
        medicationOrderId: args.medicationOrderId,
        mode: args.mode,
        administeredAt: args.administeredAt,
        isControlled,
        isComfortKitDrawdown,
        encounterId,
        scheduledDoseId: row.scheduledDoseId,
      });
      if (isControlled && witnessMembershipId)
        emit("m13.administration.controlled_witnessed", {
          administrationRecordId: id,
          witnessMembershipId,
          witnessesScope: "administration_only",
        });
      if (args.prn)
        emit("m13.prn_administration_recorded", {
          prnAdministrationId: nextId("prn"),
          administrationRecordId: id,
          patientId,
          medicationOrderId: args.medicationOrderId,
          administeredAt: args.administeredAt,
          reassessmentDueAt: new Date(Date.parse(args.administeredAt) + 60 * 60000).toISOString(),
          recommendedReassessmentScale: "esas_r",
        });
      return view(row);
    },

    async mintWitnessToken(
      orgId,
      userId,
      args,
    ): Promise<{ token: string; expiresInSeconds: number }> {
      const m = memberships.get(userId);
      const token = `${witnessSecret}.${nextId("wt")}`;
      witnessTokens.set(token, {
        patientId: args.patientId,
        medicationOrderId: args.medicationOrderId,
        administeringMembershipId: args.administeringClinicianMembershipId,
        witnessMembershipId: m?.membershipId ?? userId,
        expiresAt: Date.parse(now()) + 60_000,
      });
      return { token, expiresInSeconds: 60 };
    },

    async recordCaregiverAttested(orgId, args): Promise<AdministrationView> {
      // §2.9 D10 — even on the caregiver path the M12 consistency check (D6) is MANDATORY and the §5.11
      // five-rights validation runs against the order; a caregiver-reported dose the order does not authorize
      // is echoed back through M31 as 422 FIVE_RIGHTS_VIOLATION. The controlled-substance double-witness rule
      // does NOT apply (a caregiver is one person); encounter_id stays nullable (D9).
      assertAdministerable(args.medicationOrderId);
      assertFiveRightsForOrder(args.medicationOrderId, args.patientId, args, args.administeredAt);
      const barcodeMatchResult = evaluateBarcode(
        args.medicationOrderId,
        args.patientId,
        args.barcodeScan,
        args.administeredAt,
      );
      const id = nextId("adm");
      const row: AdminRow = {
        id,
        organizationId: orgId,
        patientId: args.patientId,
        admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId,
        mode: "single_dose",
        status: "pending_caregiver_review",
        actorKind: "caregiver_attested",
        administeredAt: args.administeredAt,
        recordedAt: now(),
        lateEntryTier: "normal",
        administeringClinicianMembershipId: null,
        witnessMembershipId: null,
        encounterId: null,
        scheduledDoseId: null,
        comfortKitDeploymentId: null,
        ivSessionId: null,
        isControlledSubstance: false,
        isComfortKitDrawdown: false,
        requiresRnReview: true,
        supersededById: null,
        barcodeMatchResult,
      };
      admins.set(id, row);
      emit("m13.administration.recorded_caregiver_attested", {
        administrationRecordId: id,
        patientId: args.patientId,
        medicationOrderId: args.medicationOrderId,
        caregiverSessionId: args.caregiverSessionId,
        requiresRnReview: true,
      });
      return view(row);
    },

    async acknowledgeCaregiver(orgId, userId, id): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.requiresRnReview = false;
      r.status = "committed";
      emit("m13.caregiver_administration.acknowledged", {
        administrationRecordId: id,
        acknowledgedBy: userId,
      });
      return view(r);
    },
    async disputeCaregiver(orgId, userId, id, reason): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.requiresRnReview = false;
      emit("m13.caregiver_administration.disputed", {
        administrationRecordId: id,
        disputedBy: userId,
        disputeReason: reason,
      });
      return view(r);
    },
    async correctAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      const original = requireAdmin(orgId, id);
      const newId = nextId("adm");
      const corrected: AdminRow = {
        ...original,
        id: newId,
        status: "committed",
        recordedAt: now(),
        supersededById: null,
      };
      admins.set(newId, corrected);
      original.status = "superseded";
      original.supersededById = newId;
      emit("m13.administration.corrected", {
        originalAdministrationId: id,
        newAdministrationId: newId,
        reason,
      });
      return view(corrected);
    },
    async voidAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.status = "voided";
      emit("m13.administration.voided", {
        administrationRecordId: id,
        voidReason: reason,
        voidedBy: userId,
      });
      return view(r);
    },
    async getAdministration(orgId, id): Promise<AdministrationView> {
      return view(requireAdmin(orgId, id));
    },
    async listAdministrations(orgId, q): Promise<AdministrationView[]> {
      return [...admins.values()]
        .filter((r) => r.organizationId === orgId && r.patientId === q.patient)
        .filter((r) => (q.since ? Date.parse(r.administeredAt) >= Date.parse(q.since) : true))
        .filter((r) => (q.until ? Date.parse(r.administeredAt) <= Date.parse(q.until) : true))
        .map(view);
    },
    async getIvSession(orgId, sessionId): Promise<IvSessionView> {
      const segs = [...admins.values()]
        .filter(
          (r) => r.organizationId === orgId && r.ivSessionId === sessionId && r.status !== "voided",
        )
        .sort(
          (a, b) =>
            Date.parse(a.administeredAt) - Date.parse(b.administeredAt) ||
            Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
        );
      if (segs.length === 0) throw new NotFoundError("iv session not found");
      const ordered: IvSegment[] = segs.map((r) => ({
        mode: r.mode as IvSegmentMode,
        administeredAt: r.administeredAt,
        ...sliceIvRateOf(r.data),
      }));
      const session = composeIvSession(sessionId, segs[0]!.medicationOrderId, ordered, null);
      return {
        sessionId,
        medicationOrderId: session.medicationOrderId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        state: deriveIvSessionState(ordered),
        segments: session.segments.map((seg) => ({
          kind: seg.mode,
          recordedAt: seg.administeredAt,
          rate: seg.rate,
          rateUnit: seg.rateUnit,
        })),
      };
    },
    async recordRefusal(orgId, userId, args): Promise<AdministrationView> {
      const id = nextId("adm");
      const row: AdminRow = {
        id,
        organizationId: orgId,
        patientId: args.patientId,
        admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId,
        mode: "single_dose",
        status: "committed",
        actorKind: "clinician",
        administeredAt: args.refusedAt,
        recordedAt: now(),
        lateEntryTier: "normal",
        administeringClinicianMembershipId: memberships.get(userId)?.membershipId ?? userId,
        witnessMembershipId: null,
        encounterId: null,
        scheduledDoseId: args.scheduledDoseId ?? null,
        comfortKitDeploymentId: null,
        ivSessionId: null,
        isControlledSubstance:
          (orders.get(args.medicationOrderId)?.medClass ?? args.medClass) ===
          "controlled_substance",
        isComfortKitDrawdown: false,
        requiresRnReview: false,
        supersededById: null,
        barcodeMatchResult: null,
      };
      admins.set(id, row);
      emit("m13.administration.refused", {
        administrationRecordId: id,
        patientId: args.patientId,
        medicationOrderId: args.medicationOrderId,
        refusalAt: args.refusedAt,
      });
      return view(row);
    },
    async offlineSync(
      orgId,
      userId,
      rows,
    ): Promise<{ synced: number; results: AdministrationView[] }> {
      const results: AdministrationView[] = [];
      for (const r of rows) results.push(await this.recordAdministration(orgId, userId, r));
      return { synced: results.length, results };
    },
    async listScheduledDoses(orgId, q): Promise<ScheduledDoseView[]> {
      return [...scheduled.values()]
        .filter((s) => s.organizationId === orgId && s.patientId === q.patient)
        .filter((s) => (q.from ? Date.parse(s.dueAt) >= Date.parse(q.from) : true))
        .filter((s) => (q.to ? Date.parse(s.dueAt) <= Date.parse(q.to) : true))
        .map((s) => ({
          id: s.id,
          patientId: s.patientId,
          medicationOrderId: s.medicationOrderId,
          dueAt: s.dueAt,
          status: s.status,
        }));
    },
    async intentionalHold(orgId, userId, id): Promise<ScheduledDoseView> {
      const s = scheduled.get(id);
      if (!s || s.organizationId !== orgId) throw new NotFoundError("scheduled dose not found");
      s.status = "intentionally_held";
      emit("m13.scheduled_dose.intentionally_held", {
        scheduledDoseId: id,
        recordedBy: userId,
        missedKind: "intentionally_held",
      });
      return {
        id: s.id,
        patientId: s.patientId,
        medicationOrderId: s.medicationOrderId,
        dueAt: s.dueAt,
        status: s.status,
      };
    },
    async listMissedDoses(orgId, q): Promise<MissedDoseView[]> {
      return [...missed.values()]
        .filter((m) => m.organizationId === orgId && m.patientId === q.patient)
        .filter((m) => (q.since ? Date.parse(m.dueAt) >= Date.parse(q.since) : true))
        .map((m) => ({
          id: m.id,
          patientId: m.patientId,
          scheduledDoseId: m.scheduledDoseId,
          medicationOrderId: m.medicationOrderId,
          dueAt: m.dueAt,
          acknowledgedAt: m.acknowledgedAt,
        }));
    },
    async acknowledgeMissed(orgId, userId, id): Promise<MissedDoseView> {
      const m = missed.get(id);
      if (!m || m.organizationId !== orgId) throw new NotFoundError("missed dose not found");
      m.acknowledgedAt = now();
      emit("m13.missed_dose.acknowledged", { missedDoseId: id, acknowledgedBy: userId });
      return {
        id: m.id,
        patientId: m.patientId,
        scheduledDoseId: m.scheduledDoseId,
        medicationOrderId: m.medicationOrderId,
        dueAt: m.dueAt,
        acknowledgedAt: m.acknowledgedAt,
      };
    },
    async listWorksheets(orgId, patient): Promise<WorksheetView[]> {
      return [...worksheets.values()]
        .filter((w) => w.organizationId === orgId && w.patientId === patient)
        .map(wView);
    },
    async getWorksheet(orgId, id): Promise<WorksheetView> {
      return wView(requireWorksheet(orgId, id));
    },
    async recordDecision(orgId, userId, id, args): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      // Plan BEFORE mutating: a decision that cannot legally produce its M12-handshake event (an
      // m12_medhx carry_forward with no medhx projection to source from, or a non-active
      // carry_forward/new_order with no supplied drug content) is refused rather than half-recorded.
      const plan = planReconciliationDecision({
        lineKind: args.lineKind,
        decisionKind: args.decision,
        medicationOrderId: args.lineKind === "m12_active" ? args.sourceId : null,
        medicationDetails: args.medicationDetails ?? null,
      });
      const lineId = `${args.lineKind}:${args.sourceId}`;
      w.decisions.set(lineId, {
        lineId,
        lineKind: args.lineKind,
        sourceId: args.sourceId,
        decision: args.decision,
        resultingMedicationOrderId: null,
      });
      w.status = "in_progress";
      if (plan.draftOrderRequested)
        emit("m13.reconciliation.draft_order_requested", {
          worksheetId: id,
          decisionId: lineId,
          patientId: w.patientId,
          decisionMadeByMembershipId: userId,
          lineKind: plan.draftOrderRequested.lineKind,
          medicationOrderDraftPayload: plan.draftOrderRequested.medicationOrderDraftPayload,
          // Always null today — see `planReconciliationDecision`'s doc for why an m12_medhx line can
          // never reach this branch (it refuses earlier), so there is never a real history record id.
          derivedFromHistoryId: null,
        });
      if (plan.discontinueRequested)
        emit("m13.reconciliation.discontinue_requested", {
          worksheetId: id,
          decisionId: lineId,
          medicationOrderId: plan.discontinueRequested.medicationOrderId,
          reason: "reconciled_discontinue",
        });
      return wView(w);
    },
    async updateDecision(
      orgId,
      userId,
      id,
      lineId,
      decision,
      resultingMedicationOrderId,
    ): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      const existing = w.decisions.get(lineId);
      if (!existing) throw new NotFoundError("decision line not found");
      w.decisions.set(lineId, {
        ...existing,
        decision,
        ...(resultingMedicationOrderId ? { resultingMedicationOrderId } : {}),
      });
      return wView(w);
    },
    async addCaregiverReportedLine(orgId, id, drugName): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      w.lineCount += 1;
      return wView(w);
    },
    async finalizeReconciliation(orgId, userId, id): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      if (w.decisions.size < w.lineCount)
        throw new ValidationError("reconciliation incomplete", [
          {
            field: "decisions",
            code: "RECONCILIATION_INCOMPLETE",
            message: `${w.lineCount - w.decisions.size} line(s) undecided`,
          },
        ]);
      w.status = "finalized";
      emit("m13.reconciliation.completed", {
        worksheetId: id,
        triggerKind: w.triggerKind,
        patientId: w.patientId,
        admissionId: w.admissionId,
        finalizedAt: now(),
        finalizedBy: userId,
        lineSummary: {},
      });
      emit("m13.reconciliation.document_requested", {
        worksheetId: id,
        formTemplate: "reconciliation_worksheet_v1",
        // Mirrors the Drizzle write path (GAP-023/024/038): M22's live render consumer files the document
        // against this patient's chart, so the request must name one.
        renderPayload: {
          patientId: w.patientId,
          admissionId: w.admissionId,
          triggerKind: w.triggerKind,
        },
      });
      return wView(w);
    },
    async voidWorksheet(orgId, userId, id, reason): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      w.status = "voided";
      emit("m13.reconciliation.voided", { worksheetId: id, voidReason: reason });
      return wView(w);
    },
    async listDeployments(orgId, patient): Promise<DeploymentView[]> {
      return [...deployments.values()]
        .filter((d) => d.organizationId === orgId && d.patientId === patient)
        .map((d) => ({
          id: d.id,
          patientId: d.patientId,
          admissionId: d.admissionId,
          disposalStatus: d.disposalStatus,
        }));
    },
    async getDeployment(orgId, id): Promise<DeploymentView> {
      const d = deployments.get(id);
      if (!d || d.organizationId !== orgId)
        throw new NotFoundError("comfort-kit deployment not found");
      return {
        id: d.id,
        patientId: d.patientId,
        admissionId: d.admissionId,
        disposalStatus: d.disposalStatus,
      };
    },
    async acknowledgeReturn(orgId, userId, id): Promise<DeploymentView> {
      const d = deployments.get(id);
      if (!d || d.organizationId !== orgId)
        throw new NotFoundError("comfort-kit deployment not found");
      d.disposalStatus = "returned";
      emit("m13.comfort_kit.returned", {
        deploymentId: id,
        returnedAt: now(),
        finalRemainingByMedication: {},
        disposalReconciliationStatus: "reconciled",
      });
      return {
        id: d.id,
        patientId: d.patientId,
        admissionId: d.admissionId,
        disposalStatus: d.disposalStatus,
      };
    },
    async getPolicy(): Promise<AdministrationPolicyView> {
      return { ...policy };
    },
    async putPolicy(orgId, patch): Promise<AdministrationPolicyView> {
      Object.assign(policy, patch);
      emit("m13.policy.changed", { policyDeltaSummary: patch });
      return { ...policy };
    },
    drainEvents(): RecordedEmarEvent[] {
      return events.splice(0, events.length);
    },
  };
}

/** Resolve the patient anchor for an administration in the slice (M12 supplies it in prod). */
function findPatient(args: RecordAdministrationArgs): string {
  return "00000000-0000-4000-8000-0000000000aa";
}
