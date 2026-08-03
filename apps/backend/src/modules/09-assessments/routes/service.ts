// apps/backend/src/modules/09-assessments/routes/service.ts — M9-T05 the AssessmentRouteService + an
// in-memory slice (§4.1). The route handlers compose over this; production injects a Drizzle-backed
// service (writes under `withOrgContext` so RLS scopes by `app.org_id`). The slice also exposes an
// AssessmentAbacResolver over the SAME dataset so M9's §4.7 `m9.cosigner_role_match` predicate resolves an
// assessment's recorder/discipline without a cross-module schema import. Mirrors the M6/M7/M8
// routes/service.ts precedent: pure-ish (no clock except the injected `now()`), every guard failure
// surfaces as an `AssessmentStateError` (the §4.4 code → HTTP map).
//
// The recording pipeline is the §10 task-#5 order: admission-anchor (M6 facts) → policy-gate → license-gate
// (D3) → discipline-gate (D8) → DPOA proxy-attribution gate → server-authoritative score (D6) → set
// `sud_context` flag (NO consent gate on write — M09-F05 / ADR-0014 D1) → insert → cosign-required (§7.4).
// The Part 2 SUD enforcement lives on the READ path (`redacted` projection); the disclosure HARD-deny
// (`SUD_DISCLOSURE_DENIED`) is for FHIR/portal egress, not these chart routes (§4.4).
import {
  cosignRequiredFor,
  computeScaleLicenseStatus,
  disciplineCanRecordScale,
  isLicensedScale,
  planCorrection,
  planCosignAttest,
  require_,
  scoreAssessment,
  transitionSignificantChange,
} from "@wardenx/assessments";
import type {
  AssessmentActingAs,
  AssessmentStatus,
  ScaleDelta,
  ScaleSeries,
  ScaleSeriesPoint,
  ScaleType,
  SignificantChangeRuleId,
  SignificantChangeStatus,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";

/** The §4.7 recorder facts the `m9.cosigner_role_match` predicate resolves for one row (RLS-backstopped). */
export interface AssessmentAbacFacts {
  readonly assessmentId: string;
  readonly patientId: string;
  readonly recorderDiscipline: string;
  /** The membership/user that recorded the row — the no-self-cosign comparison (§7.4 / §6). */
  readonly recordedByUserId: string;
}

/** Loads an assessment's org-scoped recorder facts (in-memory in the slice; Drizzle in prod under RLS). */
export interface AssessmentAbacResolver {
  loadAssessment(organizationId: string, assessmentId: string): Promise<AssessmentAbacFacts | null>;
}

// ── route DTOs (in-memory; the Drizzle adapter projects rows to the SAME shapes) ────────────────────

export interface RecordAssessmentArgs {
  readonly admissionId: string;
  readonly scaleType: ScaleType;
  readonly capturedAt: string;
  readonly data: Record<string, unknown>;
  readonly recorderDiscipline: string;
  readonly sourceEncounterId?: string;
  readonly actingAs?: AssessmentActingAs;
  readonly actingConsentId?: string;
  readonly sudContext?: boolean;
}

export interface CorrectAssessmentArgs extends RecordAssessmentArgs {
  readonly correctionReason: string;
}

export interface AssessmentView {
  readonly id: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly scaleType: ScaleType;
  readonly scaleVersion: string;
  readonly data: Record<string, unknown>;
  readonly score: number | null;
  readonly scoreInterpretation: string | null;
  readonly capturedAt: string;
  readonly capturedByDiscipline: string;
  readonly recordedByUserId: string;
  readonly sourceEncounterId: string | null;
  readonly cosignRequired: boolean;
  readonly cosignedAt: string | null;
  readonly sudContext: boolean;
  readonly actingAs: AssessmentActingAs;
  readonly actingConsentId: string | null;
  readonly status: AssessmentStatus;
  readonly correctsAssessmentId: string | null;
  readonly correctionReason: string | null;
  /** True if SUD content was filtered for this caller on the read path (§7.6); never on the write echo. */
  readonly redacted: boolean;
  readonly version: number;
}

export interface SignificantChangeView {
  readonly id: string;
  readonly assessmentId: string;
  readonly priorAssessmentId: string | null;
  readonly ruleId: SignificantChangeRuleId;
  readonly status: SignificantChangeStatus;
  readonly severity: "medium" | "high";
}

export interface ScaleLicenseView {
  readonly id: string;
  readonly scaleType: ScaleType;
  readonly vendor: string;
  readonly effectiveDate: string;
  readonly expiresAt: string;
  readonly seats: number | null;
  readonly status: "active" | "pending_renewal" | "expired";
}

export interface ScalePolicyView {
  readonly scaleType: ScaleType;
  readonly enabled: boolean;
}

export interface AssessmentRouteService {
  recordAssessment(organizationId: string, actorUserId: string, patientId: string, args: RecordAssessmentArgs): Promise<AssessmentView>;
  correctAssessment(organizationId: string, actorUserId: string, patientId: string, targetId: string, ifVersion: number, args: CorrectAssessmentArgs): Promise<AssessmentView>;
  listAssessments(organizationId: string, patientId: string): Promise<{ assessments: AssessmentView[] }>;
  getAssessment(organizationId: string, patientId: string, id: string): Promise<AssessmentView>;
  summary(organizationId: string, patientId: string): Promise<{ patientId: string; latest: AssessmentView[] }>;
  latestScale(organizationId: string, patientId: string, scaleType: ScaleType): Promise<AssessmentView>;
  seriesScale(organizationId: string, patientId: string, scaleType: ScaleType, from: string, to: string): Promise<ScaleSeries>;
  deltaScale(organizationId: string, patientId: string, scaleType: ScaleType, from: string, to: string): Promise<ScaleDelta>;
  latestBatch(organizationId: string, patientId: string, scaleTypes: readonly ScaleType[]): Promise<{ latest: AssessmentView[] }>;
  cosign(organizationId: string, actorUserId: string, id: string, cosignerDiscipline: string): Promise<{ assessmentId: string; cosigned: true }>;
  listSignificantChanges(organizationId: string, patientId: string): Promise<{ events: SignificantChangeView[] }>;
  acknowledgeChange(organizationId: string, eventId: string): Promise<{ status: SignificantChangeStatus }>;
  listLicenses(organizationId: string): Promise<{ licenses: ScaleLicenseView[] }>;
  createLicense(organizationId: string, args: { scaleType: ScaleType; vendor: string; effectiveDate: string; expiresAt: string; seats?: number }): Promise<ScaleLicenseView>;
  updateLicense(organizationId: string, id: string, args: { vendor?: string; effectiveDate?: string; expiresAt?: string; seats?: number }): Promise<ScaleLicenseView>;
  listPolicies(organizationId: string): Promise<{ policies: ScalePolicyView[] }>;
  updatePolicy(organizationId: string, scaleType: ScaleType, enabled: boolean): Promise<ScalePolicyView>;
}

// ── in-memory records + slice ─────────────────────────────────────────────────────────────────────────

interface AssessmentRecord {
  id: string;
  organizationId: string;
  patientId: string;
  admissionId: string;
  scaleType: ScaleType;
  scaleVersion: string;
  data: Record<string, unknown>;
  score: number | null;
  scoreInterpretation: string | null;
  capturedAt: string;
  capturedByDiscipline: string;
  recordedByUserId: string;
  sourceEncounterId: string | null;
  cosignRequired: boolean;
  cosignedAt: string | null;
  sudContext: boolean;
  actingAs: AssessmentActingAs;
  actingConsentId: string | null;
  status: AssessmentStatus;
  correctsAssessmentId: string | null;
  correctionReason: string | null;
  version: number;
}

interface AdmissionFact {
  id: string;
  organizationId: string;
  patientId: string;
  status: string;
  activatedAt: string;
}

interface ConsentFact {
  organizationId: string;
  patientId: string;
  dpoaActive?: boolean;
  sudReleaseActive?: boolean;
}

interface ScaleLicenseRecord {
  id: string;
  organizationId: string;
  scaleType: ScaleType;
  vendor: string;
  effectiveDate: string;
  expiresAt: string;
  seats: number | null;
}

interface SignificantChangeRecord {
  id: string;
  organizationId: string;
  patientId: string;
  assessmentId: string;
  priorAssessmentId: string | null;
  ruleId: SignificantChangeRuleId;
  status: SignificantChangeStatus;
  severity: "medium" | "high";
}

/** Deterministic, I/O-free seed for the in-memory route service (slice + smoke tests). */
export interface AssessmentRouteSeed {
  readonly admissions?: ReadonlyArray<AdmissionFact>;
  readonly consents?: ReadonlyArray<ConsentFact>;
  readonly licenses?: ReadonlyArray<ScaleLicenseRecord>;
  /** scaleTypes EXPLICITLY disabled per org (absent ⇒ enabled by default). */
  readonly disabledPolicies?: ReadonlyArray<{ organizationId: string; scaleType: ScaleType }>;
  readonly assessments?: ReadonlyArray<Partial<AssessmentRecord> & { id: string; organizationId: string; patientId: string; scaleType: ScaleType }>;
  readonly significantChanges?: ReadonlyArray<SignificantChangeRecord>;
  /** Injected clock (deterministic in tests; defaults to the server clock). */
  readonly now?: () => string;
}

/** Pads `n` to a uuid-shaped id so created ids round-trip through uuid-validated bodies (M6/M8 slice). */
function uuidFromCounter(prefixNibble: string, n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `${prefixNibble}0000000-0000-4000-8000-${hex}`;
}

const SCALE_VERSION = "v1";

function fullRecord(seed: Partial<AssessmentRecord> & { id: string; organizationId: string; patientId: string; scaleType: ScaleType }): AssessmentRecord {
  return {
    admissionId: seed.admissionId ?? uuidFromCounter("3", 0),
    scaleVersion: seed.scaleVersion ?? SCALE_VERSION,
    data: seed.data ?? {},
    score: seed.score ?? null,
    scoreInterpretation: seed.scoreInterpretation ?? null,
    capturedAt: seed.capturedAt ?? "2026-06-20T12:00:00.000Z",
    capturedByDiscipline: seed.capturedByDiscipline ?? "rn",
    recordedByUserId: seed.recordedByUserId ?? "seed_user",
    sourceEncounterId: seed.sourceEncounterId ?? null,
    cosignRequired: seed.cosignRequired ?? false,
    cosignedAt: seed.cosignedAt ?? null,
    sudContext: seed.sudContext ?? false,
    actingAs: seed.actingAs ?? "self",
    actingConsentId: seed.actingConsentId ?? null,
    status: seed.status ?? "active",
    correctsAssessmentId: seed.correctsAssessmentId ?? null,
    correctionReason: seed.correctionReason ?? null,
    version: seed.version ?? 1,
    id: seed.id,
    organizationId: seed.organizationId,
    patientId: seed.patientId,
    scaleType: seed.scaleType,
  };
}

const toView = (r: AssessmentRecord, redacted = false): AssessmentView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  scaleType: r.scaleType,
  scaleVersion: r.scaleVersion,
  data: redacted ? {} : r.data,
  score: redacted ? null : r.score,
  scoreInterpretation: redacted ? null : r.scoreInterpretation,
  capturedAt: r.capturedAt,
  capturedByDiscipline: r.capturedByDiscipline,
  recordedByUserId: r.recordedByUserId,
  sourceEncounterId: r.sourceEncounterId,
  cosignRequired: r.cosignRequired,
  cosignedAt: r.cosignedAt,
  sudContext: r.sudContext,
  actingAs: r.actingAs,
  actingConsentId: r.actingConsentId,
  status: r.status,
  correctsAssessmentId: r.correctsAssessmentId,
  correctionReason: r.correctionReason,
  redacted,
  version: r.version,
});

