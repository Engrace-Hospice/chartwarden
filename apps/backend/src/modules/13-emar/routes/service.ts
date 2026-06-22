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
import { resolveLateEntryTier } from "@wardenx/emar";
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
  readonly segments: readonly { kind: AdministrationMode; recordedAt: string }[];
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
  readonly prn?: { triggeringPrnReason: string; requestedByKind: string };
  readonly lateEntryReason?: string;
  readonly offlineCapture?: { deviceId: string; localId: string; capturedAt: string };
  readonly witnessToken?: string;
}
export interface RecordCaregiverAttestedArgs {
  readonly patientId: string;
  readonly medicationOrderId: string;
  readonly administeredAt: string;
  readonly caregiverSessionId: string;
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
  readonly lineKind: string;
  readonly sourceId: string;
  readonly decision: ReconciliationDecisionKind;
}

/** The §4.1 route surface the Fastify handlers compose over. */
export interface EmarRouteService extends EmarAbacResolver {
  recordAdministration(orgId: string, userId: string, args: RecordAdministrationArgs): Promise<AdministrationView>;
  mintWitnessToken(orgId: string, userId: string, args: WitnessAttestArgs): Promise<{ token: string; expiresInSeconds: number }>;
  recordCaregiverAttested(orgId: string, args: RecordCaregiverAttestedArgs): Promise<AdministrationView>;
  acknowledgeCaregiver(orgId: string, userId: string, id: string): Promise<AdministrationView>;
  disputeCaregiver(orgId: string, userId: string, id: string, reason: string): Promise<AdministrationView>;
  correctAdministration(orgId: string, userId: string, id: string, reason: string): Promise<AdministrationView>;
  voidAdministration(orgId: string, userId: string, id: string, reason: string): Promise<AdministrationView>;
  getAdministration(orgId: string, id: string): Promise<AdministrationView>;
  listAdministrations(orgId: string, q: { patient: string; since?: string; until?: string }): Promise<AdministrationView[]>;
  getIvSession(orgId: string, sessionId: string): Promise<IvSessionView>;
  recordRefusal(orgId: string, userId: string, args: RecordRefusalArgs): Promise<AdministrationView>;
  offlineSync(orgId: string, userId: string, rows: RecordAdministrationArgs[]): Promise<{ synced: number; results: AdministrationView[] }>;
  listScheduledDoses(orgId: string, q: { patient: string; from?: string; to?: string }): Promise<ScheduledDoseView[]>;
  intentionalHold(orgId: string, userId: string, id: string): Promise<ScheduledDoseView>;
  listMissedDoses(orgId: string, q: { patient: string; since?: string }): Promise<MissedDoseView[]>;
  acknowledgeMissed(orgId: string, userId: string, id: string): Promise<MissedDoseView>;
  listWorksheets(orgId: string, patient: string): Promise<WorksheetView[]>;
  getWorksheet(orgId: string, id: string): Promise<WorksheetView>;
  recordDecision(orgId: string, userId: string, id: string, args: RecordDecisionArgs): Promise<WorksheetView>;
  updateDecision(orgId: string, userId: string, id: string, lineId: string, decision: ReconciliationDecisionKind): Promise<WorksheetView>;
  addCaregiverReportedLine(orgId: string, id: string, drugName: string): Promise<WorksheetView>;
  finalizeReconciliation(orgId: string, userId: string, id: string): Promise<WorksheetView>;
  voidWorksheet(orgId: string, userId: string, id: string, reason: string): Promise<WorksheetView>;
  listDeployments(orgId: string, patient: string): Promise<DeploymentView[]>;
  getDeployment(orgId: string, id: string): Promise<DeploymentView>;
  acknowledgeReturn(orgId: string, userId: string, id: string): Promise<DeploymentView>;
  getPolicy(orgId: string): Promise<AdministrationPolicyView>;
  putPolicy(orgId: string, patch: Partial<AdministrationPolicyView>): Promise<AdministrationPolicyView>;
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
      id: a.id, organizationId: a.organizationId, patientId: a.patientId, admissionId: a.admissionId,
      medicationOrderId: a.medicationOrderId, mode: "single_dose",
      status: a.status ?? (a.actorKind === "caregiver_attested" ? "pending_caregiver_review" : "committed"),
      actorKind: a.actorKind ?? "clinician", administeredAt: now(), recordedAt: now(),
      lateEntryTier: "normal", administeringClinicianMembershipId: null, witnessMembershipId: null,
      encounterId: null, scheduledDoseId: null, comfortKitDeploymentId: null, ivSessionId: null,
      isControlledSubstance: false, isComfortKitDrawdown: false,
      requiresRnReview: a.requiresRnReview ?? a.actorKind === "caregiver_attested", supersededById: null,
    });
  }
  const scheduled = new Map<string, EmarScheduledDoseSeed & { status: ScheduledDoseStatus }>();
  for (const s of seed.scheduledDoses ?? []) scheduled.set(s.id, { ...s, status: s.status ?? "pending" });
  const missed = new Map<string, EmarMissedDoseSeed & { acknowledgedAt: string | null }>();
  for (const m of seed.missedDoses ?? []) missed.set(m.id, { ...m, acknowledgedAt: null });
  const worksheets = new Map<string, WorksheetRow>();
  for (const w of seed.worksheets ?? []) {
    worksheets.set(w.id, {
      id: w.id, organizationId: w.organizationId, patientId: w.patientId, admissionId: w.admissionId,
      triggerKind: w.triggerKind, status: w.status ?? "in_progress", lineCount: w.lineCount ?? 1,
      decisions: new Map(),
    });
  }
  const deployments = new Map<string, EmarDeploymentSeed & { disposalStatus: string }>();
  for (const d of seed.deployments ?? []) deployments.set(d.id, { ...d, disposalStatus: d.disposalStatus ?? "deployed" });
  const policy: AdministrationPolicyView = { graceWindowMinutes: 30, prnMinimumIntervalMinutes: 60, emarPdfOnCommit: false };
  const witnessTokens = new Map<string, { patientId: string; medicationOrderId: string; administeringMembershipId: string; witnessMembershipId: string; expiresAt: number }>();

  const events: RecordedEmarEvent[] = [];
  const emit = (eventName: string, payload: Record<string, unknown>): void => {
    events.push({ eventName, payload, idempotencyKey: nextId("evt") });
  };

  const view = (r: AdminRow): AdministrationView => ({ ...r });
  const wView = (w: WorksheetRow): WorksheetView => ({
    id: w.id, patientId: w.patientId, admissionId: w.admissionId, triggerKind: w.triggerKind,
    status: w.status, lineCount: w.lineCount, decisions: [...w.decisions.values()],
  });

  const requireAdmin = (orgId: string, id: string): AdminRow => {
    const r = admins.get(id);
    if (!r || r.organizationId !== orgId) throw new NotFoundError("administration not found");
    return r;
  };
  const requireWorksheet = (orgId: string, id: string): WorksheetRow => {
    const w = worksheets.get(id);
    if (!w || w.organizationId !== orgId) throw new NotFoundError("reconciliation worksheet not found");
    return w;
  };

  async function autoLinkEncounter(orgId: string, patientId: string, administeredAt: string, mode: AdministrationMode): Promise<string | null> {
    // D9 — IV-continuous session events carry a nullable encounter; only single_dose auto-links.
    if (mode !== "single_dose" || !reader) return null;
    const since = new Date(Date.parse(administeredAt) - ENCOUNTER_LINK_TOLERANCE_MS).toISOString();
    const digests = await reader.signedEncountersForPatientSince(patientId, since);
    const at = Date.parse(administeredAt);
    const within = digests.filter((d) => Math.abs(Date.parse(d.signedAt) - at) <= ENCOUNTER_LINK_TOLERANCE_MS);
    return within.length > 0 ? within[within.length - 1]!.encounterId : null;
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
    async loadCaregiverReviewFacts(orgId, administrationId, actorUserId): Promise<CaregiverReviewAbacFacts | null> {
      const r = admins.get(administrationId);
      if (!r || r.organizationId !== orgId) return null;
      return { requiresRnReview: r.requiresRnReview, actorIsRnCaseManager: caseManagers[r.patientId] === actorUserId };
    },
    async loadWorksheetTriggerKind(orgId, worksheetId): Promise<ReconciliationTriggerKind | null> {
      const w = worksheets.get(worksheetId);
      return w && w.organizationId === orgId ? w.triggerKind : null;
    },

    // ── §4.1 routes ──────────────────────────────────────────────────────────────────────────────────────
    async recordAdministration(orgId, userId, args): Promise<AdministrationView> {
      const m = memberships.get(userId);
      const recordedAt = args.offlineCapture ? now() : now();
      const lateEntryTier = resolveLateEntryTier(args.administeredAt, recordedAt);
      const isControlled = args.medClass === "controlled_substance";
      let witnessMembershipId: string | null = null;
      if (isControlled) {
        // D7 — controlled administration requires a consumed witness-attestation token.
        const claim = args.witnessToken ? witnessTokens.get(args.witnessToken) : undefined;
        if (!claim || claim.expiresAt < Date.parse(now())) throw new ValidationError("a controlled-substance administration requires a witness attestation", [{ field: "X-Witness-Attestation", code: "WITNESS_REQUIRED", message: "witness attestation missing or expired" }]);
        witnessMembershipId = claim.witnessMembershipId;
        witnessTokens.delete(args.witnessToken!); // single-use, burned on consume
      }
      const isComfortKitDrawdown = Boolean(args.comfortKitDeploymentId);
      const id = nextId("adm");
      // The patient/admission are resolved from M12 in prod; the slice derives from the scheduled dose or seed.
      const sched = args.scheduledDoseId ? scheduled.get(args.scheduledDoseId) : undefined;
      const patientId = sched?.patientId ?? findPatient(args);
      const encounterId = args.encounterId ?? (await autoLinkEncounter(orgId, patientId, args.administeredAt, args.mode));
      const row: AdminRow = {
        id, organizationId: orgId, patientId, admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId, mode: args.mode, status: "committed", actorKind: "clinician",
        administeredAt: args.administeredAt, recordedAt, lateEntryTier,
        administeringClinicianMembershipId: m?.membershipId ?? userId, witnessMembershipId, encounterId,
        scheduledDoseId: args.scheduledDoseId ?? null, comfortKitDeploymentId: args.comfortKitDeploymentId ?? null,
        ivSessionId: null, isControlledSubstance: isControlled, isComfortKitDrawdown, requiresRnReview: false,
        supersededById: null,
      };
      admins.set(id, row);
      if (sched) sched.status = "administered";
      emit("m13.administration.recorded", {
        administrationRecordId: id, patientId, admissionId: row.admissionId, medicationOrderId: args.medicationOrderId,
        mode: args.mode, administeredAt: args.administeredAt, isControlled, isComfortKitDrawdown,
        encounterId, scheduledDoseId: row.scheduledDoseId,
      });
      if (isControlled && witnessMembershipId)
        emit("m13.administration.controlled_witnessed", { administrationRecordId: id, witnessMembershipId, witnessesScope: "administration_only" });
      if (args.prn)
        emit("m13.prn_administration_recorded", {
          prnAdministrationId: nextId("prn"), administrationRecordId: id, patientId, medicationOrderId: args.medicationOrderId,
          administeredAt: args.administeredAt, reassessmentDueAt: new Date(Date.parse(args.administeredAt) + 60 * 60000).toISOString(),
          recommendedReassessmentScale: "esas_r",
        });
      return view(row);
    },

    async mintWitnessToken(orgId, userId, args): Promise<{ token: string; expiresInSeconds: number }> {
      const m = memberships.get(userId);
      const token = `${witnessSecret}.${nextId("wt")}`;
      witnessTokens.set(token, {
        patientId: args.patientId, medicationOrderId: args.medicationOrderId,
        administeringMembershipId: args.administeringClinicianMembershipId,
        witnessMembershipId: m?.membershipId ?? userId, expiresAt: Date.parse(now()) + 60_000,
      });
      return { token, expiresInSeconds: 60 };
    },

    async recordCaregiverAttested(orgId, args): Promise<AdministrationView> {
      const id = nextId("adm");
      const row: AdminRow = {
        id, organizationId: orgId, patientId: args.patientId, admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId, mode: "single_dose", status: "pending_caregiver_review",
        actorKind: "caregiver_attested", administeredAt: args.administeredAt, recordedAt: now(),
        lateEntryTier: "normal", administeringClinicianMembershipId: null, witnessMembershipId: null,
        encounterId: null, scheduledDoseId: null, comfortKitDeploymentId: null, ivSessionId: null,
        isControlledSubstance: false, isComfortKitDrawdown: false, requiresRnReview: true, supersededById: null,
      };
      admins.set(id, row);
      emit("m13.administration.recorded_caregiver_attested", {
        administrationRecordId: id, patientId: args.patientId, medicationOrderId: args.medicationOrderId,
        caregiverSessionId: args.caregiverSessionId, requiresRnReview: true,
      });
      return view(row);
    },

    async acknowledgeCaregiver(orgId, userId, id): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.requiresRnReview = false;
      r.status = "committed";
      emit("m13.caregiver_administration.acknowledged", { administrationRecordId: id, acknowledgedBy: userId });
      return view(r);
    },
    async disputeCaregiver(orgId, userId, id, reason): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.requiresRnReview = false;
      emit("m13.caregiver_administration.disputed", { administrationRecordId: id, disputedBy: userId, disputeReason: reason });
      return view(r);
    },
    async correctAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      const original = requireAdmin(orgId, id);
      const newId = nextId("adm");
      const corrected: AdminRow = { ...original, id: newId, status: "committed", recordedAt: now(), supersededById: null };
      admins.set(newId, corrected);
      original.status = "superseded";
      original.supersededById = newId;
      emit("m13.administration.corrected", { originalAdministrationId: id, newAdministrationId: newId, reason });
      return view(corrected);
    },
    async voidAdministration(orgId, userId, id, reason): Promise<AdministrationView> {
      const r = requireAdmin(orgId, id);
      r.status = "voided";
      emit("m13.administration.voided", { administrationRecordId: id, voidReason: reason, voidedBy: userId });
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
      const segs = [...admins.values()].filter((r) => r.organizationId === orgId && r.ivSessionId === sessionId);
      if (segs.length === 0) throw new NotFoundError("iv session not found");
      return { sessionId, medicationOrderId: segs[0]!.medicationOrderId, segments: segs.map((r) => ({ kind: r.mode, recordedAt: r.recordedAt })) };
    },
    async recordRefusal(orgId, userId, args): Promise<AdministrationView> {
      const id = nextId("adm");
      const row: AdminRow = {
        id, organizationId: orgId, patientId: args.patientId, admissionId: "00000000-0000-4000-8000-0000000000bb",
        medicationOrderId: args.medicationOrderId, mode: "single_dose", status: "committed", actorKind: "clinician",
        administeredAt: args.refusedAt, recordedAt: now(), lateEntryTier: "normal",
        administeringClinicianMembershipId: memberships.get(userId)?.membershipId ?? userId, witnessMembershipId: null,
        encounterId: null, scheduledDoseId: args.scheduledDoseId ?? null, comfortKitDeploymentId: null, ivSessionId: null,
        isControlledSubstance: args.medClass === "controlled_substance", isComfortKitDrawdown: false,
        requiresRnReview: false, supersededById: null,
      };
      admins.set(id, row);
      emit("m13.administration.refused", { administrationRecordId: id, patientId: args.patientId, medicationOrderId: args.medicationOrderId, refusalAt: args.refusedAt });
      return view(row);
    },
    async offlineSync(orgId, userId, rows): Promise<{ synced: number; results: AdministrationView[] }> {
      const results: AdministrationView[] = [];
      for (const r of rows) results.push(await this.recordAdministration(orgId, userId, r));
      return { synced: results.length, results };
    },
    async listScheduledDoses(orgId, q): Promise<ScheduledDoseView[]> {
      return [...scheduled.values()]
        .filter((s) => s.organizationId === orgId && s.patientId === q.patient)
        .filter((s) => (q.from ? Date.parse(s.dueAt) >= Date.parse(q.from) : true))
        .filter((s) => (q.to ? Date.parse(s.dueAt) <= Date.parse(q.to) : true))
        .map((s) => ({ id: s.id, patientId: s.patientId, medicationOrderId: s.medicationOrderId, dueAt: s.dueAt, status: s.status }));
    },
    async intentionalHold(orgId, userId, id): Promise<ScheduledDoseView> {
      const s = scheduled.get(id);
      if (!s || s.organizationId !== orgId) throw new NotFoundError("scheduled dose not found");
      s.status = "intentionally_held";
      emit("m13.scheduled_dose.intentionally_held", { scheduledDoseId: id, recordedBy: userId, missedKind: "intentionally_held" });
      return { id: s.id, patientId: s.patientId, medicationOrderId: s.medicationOrderId, dueAt: s.dueAt, status: s.status };
    },
    async listMissedDoses(orgId, q): Promise<MissedDoseView[]> {
      return [...missed.values()]
        .filter((m) => m.organizationId === orgId && m.patientId === q.patient)
        .filter((m) => (q.since ? Date.parse(m.dueAt) >= Date.parse(q.since) : true))
        .map((m) => ({ id: m.id, patientId: m.patientId, scheduledDoseId: m.scheduledDoseId, medicationOrderId: m.medicationOrderId, dueAt: m.dueAt, acknowledgedAt: m.acknowledgedAt }));
    },
    async acknowledgeMissed(orgId, userId, id): Promise<MissedDoseView> {
      const m = missed.get(id);
      if (!m || m.organizationId !== orgId) throw new NotFoundError("missed dose not found");
      m.acknowledgedAt = now();
      emit("m13.missed_dose.acknowledged", { missedDoseId: id, acknowledgedBy: userId });
      return { id: m.id, patientId: m.patientId, scheduledDoseId: m.scheduledDoseId, medicationOrderId: m.medicationOrderId, dueAt: m.dueAt, acknowledgedAt: m.acknowledgedAt };
    },
    async listWorksheets(orgId, patient): Promise<WorksheetView[]> {
      return [...worksheets.values()].filter((w) => w.organizationId === orgId && w.patientId === patient).map(wView);
    },
    async getWorksheet(orgId, id): Promise<WorksheetView> {
      return wView(requireWorksheet(orgId, id));
    },
    async recordDecision(orgId, userId, id, args): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      const lineId = `${args.lineKind}:${args.sourceId}`;
      w.decisions.set(lineId, { lineId, lineKind: args.lineKind, sourceId: args.sourceId, decision: args.decision });
      w.status = "in_progress";
      if (args.decision === "carry_forward" || args.decision === "new_order")
        emit("m13.reconciliation.draft_order_requested", { worksheetId: id, decisionId: lineId, medicationOrderDraftPayload: {}, lineKind: args.lineKind });
      if (args.decision === "discontinue")
        emit("m13.reconciliation.discontinue_requested", { worksheetId: id, decisionId: lineId, medicationOrderId: args.sourceId, reason: "reconciled_discontinue" });
      return wView(w);
    },
    async updateDecision(orgId, userId, id, lineId, decision): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      const existing = w.decisions.get(lineId);
      if (!existing) throw new NotFoundError("decision line not found");
      w.decisions.set(lineId, { ...existing, decision });
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
        throw new ValidationError("reconciliation incomplete", [{ field: "decisions", code: "RECONCILIATION_INCOMPLETE", message: `${w.lineCount - w.decisions.size} line(s) undecided` }]);
      w.status = "finalized";
      emit("m13.reconciliation.completed", { worksheetId: id, triggerKind: w.triggerKind, patientId: w.patientId, admissionId: w.admissionId, finalizedAt: now(), finalizedBy: userId, lineSummary: {} });
      emit("m13.reconciliation.document_requested", { worksheetId: id, formTemplate: "reconciliation_worksheet_v1", renderPayload: {} });
      return wView(w);
    },
    async voidWorksheet(orgId, userId, id, reason): Promise<WorksheetView> {
      const w = requireWorksheet(orgId, id);
      w.status = "voided";
      emit("m13.reconciliation.voided", { worksheetId: id, voidReason: reason });
      return wView(w);
    },
    async listDeployments(orgId, patient): Promise<DeploymentView[]> {
      return [...deployments.values()].filter((d) => d.organizationId === orgId && d.patientId === patient).map((d) => ({ id: d.id, patientId: d.patientId, admissionId: d.admissionId, disposalStatus: d.disposalStatus }));
    },
    async getDeployment(orgId, id): Promise<DeploymentView> {
      const d = deployments.get(id);
      if (!d || d.organizationId !== orgId) throw new NotFoundError("comfort-kit deployment not found");
      return { id: d.id, patientId: d.patientId, admissionId: d.admissionId, disposalStatus: d.disposalStatus };
    },
    async acknowledgeReturn(orgId, userId, id): Promise<DeploymentView> {
      const d = deployments.get(id);
      if (!d || d.organizationId !== orgId) throw new NotFoundError("comfort-kit deployment not found");
      d.disposalStatus = "returned";
      emit("m13.comfort_kit.returned", { deploymentId: id, returnedAt: now(), finalRemainingByMedication: {}, disposalReconciliationStatus: "reconciled" });
      return { id: d.id, patientId: d.patientId, admissionId: d.admissionId, disposalStatus: d.disposalStatus };
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
