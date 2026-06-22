// apps/backend/src/modules/08-encounters/routes/service.ts — M8-T09 the EncounterRouteService + an
// in-memory slice (§4.1). The route handlers compose over this; production injects a Drizzle-backed
// service (writes under `withOrgContext` so RLS scopes by `app.org_id`). The slice also exposes an
// EncounterAbacResolver over the SAME dataset so M8's §4.6 `cosigner_role_match` predicate resolves an
// encounter's author/discipline without a cross-module schema import. Mirrors the M6/M7 routes/service.ts
// precedent: pure-ish (no clock except the injected `now()` so version/sign timestamps are deterministic
// in tests), every guard failure surfaces as an `EncounterStateError` (the §2.7 code → HTTP map).
//
// SCOPE (T09): the route inventory + the §4.5 RBAC gating + the §4.6 cosigner predicate. The heavier
// authoring surfaces (vitals/mileage, the F2F dual-write happy path) land in M8-T10; here they are lean
// success handlers over the same optimistic-locked records so the inventory is wired and smoke-tested.
import type {
  EncounterDiscipline,
  EncounterStatus,
  EncounterType,
  LocalDate,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import {
  type F2fAttestationWrite,
  type MileageInput,
  type VitalsInput,
  planF2fDualWrite,
  planMileageCapture,
  planVitalsCapture,
} from "../authoring/index";
import { type CosignatureState, transitionCosignature } from "../cosignature/index";
import { type AddendumState, transitionAddendum } from "../lifecycle/addendum";
import { transitionEncounter } from "../lifecycle/encounter";
import {
  checkEncounterDisciplinePair,
  checkMutableForEdit,
  checkParentNotVoided,
  checkServiceDateNotFuture,
  checkVersion,
} from "../lifecycle/validation";

/** The §4.6 owner facts the `cosigner_role_match` predicate resolves for one encounter (RLS-backstopped). */
export interface EncounterAbacFacts {
  readonly encounterId: string;
  readonly patientId: string;
  readonly discipline: EncounterDiscipline;
  /** The membership/user that authored the draft — the no-self-cosign comparison (§4.6). */
  readonly authoredByUserId: string;
}

/** Loads an encounter's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface EncounterAbacResolver {
  loadEncounter(organizationId: string, encounterId: string): Promise<EncounterAbacFacts | null>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ────────────────────

export interface CreateEncounterArgs {
  readonly patientId: string;
  readonly admissionId: string;
  readonly visitId?: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: LocalDate;
  readonly faceToFaceEncounterId?: string;
  readonly bereavementPlanId?: string;
}

export interface CreatedEncounter {
  readonly id: string;
  readonly status: "draft";
  readonly templateKey: string;
  readonly templateVersion: string;
  readonly version: number;
}

/** Route result for a vitals capture/edit — the derived facts that decorate `m8.vitals.captured` (§4.4). */
export interface VitalsResult {
  readonly vitalsId: string;
  readonly fieldsCaptured: readonly string[];
  readonly abnormalFlags: readonly string[];
  readonly bmi: string | null;
}

/** Route result for a mileage capture/edit — the authoritative figure (D10). */
export interface MileageResult {
  readonly mileageId: string;
  readonly milesDriven: string;
  readonly source: string;
}

export interface EncounterView {
  readonly id: string;
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly visitId: string | null;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly serviceDate: LocalDate;
  readonly status: EncounterStatus;
  readonly lateEntryTier: string;
  readonly version: number;
  readonly authoredByUserId: string;
  readonly isF2f: boolean;
  readonly signedAt: string | null;
  readonly cosignedAt: string | null;
}

/** The route service the §4.1 handlers compose over. Every method is org-scoped (RLS in prod). */
export interface EncounterRouteService {
  createDraft(
    organizationId: string,
    actorUserId: string,
    args: CreateEncounterArgs,
  ): Promise<CreatedEncounter>;
  getEncounter(organizationId: string, encounterId: string): Promise<EncounterView>;
  updateSelections(
    organizationId: string,
    encounterId: string,
    ifVersion: number,
  ): Promise<{ version: number; layer1Preview: string }>;
  captureVitals(
    organizationId: string,
    encounterId: string,
    input: VitalsInput,
  ): Promise<VitalsResult>;
  editVitals(
    organizationId: string,
    encounterId: string,
    vitalsId: string,
    input: VitalsInput,
  ): Promise<VitalsResult>;
  captureMileage(
    organizationId: string,
    encounterId: string,
    input: MileageInput,
  ): Promise<MileageResult>;
  editMileage(
    organizationId: string,
    encounterId: string,
    input: MileageInput,
  ): Promise<MileageResult>;
  addCarePlanLink(organizationId: string, encounterId: string): Promise<{ linkId: string }>;
  removeCarePlanLink(organizationId: string, encounterId: string, linkId: string): Promise<void>;
  documentEvvMissing(
    organizationId: string,
    encounterId: string,
  ): Promise<{ evvBracketState: string }>;
  finalize(
    organizationId: string,
    encounterId: string,
    at: LocalDate,
  ): Promise<{ status: "finalized"; version: number }>;
  enhanceHearthnote(
    organizationId: string,
    encounterId: string,
  ): Promise<{ modificationId: string }>;
  recordModificationDecision(
    organizationId: string,
    encounterId: string,
    modId: string,
  ): Promise<{ modificationId: string }>;
  sign(
    organizationId: string,
    encounterId: string,
    args: { stepUpFresh: boolean; at: LocalDate },
  ): Promise<{
    status: "signed" | "cosign_pending";
    signedAt: string;
    cosignatureRequestId: string | null;
  }>;
  lateEntryOverride(
    organizationId: string,
    encounterId: string,
  ): Promise<{ status: EncounterStatus }>;
  administrativeOverride(
    organizationId: string,
    encounterId: string,
  ): Promise<{ status: EncounterStatus }>;
  voidEncounter(
    organizationId: string,
    encounterId: string,
    args: { isAdmin: boolean; reason: string; at: LocalDate },
  ): Promise<{ status: "voided" }>;
  getCosignature(
    organizationId: string,
    encounterId: string,
  ): Promise<{ status: CosignatureState | null }>;
  cosignAcknowledge(
    organizationId: string,
    encounterId: string,
    at: LocalDate,
  ): Promise<{ status: CosignatureState }>;
  cosignSign(
    organizationId: string,
    encounterId: string,
    args: { isQualifiedRn: boolean; at: LocalDate },
  ): Promise<{ status: EncounterStatus; cosignedAt: string }>;
  supervisorRelease(
    organizationId: string,
    encounterId: string,
    args: { isSupervisor: boolean; reason: string; at: LocalDate },
  ): Promise<{ status: CosignatureState }>;
  createAddendum(
    organizationId: string,
    encounterId: string,
  ): Promise<{ id: string; status: "draft" }>;
  updateAddendumSelections(
    organizationId: string,
    encounterId: string,
    addendumId: string,
  ): Promise<{ version: number }>;
  finalizeAddendum(
    organizationId: string,
    encounterId: string,
    addendumId: string,
  ): Promise<{ status: "finalized" }>;
  signAddendum(
    organizationId: string,
    encounterId: string,
    addendumId: string,
    args: { stepUpFresh: boolean; at: LocalDate },
  ): Promise<{ status: "signed"; signedAt: string }>;
  listEncounters(organizationId: string): Promise<{ encounters: EncounterView[] }>;
  cosignatureQueue(organizationId: string): Promise<{ encounters: EncounterView[] }>;
  myDrafts(organizationId: string, actorUserId: string): Promise<{ encounters: EncounterView[] }>;
  billable(
    organizationId: string,
    encounterIds: readonly string[],
  ): Promise<{ billability: { encounterId: string; billable: boolean }[] }>;
  signedSince(organizationId: string, since: string): Promise<{ encounters: EncounterView[] }>;
  renderPayload(
    organizationId: string,
    encounterId: string,
  ): Promise<{ encounterId: string; final: string }>;
}

// ── in-memory record + slice ────────────────────────────────────────────────────────────────────────

interface EncounterRecord {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  visitId: string | null;
  encounterType: EncounterType;
  discipline: EncounterDiscipline;
  serviceDate: LocalDate;
  status: EncounterStatus;
  lateEntryTier: string;
  version: number;
  authoredByUserId: string;
  isF2f: boolean;
  faceToFaceEncounterId: string | null;
  signedAt: string | null;
  cosignedAt: string | null;
  cosignature: CosignatureState | null;
  addenda: Map<string, { id: string; status: AddendumState; version: number }>;
  vitals: Map<string, VitalsInput>;
  mileage: { id: string; milesDriven: string; source: string } | null;
}

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface EncounterRouteSeed {
  readonly encounters?: ReadonlyArray<
    Partial<EncounterRecord> & { id: string; organizationId: string; patientId: string }
  >;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M6/M8 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

const toView = (r: EncounterRecord): EncounterView => ({
  id: r.id,
  organizationId: r.organizationId,
  patientId: r.patientId,
  admissionId: r.admissionId,
  visitId: r.visitId,
  encounterType: r.encounterType,
  discipline: r.discipline,
  serviceDate: r.serviceDate,
  status: r.status,
  lateEntryTier: r.lateEntryTier,
  version: r.version,
  authoredByUserId: r.authoredByUserId,
  isF2f: r.isF2f,
  signedAt: r.signedAt,
  cosignedAt: r.cosignedAt,
});

/**
 * Build an in-memory {@link EncounterRouteService} + a matching {@link EncounterAbacResolver} over one
 * shared dataset — no DB, deterministic, RLS-free (the slice scopes every read by the passed `organizationId`
 * so a cross-tenant id is a non-leaking 404, mirroring how RLS would behave in prod).
 */
/** Read-only inspection surface over the slice's state (the §7 workflow tests assert against it). */
export interface EncounterBackendInspect {
  /** The `m8.*` outbox events published so far (collected from the §2.8 transition/authoring effects). */
  events(): ReadonlyArray<{ event: string; encounterId: string }>;
  /** The M6 attestation writes the F2F dual-write requested (the cross-module side of D1, §7.4). */
  f2fAttestations(): ReadonlyArray<F2fAttestationWrite>;
  /** The resolved mileage row on an encounter, if any (D10). */
  mileageOf(encounterId: string): { id: string; milesDriven: string; source: string } | null;
  /** The number of vitals rows captured on an encounter (§2.2 — 0..n per visit). */
  vitalsCount(encounterId: string): number;
}

export function createInMemoryEncounterBackend(seed: EncounterRouteSeed = {}): {
  service: EncounterRouteService;
  resolver: EncounterAbacResolver;
  inspect: EncounterBackendInspect;
} {
  const byId = new Map<string, EncounterRecord>();
  for (const e of seed.encounters ?? []) {
    byId.set(e.id, {
      admissionId: "00000000-0000-4000-8000-000000000000",
      visitId: null,
      encounterType: "routine_visit",
      discipline: "rn",
      serviceDate: "2026-01-01",
      status: "draft",
      lateEntryTier: "normal",
      version: 0,
      authoredByUserId: "seed",
      isF2f: false,
      faceToFaceEncounterId: null,
      signedAt: null,
      cosignedAt: null,
      cosignature: null,
      addenda: new Map(),
      vitals: new Map(),
      mileage: null,
      ...e,
    });
  }
  let created = 0;
  let subCounter = 0;
  const now = () => "2026-06-21T12:00:00.000Z";

  /** Published `m8.*` outbox events (collected from the §2.8 transition/authoring effects, for tests). */
  const events: { event: string; encounterId: string }[] = [];
  /** The M6 attestation writes the F2F dual-write requested (the cross-module side of D1, for tests). */
  const f2fAttestations: F2fAttestationWrite[] = [];
  const recordOutbox = (
    encounterId: string,
    effects: ReadonlyArray<{ kind: string; event?: string }>,
  ): void => {
    for (const e of effects)
      if (e.kind === "outbox" && e.event) events.push({ event: e.event, encounterId });
  };

  /** Load an encounter scoped to the tenant; a missing/cross-tenant id is a non-leaking 404. */
  function load(organizationId: string, encounterId: string): EncounterRecord {
    const r = byId.get(encounterId);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("encounter");
    return r;
  }

  const subId = () => uuidFromCounter("1", ++subCounter);

  const service: EncounterRouteService = {
    async createDraft(organizationId, actorUserId, args) {
      // §2.7 service guards that run before any write (the rest land with authoring in M8-T10).
      checkEncounterDisciplinePair({
        encounterType: args.encounterType,
        discipline: args.discipline,
      });
      checkServiceDateNotFuture({ serviceDate: args.serviceDate, today: now().slice(0, 10) });
      const id = uuidFromCounter("e", ++created);
      byId.set(id, {
        id,
        organizationId,
        patientId: args.patientId,
        admissionId: args.admissionId,
        visitId: args.visitId ?? null,
        encounterType: args.encounterType,
        discipline: args.discipline,
        serviceDate: args.serviceDate,
        status: "draft",
        lateEntryTier: "normal",
        version: 0,
        authoredByUserId: actorUserId,
        isF2f: args.encounterType === "face_to_face" || args.faceToFaceEncounterId !== undefined,
        faceToFaceEncounterId: args.faceToFaceEncounterId ?? null,
        signedAt: null,
        cosignedAt: null,
        cosignature: null,
        addenda: new Map(),
        vitals: new Map(),
        mileage: null,
      });
      return {
        id,
        status: "draft",
        templateKey: `${args.discipline}_${args.encounterType}_v1`,
        templateVersion: "v1",
        version: 0,
      };
    },

    async getEncounter(organizationId, encounterId) {
      return toView(load(organizationId, encounterId));
    },

    async updateSelections(organizationId, encounterId, ifVersion) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      checkVersion({ expected: ifVersion, actual: r.version });
      r.version += 1;
      return { version: r.version, layer1Preview: "" };
    },

    async captureVitals(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planVitalsCapture(input); // validates envelopes + CNI reason (§2.2)
      const vitalsId = subId();
      r.vitals.set(vitalsId, input);
      recordOutbox(r.id, plan.effects);
      return {
        vitalsId,
        fieldsCaptured: plan.fieldsCaptured,
        abnormalFlags: plan.abnormalFlags,
        bmi: plan.bmi,
      };
    },
    async editVitals(organizationId, encounterId, vitalsId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      if (!r.vitals.has(vitalsId)) throw new NotFoundError("vitals");
      const plan = planVitalsCapture(input);
      r.vitals.set(vitalsId, input);
      recordOutbox(r.id, plan.effects);
      return {
        vitalsId,
        fieldsCaptured: plan.fieldsCaptured,
        abnormalFlags: plan.abnormalFlags,
        bmi: plan.bmi,
      };
    },
    async captureMileage(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planMileageCapture(input); // validates odometer order + override reason (D10)
      const mileageId = r.mileage?.id ?? subId(); // D10 — 0..1 per encounter (unique on encounter_id)
      r.mileage = { id: mileageId, milesDriven: plan.milesDriven, source: plan.source };
      recordOutbox(r.id, plan.effects);
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    },
    async editMileage(organizationId, encounterId, input) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      const plan = planMileageCapture(input);
      const mileageId = r.mileage?.id ?? subId();
      r.mileage = { id: mileageId, milesDriven: plan.milesDriven, source: plan.source };
      recordOutbox(r.id, plan.effects);
      return { mileageId, milesDriven: plan.milesDriven, source: plan.source };
    },
    async addCarePlanLink(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      return { linkId: subId() };
    },
    async removeCarePlanLink(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
    },
    async documentEvvMissing(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      checkMutableForEdit({ status: r.status });
      return { evvBracketState: "evv_missing_documented" };
    },

    async finalize(organizationId, encounterId, at) {
      const r = load(organizationId, encounterId);
      const t = transitionEncounter(r.status, { type: "finalize", gatePreviewPassed: true, at });
      r.status = t.to;
      r.version += 1;
      recordOutbox(r.id, t.effects);
      return { status: "finalized", version: r.version };
    },

    async enhanceHearthnote(organizationId, encounterId) {
      load(organizationId, encounterId);
      return { modificationId: subId() };
    },
    async recordModificationDecision(organizationId, encounterId, modId) {
      load(organizationId, encounterId);
      return { modificationId: modId };
    },

    async sign(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      // §7.4 D1 — an F2F encounter signs as one atomic dual-write: the M8 clinical note + the M6
      // `face_to_face_encounter` attestation row. The plan produces the M6 write descriptor; the slice
      // records it here (the composition root hands it to M6's writer in prod). A failed gate / stale
      // step-up throws inside the plan → neither side is written (structural abort).
      if (r.isF2f) {
        const plan = planF2fDualWrite({
          status: r.status,
          encounterId: r.id,
          faceToFaceEncounterId: r.faceToFaceEncounterId,
          discipline: r.discipline,
          gatePassed: true,
          stepUpFresh: args.stepUpFresh,
          at: args.at,
        });
        r.status = plan.encounter.to;
        r.signedAt = now();
        f2fAttestations.push(plan.attestation);
        recordOutbox(r.id, plan.encounter.effects);
        return { status: "signed", signedAt: r.signedAt, cosignatureRequestId: null };
      }
      const t = transitionEncounter(r.status, {
        type: "sign",
        discipline: r.discipline,
        gatePassed: true,
        stepUpFresh: args.stepUpFresh,
        isF2f: false,
        f2fDualWriteSatisfied: true,
        eligibleCosignerExists: true,
        at: args.at,
      });
      r.status = t.to;
      r.signedAt = now();
      recordOutbox(r.id, t.effects);
      if (t.to === "cosign_pending") {
        r.cosignature = "routed";
        return { status: "cosign_pending", signedAt: r.signedAt, cosignatureRequestId: subId() };
      }
      return { status: "signed", signedAt: r.signedAt, cosignatureRequestId: null };
    },

    async lateEntryOverride(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      r.lateEntryTier = "significant_late_entry";
      return { status: r.status };
    },
    async administrativeOverride(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      r.lateEntryTier = "administrative_override";
      return { status: r.status };
    },

    async voidEncounter(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      const t = transitionEncounter(r.status, {
        type: "void",
        isAdmin: args.isAdmin,
        reason: args.reason,
        at: args.at,
      });
      r.status = t.to;
      recordOutbox(r.id, t.effects);
      return { status: "voided" };
    },

    async getCosignature(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return { status: r.cosignature };
    },
    async cosignAcknowledge(organizationId, encounterId, at) {
      const r = load(organizationId, encounterId);
      const t = transitionCosignature(r.cosignature ?? "routed", { type: "acknowledge", at });
      r.cosignature = t.to;
      return { status: t.to };
    },
    async cosignSign(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      const ct = transitionCosignature(r.cosignature ?? "routed", {
        type: "sign",
        isQualifiedRn: args.isQualifiedRn,
        at: args.at,
      });
      r.cosignature = ct.to;
      const et = transitionEncounter(r.status, { type: "recordCosignature", at: args.at });
      r.status = et.to;
      r.cosignedAt = now();
      recordOutbox(r.id, et.effects);
      return { status: r.status, cosignedAt: r.cosignedAt };
    },
    async supervisorRelease(organizationId, encounterId, args) {
      const r = load(organizationId, encounterId);
      const t = transitionCosignature(r.cosignature ?? "hard_cap_reached", {
        type: "release",
        isSupervisor: args.isSupervisor,
        reason: args.reason,
        at: args.at,
      });
      r.cosignature = t.to;
      return { status: t.to };
    },

    async createAddendum(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      checkParentNotVoided({ parentStatus: r.status });
      const id = subId();
      r.addenda.set(id, { id, status: "draft", version: 0 });
      return { id, status: "draft" };
    },
    async updateAddendumSelections(organizationId, encounterId, addendumId) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      a.version += 1;
      return { version: a.version };
    },
    async finalizeAddendum(organizationId, encounterId, addendumId) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      const t = transitionAddendum(a.status, {
        type: "finalize",
        gatePreviewPassed: true,
        at: now().slice(0, 10),
      });
      a.status = t.to;
      return { status: "finalized" };
    },
    async signAddendum(organizationId, encounterId, addendumId, args) {
      const r = load(organizationId, encounterId);
      const a = r.addenda.get(addendumId);
      if (!a) throw new NotFoundError("addendum");
      const t = transitionAddendum(a.status, {
        type: "sign",
        gatePassed: true,
        stepUpFresh: args.stepUpFresh,
        at: args.at,
      });
      a.status = t.to;
      return { status: "signed", signedAt: now() };
    },

    async listEncounters(organizationId) {
      return {
        encounters: [...byId.values()]
          .filter((r) => r.organizationId === organizationId)
          .map(toView),
      };
    },
    async cosignatureQueue(organizationId) {
      return {
        encounters: [...byId.values()]
          .filter((r) => r.organizationId === organizationId && r.status === "cosign_pending")
          .map(toView),
      };
    },
    async myDrafts(organizationId, actorUserId) {
      return {
        encounters: [...byId.values()]
          .filter(
            (r) =>
              r.organizationId === organizationId &&
              r.status === "draft" &&
              r.authoredByUserId === actorUserId,
          )
          .map(toView),
      };
    },
    async billable(organizationId, encounterIds) {
      const wanted = new Set(encounterIds);
      return {
        billability: [...byId.values()]
          .filter((r) => r.organizationId === organizationId && wanted.has(r.id))
          .map((r) => ({
            encounterId: r.id,
            billable: r.status === "signed" || r.status === "cosigned",
          })),
      };
    },
    async signedSince(organizationId, since) {
      return {
        encounters: [...byId.values()]
          .filter(
            (r) =>
              r.organizationId === organizationId && r.signedAt !== null && r.signedAt >= since,
          )
          .map(toView),
      };
    },
    async renderPayload(organizationId, encounterId) {
      const r = load(organizationId, encounterId);
      return { encounterId: r.id, final: "" };
    },
  };

  const resolver: EncounterAbacResolver = {
    async loadEncounter(organizationId, encounterId) {
      const r = byId.get(encounterId);
      if (!r || r.organizationId !== organizationId) return null;
      return {
        encounterId: r.id,
        patientId: r.patientId,
        discipline: r.discipline,
        authoredByUserId: r.authoredByUserId,
      };
    },
  };

  const inspect: EncounterBackendInspect = {
    events: () => events,
    f2fAttestations: () => f2fAttestations,
    mileageOf: (encounterId) => byId.get(encounterId)?.mileage ?? null,
    vitalsCount: (encounterId) => byId.get(encounterId)?.vitals.size ?? 0,
  };

  return { service, resolver, inspect };
}