/**
 * Build an in-memory {@link AssessmentRouteService} + a matching {@link AssessmentAbacResolver} over one
 * shared dataset — no DB, deterministic, RLS-free (the slice scopes every read by the passed `organizationId`
 * so a cross-tenant id is a non-leaking 404, mirroring how RLS would behave in prod).
 */
export function createInMemoryAssessmentBackend(seed: AssessmentRouteSeed = {}): {
  service: AssessmentRouteService;
  resolver: AssessmentAbacResolver;
} {
  const now = seed.now ?? (() => new Date().toISOString());
  const today = (): string => now().slice(0, 10);
  const rows = new Map<string, AssessmentRecord>();
  for (const s of seed.assessments ?? []) rows.set(s.id, fullRecord(s));
  const admissions = [...(seed.admissions ?? [])];
  const consents = [...(seed.consents ?? [])];
  const licenses = new Map<string, ScaleLicenseRecord>();
  for (const l of seed.licenses ?? []) licenses.set(l.id, { ...l });
  const disabled = new Set((seed.disabledPolicies ?? []).map((p) => `${p.organizationId}::${p.scaleType}`));
  const changes = new Map<string, SignificantChangeRecord>();
  for (const c of seed.significantChanges ?? []) changes.set(c.id, { ...c });

  let assessmentSeq = rows.size;
  let licenseSeq = licenses.size;

  const findRow = (organizationId: string, id: string): AssessmentRecord => {
    const r = rows.get(id);
    if (!r || r.organizationId !== organizationId) throw new NotFoundError("assessment");
    return r;
  };

  const policyEnabled = (organizationId: string, scaleType: ScaleType): boolean =>
    !disabled.has(`${organizationId}::${scaleType}`);

  const consentActive = (organizationId: string, patientId: string, kind: "dpoa" | "sud"): boolean => {
    const c = consents.find((x) => x.organizationId === organizationId && x.patientId === patientId);
    if (!c) return false;
    return kind === "dpoa" ? c.dpoaActive === true : c.sudReleaseActive === true;
  };

  // D10 / M09-F05 (ADR-0014 D1) chart-read disclosure gate: a SUD-context AIMS row read back WITHOUT an
  // active 42 CFR Part 2 release is returned in redacted shape (`redacted=true`, empty data/score) so a
  // clinician sees "there is an AIMS but you can't see it" — never blocked on creation. Non-AIMS and
  // non-SUD rows are never redacted. The disclosure decision is consent-driven (in prod: M5 PrivacyFlag +
  // M39 consent.evaluate, resolved SQL-side); the slice models it via the seeded consent fact.
  const sudRedacted = (r: AssessmentRecord): boolean =>
    r.scaleType === "aims" && r.sudContext && !consentActive(r.organizationId, r.patientId, "sud");

  const licenseStatusFor = (organizationId: string, scaleType: ScaleType): "active" | "pending_renewal" | "expired" | null => {
    const lic = [...licenses.values()].find((l) => l.organizationId === organizationId && l.scaleType === scaleType);
    if (!lic) return null;
    return computeScaleLicenseStatus({ effectiveDate: lic.effectiveDate, expiresAt: lic.expiresAt }, today());
  };

  /** The §10 task-#5 record pipeline, shared by the create + correction paths (re-scored each time). */
  const buildScored = (organizationId: string, patientId: string, args: RecordAssessmentArgs): { score: number | null; interpretation: string | null } => {
    // admission anchor (M6 facts): active admission + capturedAt ≥ activation.
    const admission = admissions.find((a) => a.organizationId === organizationId && a.id === args.admissionId && a.patientId === patientId);
    require_(admission !== undefined && admission.status === "active", "INACTIVE_ADMISSION", "Patient's admission is not active.");
    require_(args.capturedAt >= (admission as AdmissionFact).activatedAt, "BEFORE_ADMISSION", "capturedAt precedes admission activation.");
    // policy + license gates (D3).
    require_(policyEnabled(organizationId, args.scaleType), "SCALE_NOT_ENABLED", `Scale '${args.scaleType}' is disabled for this tenant.`);
    if (isLicensedScale(args.scaleType)) {
      require_(licenseStatusFor(organizationId, args.scaleType) === "active", "SCALE_LICENSE_MISSING", `Scale '${args.scaleType}' requires an active license.`);
    }
    // discipline gate (D8) — defense-in-depth behind the route's `discipline_can_record_scale` predicate.
    require_(disciplineCanRecordScale(args.recorderDiscipline, args.scaleType), "DISCIPLINE_NOT_ELIGIBLE", `Discipline '${args.recorderDiscipline}' cannot record '${args.scaleType}'.`);
    // DPOA proxy-attribution gate (write path) — a representative report needs an active DPOA (§4.4).
    if (args.actingAs === "patient_representative") {
      require_(consentActive(organizationId, patientId, "dpoa"), "DPOA_CONSENT_REQUIRED", "acting_as='patient_representative' requires an active dpoa_healthcare consent.");
    }
    // server-authoritative score (D6) — never trust a client-sent score.
    const { score, interpretation } = scoreAssessment(args.scaleType, args.data as never);
    return { score, interpretation };
  };

  const service: AssessmentRouteService = {
    async recordAssessment(organizationId, actorUserId, patientId, args) {
      const { score, interpretation } = buildScored(organizationId, patientId, args);
      const id = uuidFromCounter("9", ++assessmentSeq);
      const record: AssessmentRecord = fullRecord({
        id,
        organizationId,
        patientId,
        scaleType: args.scaleType,
        admissionId: args.admissionId,
        data: args.data,
        score,
        scoreInterpretation: interpretation,
        capturedAt: args.capturedAt,
        capturedByDiscipline: args.recorderDiscipline,
        recordedByUserId: actorUserId,
        sourceEncounterId: args.sourceEncounterId ?? null,
        cosignRequired: cosignRequiredFor(args.recorderDiscipline, args.scaleType),
        sudContext: args.scaleType === "aims" ? args.sudContext === true : false,
        actingAs: args.actingAs ?? "self",
        actingConsentId: args.actingConsentId ?? null,
        status: "active",
        version: 1,
      });
      rows.set(id, record);
      return toView(record);
    },

    async correctAssessment(organizationId, actorUserId, patientId, targetId, ifVersion, args) {
      const target = findRow(organizationId, targetId);
      // §2.2.1 / §2.3 — validate the correction against its target (active / mismatch / stale-version).
      const plan = planCorrection(
        { id: target.id, scaleType: target.scaleType, patientId: target.patientId, admissionId: target.admissionId, status: target.status, version: target.version },
        { scaleType: args.scaleType, patientId, admissionId: args.admissionId, expectedTargetVersion: ifVersion },
      );
      const { score, interpretation } = buildScored(organizationId, patientId, args);
      target.status = "superseded";
      const id = uuidFromCounter("9", ++assessmentSeq);
      const record: AssessmentRecord = fullRecord({
        id,
        organizationId,
        patientId,
        scaleType: args.scaleType,
        admissionId: args.admissionId,
        data: args.data,
        score,
        scoreInterpretation: interpretation,
        capturedAt: args.capturedAt,
        capturedByDiscipline: args.recorderDiscipline,
        recordedByUserId: actorUserId,
        sourceEncounterId: args.sourceEncounterId ?? null,
        cosignRequired: cosignRequiredFor(args.recorderDiscipline, args.scaleType),
        sudContext: args.scaleType === "aims" ? args.sudContext === true : false,
        actingAs: args.actingAs ?? "self",
        actingConsentId: args.actingConsentId ?? null,
        status: "active",
        correctsAssessmentId: plan.supersedeTargetId,
        correctionReason: args.correctionReason,
        version: plan.newVersion,
      });
      rows.set(id, record);
      return toView(record);
    },

    async listAssessments(organizationId, patientId) {
      const assessments = [...rows.values()]
        .filter((r) => r.organizationId === organizationId && r.patientId === patientId)
        .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0))
        .map((r) => toView(r, sudRedacted(r)));
      return { assessments };
    },

    async getAssessment(organizationId, patientId, id) {
      const r = findRow(organizationId, id);
      if (r.patientId !== patientId) throw new NotFoundError("assessment");
      return toView(r, sudRedacted(r));
    },

    async summary(organizationId, patientId) {
      const latest = new Map<ScaleType, AssessmentRecord>();
      for (const r of rows.values()) {
        if (r.organizationId !== organizationId || r.patientId !== patientId || r.status !== "active") continue;
        const cur = latest.get(r.scaleType);
        if (!cur || r.capturedAt > cur.capturedAt) latest.set(r.scaleType, r);
      }
      return { patientId, latest: [...latest.values()].map((r) => toView(r, sudRedacted(r))) };
    },

    async latestScale(organizationId, patientId, scaleType) {
      const candidates = [...rows.values()].filter(
        (r) => r.organizationId === organizationId && r.patientId === patientId && r.scaleType === scaleType && r.status === "active",
      );
      if (candidates.length === 0) throw new NotFoundError("assessment");
      const latest = candidates.reduce((a, b) => (b.capturedAt > a.capturedAt ? b : a));
      return toView(latest, sudRedacted(latest));
    },

    async seriesScale(organizationId, patientId, scaleType, from, to) {
      const fromI = `${from}T00:00:00.000Z`;
      const toI = `${to}T23:59:59.999Z`;
      const points: ScaleSeriesPoint[] = [...rows.values()]
        .filter((r) => r.organizationId === organizationId && r.patientId === patientId && r.scaleType === scaleType && r.status === "active" && r.capturedAt >= fromI && r.capturedAt <= toI)
        .sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0))
        .map((r) => {
          // D10 disclosure gate also withholds the score of a non-consented SUD-context AIMS trend point.
          const redacted = sudRedacted(r);
          return { assessmentId: r.id, capturedAt: r.capturedAt, score: redacted ? null : r.score, scoreInterpretation: redacted ? null : r.scoreInterpretation, significantChange: false };
        });
      return { scaleType, patientId, from: fromI, to: toI, points };
    },

    async deltaScale(organizationId, patientId, scaleType, from, to) {
      const { points } = await service.seriesScale(organizationId, patientId, scaleType, from, to);
      const window = { from, to };
      if (points.length < 2) return { scaleType, patientId, window, latestScore: null, priorScore: null, delta: null };
      const priorScore = points[0]!.score;
      const latestScore = points[points.length - 1]!.score;
      const delta = latestScore !== null && priorScore !== null ? latestScore - priorScore : null;
      return { scaleType, patientId, window, latestScore, priorScore, delta };
    },

    async latestBatch(organizationId, patientId, scaleTypes) {
      const wanted = new Set(scaleTypes);
      const latest = new Map<ScaleType, AssessmentRecord>();
      for (const r of rows.values()) {
        if (r.organizationId !== organizationId || r.patientId !== patientId || r.status !== "active" || !wanted.has(r.scaleType)) continue;
        const cur = latest.get(r.scaleType);
        if (!cur || r.capturedAt > cur.capturedAt) latest.set(r.scaleType, r);
      }
      return { latest: [...latest.values()].map((r) => toView(r, sudRedacted(r))) };
    },

    async cosign(organizationId, actorUserId, id, cosignerDiscipline) {
      const r = findRow(organizationId, id);
      // §7.4 / §6 — validate the attest (requires-cosign / not-already / eligible-and-not-recorder).
      planCosignAttest({
        clinicalAssessmentId: r.id,
        cosignRequired: r.cosignRequired,
        alreadyCosigned: r.cosignedAt !== null,
        cosignerDiscipline,
        cosignerIsRecorder: r.recordedByUserId === actorUserId,
      });
      r.cosignedAt = now();
      return { assessmentId: r.id, cosigned: true };
    },

    async listSignificantChanges(organizationId, patientId) {
      const events = [...changes.values()]
        .filter((c) => c.organizationId === organizationId && c.patientId === patientId)
        .map((c) => ({ id: c.id, assessmentId: c.assessmentId, priorAssessmentId: c.priorAssessmentId, ruleId: c.ruleId, status: c.status, severity: c.severity }));
      return { events };
    },

    async acknowledgeChange(organizationId, eventId) {
      const c = changes.get(eventId);
      if (!c || c.organizationId !== organizationId) throw new NotFoundError("significant_change_event");
      c.status = transitionSignificantChange(c.status, { type: "acknowledge" });
      return { status: c.status };
    },

    async listLicenses(organizationId) {
      const licensesOut = [...licenses.values()]
        .filter((l) => l.organizationId === organizationId)
        .map((l) => ({ id: l.id, scaleType: l.scaleType, vendor: l.vendor, effectiveDate: l.effectiveDate, expiresAt: l.expiresAt, seats: l.seats, status: licenseStatusFor(organizationId, l.scaleType) ?? "expired" }));
      return { licenses: licensesOut };
    },

    async createLicense(organizationId, args) {
      const id = uuidFromCounter("c", ++licenseSeq);
      const rec: ScaleLicenseRecord = { id, organizationId, scaleType: args.scaleType, vendor: args.vendor, effectiveDate: args.effectiveDate, expiresAt: args.expiresAt, seats: args.seats ?? null };
      licenses.set(id, rec);
      return { id, scaleType: rec.scaleType, vendor: rec.vendor, effectiveDate: rec.effectiveDate, expiresAt: rec.expiresAt, seats: rec.seats, status: licenseStatusFor(organizationId, rec.scaleType) ?? "expired" };
    },

    async updateLicense(organizationId, id, args) {
      const rec = licenses.get(id);
      if (!rec || rec.organizationId !== organizationId) throw new NotFoundError("scale_license");
      if (args.vendor !== undefined) rec.vendor = args.vendor;
      if (args.effectiveDate !== undefined) rec.effectiveDate = args.effectiveDate;
      if (args.expiresAt !== undefined) rec.expiresAt = args.expiresAt;
      if (args.seats !== undefined) rec.seats = args.seats;
      return { id: rec.id, scaleType: rec.scaleType, vendor: rec.vendor, effectiveDate: rec.effectiveDate, expiresAt: rec.expiresAt, seats: rec.seats, status: licenseStatusFor(organizationId, rec.scaleType) ?? "expired" };
    },

    async listPolicies(organizationId) {
      const policies = [...disabled]
        .filter((k) => k.startsWith(`${organizationId}::`))
        .map((k) => ({ scaleType: k.split("::")[1] as ScaleType, enabled: false }));
      return { policies };
    },

    async updatePolicy(organizationId, scaleType, enabled) {
      const key = `${organizationId}::${scaleType}`;
      if (enabled) disabled.delete(key);
      else disabled.add(key);
      return { scaleType, enabled };
    },
  };

  const resolver: AssessmentAbacResolver = {
    async loadAssessment(organizationId, assessmentId) {
      const r = rows.get(assessmentId);
      if (!r || r.organizationId !== organizationId) return null;
      return { assessmentId: r.id, patientId: r.patientId, recorderDiscipline: r.capturedByDiscipline, recordedByUserId: r.recordedByUserId };
    },
  };

  return { service, resolver };
}
