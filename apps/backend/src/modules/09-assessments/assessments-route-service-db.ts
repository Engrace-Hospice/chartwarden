// apps/backend/src/modules/09-assessments — PRODUCTION AssessmentRouteService (M9L reads + writes).
//
// The screen-driving READS (patient assessment list + detail, latest/summary/series/delta/batch trend,
// significant-change inbox, scale licenses + policies) run as real Drizzle queries over the M9-owned
// tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. `clinical_assessment` is PARTITION BY RANGE (captured_at) — reads query the parent
// (the partition router picks leaves); a DEFAULT partition catches every captured_at so inserts always
// land. The §10 WRITE pipeline is now real (M9L): record (policy/license/discipline gate → server-
// authoritative score → insert) · correct (planCorrection → insert the amendment; the DB
// correction-supersede trigger flips the target) · cosign (planCosignAttest → assessment_cosignature
// row) · acknowledge-change · license/policy admin. Every scale insert emits `m9.assessment.recorded`
// (and `m9.assessment.amended` on a correction) on the caller's transactional outbox. No route is at 501.
//
// Because the AssessmentRouteService interface threads no admission/consent facts nor an acting
// membership beyond `actorUserId`, this slice makes documented compromises (the M7/M8 convention):
// (1) writes envelope `withOrgContext` with `userId:""` → the M4 write-audit trigger fires with a NULL
// actor; (2) — CLOSED by GAP-016. The §10 admission-anchor gate (active admission + capturedAt ≥
// activation) and the DPOA proxy-attribution gate ARE enforced now, on BOTH record and correct: the
// anchor facts ride on the same `AdmissionStatusReader` summary the capture siting already fetched (no
// extra round-trip), and the DPOA fact resolves through M39's `ConsentEvaluator` — the same seam glue
// M7's `dpoa_active` predicate uses. Until then `INACTIVE_ADMISSION` / `BEFORE_ADMISSION` /
// `DPOA_CONSENT_REQUIRED` existed only in the in-memory slice, so production accepted an assessment
// against a discharged admission. The policy + license + discipline + server-score gates (all resolvable
// from M9's own tables + the pure scorers) were and remain enforced; (3) the cosignature attestation text
// and the license/policy acting membership are a documented sentinel / NULL until the interface carries
// them. The correction row REUSES the target's `captured_at` (the composite self-FK
// `(corrects_assessment_id, captured_at) → (id, captured_at)` demands it).
//
// CAPTURE SITING (§3.3). Every insert denormalizes `provider_entity_id` from the capture's admission
// anchor through the published M6 `AdmissionStatusReader` seam (capture-siting.ts — M9 may not import
// M6's schema, §11). The seam read runs BEFORE `withOrgContext` on its own request-scoped connection;
// when it cannot answer (no seam / unknown admission / draft-PE gap / no request scope) the row stays
// UNSITED (NULL) — recording is never blocked by the denormalization and a siting is never invented.
// `location_id` stays NULL for now: NO published seam carries an admission/patient location (see the
// capture-siting.ts header). A correction REUSES its target's stored siting when present (faithful to
// the original capture event) and only falls back to a fresh resolve for legacy-unsited targets.
import {
  canRecordUnderLicense,
  computeScaleLicenseStatus,
  cosignRequiredFor,
  detectSignificantChanges,
  disciplineCanRecordScale,
  isLicensedScale,
  planCorrection,
  planCosignAttest,
  require_,
  scaleResponseDetail,
  scoreAssessment,
  transitionSignificantChange,
} from "@wardenx/assessments";
import { type DbClient, schema, todayForOrganization } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  AssessmentActingAs,
  ScaleDelta,
  ScaleSeries,
  ScaleSeriesPoint,
  ScaleType,
} from "@wardenx/types";
import { NotFoundError } from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  type AssessmentSitingResolver,
  type ResolvedAdmissionAnchor,
  type ResolvedCaptureSiting,
  createSeamAssessmentSitingResolver,
  dpoaConsentActiveViaSeam,
  sudRedactionRequiredViaSeam,
} from "./capture-siting";
import type {
  AssessmentAbacResolver,
  AssessmentRouteService,
  AssessmentView,
  CorrectAssessmentArgs,
  RecordAssessmentArgs,
  ScaleLicenseView,
  ScalePolicyView,
  SignificantChangeView,
} from "./routes/service";

const CA = schema.clinicalAssessments;
const COS = schema.assessmentCosignatures;
const SCE = schema.significantChangeEvents;

/** A superset of every §2.4 delta rule's `windowDays`, used only to bound the prior-series read. The
 *  detector applies each rule's own window; widening this cannot make a rule fire that would not. */
const MAX_DETECTOR_LOOKBACK_DAYS = 60;
const LIC = schema.scaleLicenses;
const POL = schema.scalePolicies;

/** The §7.4 cosignature attestation text the `cosign` route does not carry yet (a sentinel; the exact
 * attestation language is threaded when the interface carries it — the M8 null-actor convention). */
const COSIGN_ATTESTATION =
  "Reviewed and cosigned per the LPN-cosignature policy (attestation pending route capture).";

const SCALE_VERSION = "v1";

/** F-208 (#248) — the `summary()` auto-refresh throttle window: a chart-open re-requests the printable
 *  assessment summary only while the most recent active assessment is this fresh. 24h errs toward "keep
 *  refreshing while the picture may still be changing" over building new per-patient dedup state. */
const SUMMARY_AUTO_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The transactional-outbox port (§2.8): the bound publisher validates every emit against the boot
 * catalog and writes the `outbox_event` row on the CALLER'S tx. The no-op default lets the slice/tests
 * commit without a dispatcher. Mirrors M7/M8. */
export interface AssessmentWriteOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}
const NOOP_OUTBOX: AssessmentWriteOutboxPort = { async publish() {} };

/** First row of a RETURNING/SELECT, or a 500 (unreachable after a successful write). */
function firstOrThrow<T>(rows: readonly T[], msg: string): T {
  const r = rows[0];
  if (!r) throw new NotFoundError(msg);
  return r;
}

// PARAM-004: "today" for a scale-license effective/expiry check is the ORG's operating calendar
// day (org_timezone), never a naive UTC-instant slice — see @wardenx/db's todayForOrganization.
const toIso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const toNum = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The columns every AssessmentView projection selects from the partitioned parent. */
const assessmentCols = {
  id: CA.id,
  patientId: CA.patientId,
  admissionId: CA.admissionId,
  scaleType: CA.scaleType,
  scaleVersion: CA.scaleVersion,
  data: CA.data,
  score: CA.score,
  scoreInterpretation: CA.scoreInterpretation,
  capturedAt: CA.capturedAt,
  capturedByDiscipline: CA.capturedByDiscipline,
  capturedByMembershipId: CA.capturedByMembershipId,
  providerEntityId: CA.providerEntityId,
  locationId: CA.locationId,
  sourceEncounterId: CA.sourceEncounterId,
  cosignRequired: CA.cosignRequired,
  sudContext: CA.sudContext,
  actingConsentId: CA.actingConsentId,
  actingAs: CA.actingAs,
  status: CA.status,
  correctsAssessmentId: CA.correctsAssessmentId,
  correctionReason: CA.correctionReason,
  version: CA.version,
} as const;

type AssessmentRow = {
  id: string;
  patientId: string;
  admissionId: string;
  scaleType: ScaleType;
  scaleVersion: string;
  data: unknown;
  score: string | null;
  scoreInterpretation: string | null;
  capturedAt: Date | string;
  capturedByDiscipline: string;
  capturedByMembershipId: string;
  providerEntityId: string | null;
  locationId: string | null;
  sourceEncounterId: string | null;
  cosignRequired: boolean;
  sudContext: boolean;
  actingConsentId: string | null;
  actingAs: AssessmentView["actingAs"];
  status: AssessmentView["status"];
  correctsAssessmentId: string | null;
  correctionReason: string | null;
  version: number;
};

// D10 / M09-F05 (ADR-0014 D1) chart-read disclosure gate. A SUD-context AIMS row is returned redacted
// (empty data/score) so a clinician sees "there is an AIMS but you can't see it" — never blocked on
// creation, never redacting non-SUD/non-AIMS rows.
//
// GAP-017 — the decision is now CONSENT-DRIVEN. This used to be the whole gate: `aims && sudContext`,
// with no consent read anywhere, so an active 42 CFR Part 2 release the patient signed and the org
// recorded changed nothing and the row stayed hidden from every caller forever. Which rows are
// CANDIDATES is still this pure predicate; whether a candidate is actually redacted is answered per
// read by M39 (`sudRedactionRequiredViaSeam` → `evaluateForIngressRedaction`), fail-closed.
const sudRedactionCandidate = (r: AssessmentRow): boolean => r.scaleType === "aims" && r.sudContext;

const toView = (
  r: AssessmentRow,
  cosignedAt: string | null,
  redacted: boolean,
): AssessmentView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  scaleType: r.scaleType,
  scaleVersion: r.scaleVersion,
  data: redacted ? {} : (r.data as Record<string, unknown>),
  score: redacted ? null : toNum(r.score),
  scoreInterpretation: redacted ? null : r.scoreInterpretation,
  capturedAt: toIso(r.capturedAt),
  capturedByDiscipline: r.capturedByDiscipline,
  recordedByUserId: r.capturedByMembershipId,
  sourceEncounterId: r.sourceEncounterId,
  cosignRequired: r.cosignRequired,
  cosignedAt,
  sudContext: r.sudContext,
  actingAs: r.actingAs,
  actingConsentId: r.actingConsentId,
  status: r.status,
  correctsAssessmentId: r.correctsAssessmentId,
  correctionReason: r.correctionReason,
  redacted,
  version: Number(r.version),
});

/**
 * The production, RLS-backed AssessmentRouteService. Reads are real; writes fail-closed 501.
 * Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbAssessmentRouteService(
  db: DbClient,
  outbox: AssessmentWriteOutboxPort = NOOP_OUTBOX,
  sitingResolver: AssessmentSitingResolver = createSeamAssessmentSitingResolver(),
  /**
   * GAP-016 — "does this patient have an active `dpoa_healthcare` consent?", through M39's
   * `ConsentEvaluator`. Resolved lazily per call (the composition root registers seams after the mount)
   * and injectable so unit tests need no seam registry.
   */
  consentActive: (organizationId: string, patientId: string) => Promise<boolean> = (
    organizationId,
    patientId,
  ) => dpoaConsentActiveViaSeam(organizationId, patientId),
  /**
   * GAP-017 — "must this patient's SUD content stay redacted on an in-org chart read?", through M39's
   * `ConsentEvaluator.evaluateForIngressRedaction`. Injectable so unit tests need no seam registry;
   * fail-closed (redact) by default. See {@link sudRedactionRequiredViaSeam} for why the decision is
   * patient-scoped rather than per-actor.
   */
  sudRedactionRequired: (organizationId: string, patientId: string) => Promise<boolean> = (
    organizationId,
    patientId,
  ) => sudRedactionRequiredViaSeam(organizationId, patientId),
): AssessmentRouteService {
  /**
   * Resolve the D10 redaction decision for a set of candidate rows — ONE consent read per request, and
   * only when at least one row is actually a SUD-context AIMS row. Every read path here is already
   * scoped to a single patient, so one answer covers the whole result set; a read with no candidate
   * rows (the overwhelming majority) never touches M39 at all.
   */
  async function redactionFor(
    organizationId: string,
    patientId: string,
    rows: readonly AssessmentRow[],
  ): Promise<boolean> {
    if (!rows.some(sudRedactionCandidate)) return false;
    return sudRedactionRequired(organizationId, patientId);
  }

  /** Emit one `m9.*` event on the caller's tx (validated + persisted by the bound publisher; no-op default). */
  async function emit(
    tx: unknown,
    org: string,
    eventName: string,
    aggregateKind: string,
    aggregateId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await outbox.publish(tx, {
      eventName,
      payload,
      organizationId: org,
      aggregateKind,
      aggregateId,
    });
  }

  /** F-208 (#248) — publish `m9.assessment.summary_requested` for the current active rows (or a no-op
   *  when there is none — an empty chart has nothing to summarize). The aggregate is the PATIENT
   *  (`aggregateKind: "patient"`, the M5 `merges-db.ts`/`deceased-db.ts` precedent): the payload carries
   *  no per-request id, so M22 renders one evolving `assessment_summary` document per patient. */
  async function emitSummaryRequested(
    tx: DbClient,
    org: string,
    patientId: string,
    rows: readonly AssessmentRow[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const scales = [...new Set(rows.map((r) => r.scaleType))];
    await emit(tx, org, "m9.assessment.summary_requested", "patient", patientId, {
      patientId,
      asOfDate: await todayForOrganization(tx, org),
      scales,
      lang: "en",
    });
  }

  /** F-208 (#248) — the chart-open auto-refresh gate: fire only when the most recent active assessment
   *  was captured within {@link SUMMARY_AUTO_REFRESH_WINDOW_MS} of now. See {@link emitSummaryRequested}'s
   *  own caller comment (in `summary`) for why this is a freshness gate rather than a new state table. */
  async function maybeRequestSummaryRefresh(
    tx: DbClient,
    org: string,
    patientId: string,
    rows: readonly AssessmentRow[],
  ): Promise<void> {
    let mostRecentCapturedAtMs = Number.NEGATIVE_INFINITY;
    for (const r of rows) {
      const ms = (r.capturedAt instanceof Date ? r.capturedAt : new Date(r.capturedAt)).getTime();
      if (ms > mostRecentCapturedAtMs) mostRecentCapturedAtMs = ms;
    }
    if (Date.now() - mostRecentCapturedAtMs > SUMMARY_AUTO_REFRESH_WINDOW_MS) return;
    await emitSummaryRequested(tx, org, patientId, rows);
  }

  /** Is a scale enabled for this tenant? — the explicit `scale_policy.enabled` flag; absent ⇒ enabled. */
  async function policyEnabled(tx: DbClient, org: string, scaleType: ScaleType): Promise<boolean> {
    const [p] = await tx
      .select({ enabled: POL.enabled })
      .from(POL)
      .where(and(eq(POL.organizationId, org), eq(POL.scaleType, scaleType)))
      .limit(1);
    return p ? p.enabled : true;
  }

  /**
   * The §10 ADMISSION-ANCHOR gate (GAP-016). Was enforced only in the in-memory slice, so production
   * accepted an assessment against a discharged admission, or one captured before the admission was ever
   * activated — the exact `INACTIVE_ADMISSION` / `BEFORE_ADMISSION` cases §4.4 lists as 422 production
   * behaviour.
   *
   * FAIL-CLOSED on an unresolvable anchor, matching the in-memory slice (which throws INACTIVE_ADMISSION
   * when the admission is simply not found). An unresolvable anchor means the seam denied, the admission
   * does not exist, or it belongs to another org/patient — every one of which is a reason to refuse a
   * clinical record, not to write it anchored to nothing. Note this is a DIFFERENT posture from the
   * SITING half of the same seam call, which stays fail-open (an unsited row is a reporting gap, not a
   * mis-attributed record) — same fact, two consequences, deliberately.
   */
  function assertAdmissionAnchor(
    anchor: ResolvedAdmissionAnchor | null,
    capturedAt: string,
    projectionGap?: string,
  ): void {
    // #44 — a seam that REFUSED to project is not an inactive admission, and must not say it is.
    // Both used to arrive here as `anchor === null`, so a missing `provider_entity_id` was reported
    // as "Patient's admission is not active" for an admission whose status was `active`. Checked
    // first: the gap is the reason the anchor is absent, so it is the more specific truth.
    require_(
      projectionGap === undefined,
      "ADMISSION_PROJECTION_GAP",
      `The admission record is incomplete, so this capture cannot be anchored: ${projectionGap}`,
    );
    require_(
      anchor !== null && anchor.status === "active",
      "INACTIVE_ADMISSION",
      "Patient's admission is not active.",
    );
    // `activatedAt` is a LocalDate (`YYYY-MM-DD`) and `capturedAt` an ISO instant; comparing the
    // instant's DATE prefix keeps this a same-shape string compare, exactly as the slice does. A row
    // that is `active` with no activation date has not been activated, so nothing can precede it.
    require_(
      anchor.activatedAt !== null && capturedAt.slice(0, 10) >= anchor.activatedAt,
      "BEFORE_ADMISSION",
      "capturedAt precedes admission activation.",
    );
  }

  /**
   * The §10 DPOA proxy-attribution gate (GAP-016). A `patient_representative` report needs an active
   * `dpoa_healthcare` consent — resolved through M39's `ConsentEvaluator` seam, the same one M7's
   * `dpoa_active` predicate uses (GAP-013's glue), so the two cannot drift.
   */
  async function assertProxyAttribution(
    org: string,
    patientId: string,
    actingAs: AssessmentActingAs | undefined,
  ): Promise<void> {
    if (actingAs !== "patient_representative") return; // self-report — no proxy to authorize
    require_(
      await consentActive(org, patientId),
      "DPOA_CONSENT_REQUIRED",
      "acting_as='patient_representative' requires an active dpoa_healthcare consent.",
    );
  }

  /** The §10 record/correct gate chain resolvable from M9's OWN data + the pure scorers (§4.4 codes).
   * The admission-anchor and DPOA gates run BEFORE this, outside the write tx (they read cross-module
   * seams that open their own request-scoped connections). Returns the score. */
  async function scoredForWrite(
    tx: DbClient,
    org: string,
    args: RecordAssessmentArgs,
  ): Promise<{ score: number | null; interpretation: string | null }> {
    // policy gate (D3) — tenant-disabled scale is a 403.
    require_(
      await policyEnabled(tx, org, args.scaleType),
      "SCALE_NOT_ENABLED",
      `Scale '${args.scaleType}' is disabled for this tenant.`,
    );
    // license gate (D3) — active and pending-renewal licenses remain usable; expired/missing do not.
    if (isLicensedScale(args.scaleType)) {
      const [lic] = await tx
        .select({ effectiveDate: LIC.effectiveDate, expiresAt: LIC.expiresAt })
        .from(LIC)
        .where(and(eq(LIC.organizationId, org), eq(LIC.scaleType, args.scaleType)))
        .limit(1);
      const status = lic
        ? computeScaleLicenseStatus(
            { effectiveDate: lic.effectiveDate, expiresAt: lic.expiresAt },
            await todayForOrganization(tx, org),
          )
        : null;
      require_(
        status !== null && canRecordUnderLicense(status),
        "SCALE_LICENSE_MISSING",
        `Scale '${args.scaleType}' requires a current license.`,
      );
    }
    // discipline gate (D8) — defense-in-depth behind the route's `discipline_can_record_scale` predicate.
    require_(
      disciplineCanRecordScale(args.recorderDiscipline, args.scaleType),
      "DISCIPLINE_NOT_ELIGIBLE",
      `Discipline '${args.recorderDiscipline}' cannot record '${args.scaleType}'.`,
    );
    // server-authoritative score (D6) — never trust a client-sent score.
    return scoreAssessment(args.scaleType, args.data as never);
  }

  /** Insert one scale row (record or correction) + emit `m9.assessment.recorded`; returns the AssessmentView. */
  async function insertScale(
    tx: DbClient,
    org: string,
    actorUserId: string,
    patientId: string,
    args: RecordAssessmentArgs,
    scored: { score: number | null; interpretation: string | null },
    siting: ResolvedCaptureSiting,
    correction: {
      correctsAssessmentId: string;
      correctionReason: string;
      capturedAt: Date;
      version: number;
    } | null,
  ): Promise<AssessmentView> {
    const row = firstOrThrow(
      await tx
        .insert(CA)
        .values({
          organizationId: org,
          patientId,
          admissionId: args.admissionId,
          // §3.3 capture siting resolved via the M6 seam (see the file header); NULL = documented unsited.
          providerEntityId: siting.providerEntityId,
          locationId: siting.locationId,
          scaleType: args.scaleType,
          scaleVersion: SCALE_VERSION,
          data: args.data,
          score: scored.score === null ? null : String(scored.score),
          scoreInterpretation: scored.interpretation,
          // A correction REUSES the target's captured_at (the composite self-FK demands it, §2.3).
          capturedAt: correction ? correction.capturedAt : new Date(args.capturedAt),
          capturedByMembershipId: actorUserId,
          capturedByDiscipline: args.recorderDiscipline,
          sourceEncounterId: args.sourceEncounterId ?? null,
          cosignRequired: cosignRequiredFor(args.recorderDiscipline, args.scaleType),
          sudContext: args.scaleType === "aims" ? args.sudContext === true : false,
          actingAs: args.actingAs ?? "self",
          actingConsentId: args.actingConsentId ?? null,
          status: "active",
          correctsAssessmentId: correction ? correction.correctsAssessmentId : null,
          correctionReason: correction ? correction.correctionReason : null,
          version: correction ? correction.version : 1,
        })
        .returning(),
      "clinical_assessment insert returned no row",
    );
    await emit(tx, org, "m9.assessment.recorded", "clinical_assessment", row.id, {
      assessmentId: row.id,
      patientId,
      admissionId: args.admissionId,
      scaleType: args.scaleType,
      score: scored.score,
      capturedAt: toIso(row.capturedAt),
      sourceEncounterId: args.sourceEncounterId ?? null,
      isCorrection: correction !== null,
    });
    await detectAndRecordSignificantChanges(tx, org, patientId, args, scored, siting, row);
    const map = await cosignedMap(tx, [row.id]);
    return toView(row as unknown as AssessmentRow, map.get(row.id) ?? null, false);
  }

  /**
   * §2.4 — run the significant-change detector over the just-inserted reading and persist what fired.
   *
   * F-076 (#91). `detectSignificantChanges` has been complete, pure and unit-tested since M9-T08, and its
   * own header describes "the pure evaluators THE RECORDING TRANSACTION runs after scoring" — a caller
   * that did not exist. Nothing in the backend inserted a `significant_change_event`: four consumers read
   * that table (this service's worklist, the seam store, the escalation cron and the eraser) and none
   * wrote to it. So the queue was empty for every patient in every tenant, the Acknowledge action #91
   * added could never be pressed, the escalation cron had nothing to escalate, and the catalogued
   * `m9.assessment.significant_change` event was never emitted. Same shape as `hope_submission_item`
   * (#150) and the F-029 step-up routes: a finished core with no caller, which every unit test passes.
   *
   * Runs INSIDE the write transaction, per §9.6 — a decline and the reading that caused it commit
   * together or not at all. A correction is deliberately included: superseding a reading with a much
   * worse one is exactly as clinically significant as recording it the first time.
   */
  async function detectAndRecordSignificantChanges(
    tx: DbClient,
    org: string,
    patientId: string,
    args: RecordAssessmentArgs,
    scored: { score: number | null; interpretation: string | null },
    siting: ResolvedCaptureSiting,
    inserted: { id: string; capturedAt: Date },
  ): Promise<void> {
    // The event row requires a provider entity AND a location, both NOT NULL. `clinical_assessment`
    // permits an unsited capture ("NULL = documented unsited"), so an unsited reading cannot carry a
    // detection. Skipping is the honest outcome: the alternative is inventing a siting for a compliance
    // row, which would attribute a decline to a location nobody recorded.
    if (siting.providerEntityId === null || siting.locationId === null) return;
    if (scored.score === null) return;

    const capturedAt = toIso(inserted.capturedAt);
    // Prior ACTIVE readings for the same patient x scale, excluding the row just written. The detector
    // does its own day-granular window filtering, so this only has to be a superset of every rule's
    // lookback; `MAX_DETECTOR_LOOKBACK_DAYS` is that superset, not a rule threshold.
    const priorRows = (await tx
      .select({ id: CA.id, score: CA.score, capturedAt: CA.capturedAt })
      .from(CA)
      .where(
        and(
          eq(CA.organizationId, org),
          eq(CA.patientId, patientId),
          eq(CA.scaleType, args.scaleType),
          eq(CA.status, "active"),
          gte(
            CA.capturedAt,
            new Date(inserted.capturedAt.getTime() - MAX_DETECTOR_LOOKBACK_DAYS * 86_400_000),
          ),
          lte(CA.capturedAt, inserted.capturedAt),
        ),
      )) as { id: string; score: string | null; capturedAt: Date }[];
    const priors = priorRows.filter((r) => r.id !== inserted.id);

    const [policy] = await tx
      .select({ overrides: POL.significantChangeOverrides })
      .from(POL)
      .where(and(eq(POL.organizationId, org), eq(POL.scaleType, args.scaleType)))
      .limit(1);

    const findings = detectSignificantChanges({
      scaleType: args.scaleType,
      score: scored.score,
      capturedAt,
      priorSeries: priors.map((r) => ({ score: toNum(r.score), capturedAt: toIso(r.capturedAt) })),
      ...(policy?.overrides
        ? { overrides: policy.overrides as Record<string, number> as never }
        : {}),
    });
    if (findings.length === 0) return;

    // The baseline the delta was measured against, for the row's `prior_assessment_id`. The detector
    // picks the most-sensitive prior in the window, so the newest is not necessarily it — but the
    // detector reports only the delta, not which row produced it, so this records the nearest prior
    // reading rather than claiming a precision the return shape does not carry.
    const nearestPrior =
      priors.length === 0
        ? null
        : priors.reduce((a, b) => (a.capturedAt > b.capturedAt ? a : b)).id;

    for (const f of findings) {
      const [ev] = await tx
        .insert(SCE)
        .values({
          organizationId: org,
          providerEntityId: siting.providerEntityId,
          locationId: siting.locationId,
          clinicalAssessmentId: inserted.id,
          priorAssessmentId: nearestPrior,
          ruleId: f.ruleId,
          deltaValue: String(f.deltaValue),
          thresholdValue: String(f.thresholdValue),
          status: "open",
        })
        .returning({ id: SCE.id });
      if (!ev) continue;
      await emit(tx, org, "m9.assessment.significant_change", "significant_change_event", ev.id, {
        eventId: ev.id,
        assessmentId: inserted.id,
        patientId,
        scaleType: args.scaleType,
        ruleId: f.ruleId,
        deltaValue: f.deltaValue,
        thresholdValue: f.thresholdValue,
        severity: f.severity,
        detectedAt: capturedAt,
      });
    }
  }

  /** Earliest cosignature timestamp per assessment id (the AssessmentView carries a single `cosignedAt`). */
  async function cosignedMap(tx: DbClient, ids: readonly string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (ids.length === 0) return map;
    const rows = await tx
      .select({ id: COS.clinicalAssessmentId, cosignedAt: COS.cosignedAt })
      .from(COS)
      .where(inArray(COS.clinicalAssessmentId, ids as string[]));
    for (const r of rows) {
      const iso = toIso(r.cosignedAt);
      const cur = map.get(r.id);
      if (!cur || iso < cur) map.set(r.id, iso);
    }
    return map;
  }

  /** Latest `active` row per scale from a candidate set (mirrors the in-memory reduce, newest `capturedAt`). */
  const latestPerScale = (rows: AssessmentRow[]): AssessmentRow[] => {
    const latest = new Map<ScaleType, AssessmentRow>();
    for (const r of rows) {
      const cur = latest.get(r.scaleType);
      if (!cur || toIso(r.capturedAt) > toIso(cur.capturedAt)) latest.set(r.scaleType, r);
    }
    return [...latest.values()];
  };

  async function viewsFor(
    tx: DbClient,
    organizationId: string,
    patientId: string,
    rows: AssessmentRow[],
  ): Promise<AssessmentView[]> {
    const map = await cosignedMap(
      tx,
      rows.map((r) => r.id),
    );
    const redact = await redactionFor(organizationId, patientId, rows);
    return rows.map((r) => toView(r, map.get(r.id) ?? null, redact && sudRedactionCandidate(r)));
  }

  return {
    // ── Assessment reads ───────────────────────────────────────────────────────────────────────────
    async listAssessments(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(eq(CA.patientId, patientId))
          .orderBy(desc(CA.capturedAt), desc(CA.id))) as AssessmentRow[];
        return { assessments: await viewsFor(tx as DbClient, organizationId, patientId, rows) };
      });
    },

    async getAssessment(organizationId, patientId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(eq(CA.id, id))
          .limit(1)) as AssessmentRow[];
        if (!r || r.patientId !== patientId) throw new NotFoundError("assessment");
        const map = await cosignedMap(tx as DbClient, [r.id]);
        const redact = await redactionFor(organizationId, patientId, [r]);
        const view = toView(r, map.get(r.id) ?? null, redact && sudRedactionCandidate(r));
        return { ...view, ...scaleResponseDetail(view.scaleType, view.data) };
      });
    },

    async summary(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(and(eq(CA.patientId, patientId), eq(CA.status, "active")))) as AssessmentRow[];
        // F-208 (#248) — the "auto-refresh on chart-open" trigger for `m9.assessment.summary_requested`
        // (M22 renders `assessment_summary`, one evolving document per patient — F-168's append shape).
        // No per-request identity exists on the payload to dedupe on the M9 side, so this pass throttles
        // by DATA FRESHNESS rather than a new state table: only fire when the most recent active
        // assessment was captured within `SUMMARY_AUTO_REFRESH_WINDOW_MS` of now, so repeated chart-opens
        // of a long-settled patient do not mint a fresh document version on every read. A patient with no
        // assessment activity at all, or none recent, is left exactly as the explicit download/print
        // action (`requestSummaryDocument` below) already covers on demand.
        await maybeRequestSummaryRefresh(tx as DbClient, organizationId, patientId, rows);
        return {
          patientId,
          latest: await viewsFor(tx as DbClient, organizationId, patientId, latestPerScale(rows)),
        };
      });
    },

    // F-208 (#248) — the explicit "download/print" trigger: unconditional, since the caller asked
    // directly (unlike `summary`'s freshness-gated side effect above).
    async requestSummaryDocument(organizationId, patientId) {
      await withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(and(eq(CA.patientId, patientId), eq(CA.status, "active")))) as AssessmentRow[];
        await emitSummaryRequested(tx as DbClient, organizationId, patientId, rows);
      });
      return { requested: true };
    },

    async latestScale(organizationId, patientId, scaleType) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(
            and(eq(CA.patientId, patientId), eq(CA.scaleType, scaleType), eq(CA.status, "active")),
          )
          .orderBy(desc(CA.capturedAt), desc(CA.id))
          .limit(1)) as AssessmentRow[];
        if (!r) throw new NotFoundError("assessment");
        const map = await cosignedMap(tx as DbClient, [r.id]);
        const redact = await redactionFor(organizationId, patientId, [r]);
        return toView(r, map.get(r.id) ?? null, redact && sudRedactionCandidate(r));
      });
    },

    async seriesScale(organizationId, patientId, scaleType, from, to) {
      const fromI = `${from}T00:00:00.000Z`;
      const toI = `${to}T23:59:59.999Z`;
      return withOrgContext(
        db,
        { organizationId, userId: "" },
        async (tx): Promise<ScaleSeries> => {
          const rows = (await tx
            .select(assessmentCols)
            .from(CA)
            .where(
              and(
                eq(CA.patientId, patientId),
                eq(CA.scaleType, scaleType),
                eq(CA.status, "active"),
                gte(CA.capturedAt, new Date(fromI)),
                lte(CA.capturedAt, new Date(toI)),
              ),
            )
            .orderBy(asc(CA.capturedAt), asc(CA.id))) as AssessmentRow[];
          const redact = await redactionFor(organizationId, patientId, rows);
          const points: ScaleSeriesPoint[] = rows.map((r) => {
            const redacted = redact && sudRedactionCandidate(r);
            return {
              assessmentId: r.id,
              capturedAt: toIso(r.capturedAt),
              score: redacted ? null : toNum(r.score),
              scoreInterpretation: redacted ? null : r.scoreInterpretation,
              significantChange: false,
            };
          });
          return { scaleType, patientId, from: fromI, to: toI, points };
        },
      );
    },

    async deltaScale(organizationId, patientId, scaleType, from, to) {
      const series = await this.seriesScale(organizationId, patientId, scaleType, from, to);
      const window = { from, to };
      const { points } = series;
      const empty: ScaleDelta = {
        scaleType,
        patientId,
        window,
        latestScore: null,
        priorScore: null,
        delta: null,
      };
      if (points.length < 2) return empty;
      const priorScore = points[0]!.score;
      const latestScore = points[points.length - 1]!.score;
      const delta = latestScore !== null && priorScore !== null ? latestScore - priorScore : null;
      return { scaleType, patientId, window, latestScore, priorScore, delta };
    },

    async latestBatch(organizationId, patientId, scaleTypes) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        if (scaleTypes.length === 0) return { latest: [] };
        const rows = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(
            and(
              eq(CA.patientId, patientId),
              eq(CA.status, "active"),
              inArray(CA.scaleType, [...scaleTypes] as ScaleType[]),
            ),
          )) as AssessmentRow[];
        return {
          latest: await viewsFor(tx as DbClient, organizationId, patientId, latestPerScale(rows)),
        };
      });
    },

    // ── Significant-change reads (patient scoped via the triggering assessment) ──────────────────────
    async listSignificantChanges(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        // significant_change_event carries no patient column — join the triggering clinical_assessment.
        const rows = await tx
          .select({
            id: SCE.id,
            assessmentId: SCE.clinicalAssessmentId,
            priorAssessmentId: SCE.priorAssessmentId,
            ruleId: SCE.ruleId,
            status: SCE.status,
            escalatedAt: SCE.escalatedAt,
          })
          .from(SCE)
          .innerJoin(CA, eq(SCE.clinicalAssessmentId, CA.id))
          .where(eq(CA.patientId, patientId))
          .orderBy(desc(SCE.detectedAt));
        const events: SignificantChangeView[] = rows.map((r) => ({
          id: r.id,
          assessmentId: r.assessmentId,
          priorAssessmentId: r.priorAssessmentId,
          ruleId: r.ruleId,
          status: r.status,
          // The View domain is medium|high; the escalation cron promotes medium→high (M9-T06). No stored
          // severity column, so it is derived from the escalation state. TODO(M9L): if the alert catalog's
          // clinical_urgent floor must surface here, join firstEmissionSeverity(ruleId).
          severity: r.escalatedAt ? "high" : "medium",
        }));
        return { events };
      });
    },

    // ── License / policy reads (org-level config; no PHI) ────────────────────────────────────────────
    async listLicenses(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({
            id: LIC.id,
            scaleType: LIC.scaleType,
            licenseHolder: LIC.licenseHolder,
            effectiveDate: LIC.effectiveDate,
            expiresAt: LIC.expiresAt,
          })
          .from(LIC)
          .where(eq(LIC.organizationId, organizationId));
        const todayStr = await todayForOrganization(tx, organizationId);
        const licenses: ScaleLicenseView[] = rows.map((l) => ({
          id: l.id,
          scaleType: l.scaleType,
          vendor: l.licenseHolder,
          effectiveDate: l.effectiveDate,
          expiresAt: l.expiresAt,
          // scale_license has no `seats` column; the in-memory shape carries it, so it reads null here.
          seats: null,
          status: computeScaleLicenseStatus(
            { effectiveDate: l.effectiveDate, expiresAt: l.expiresAt },
            todayStr,
          ),
        }));
        return { licenses };
      });
    },

    async listPolicies(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = await tx
          .select({ scaleType: POL.scaleType, enabled: POL.enabled })
          .from(POL)
          .where(eq(POL.organizationId, organizationId));
        const policies: ScalePolicyView[] = rows.map((p) => ({
          scaleType: p.scaleType,
          enabled: p.enabled,
        }));
        return { policies };
      });
    },

    // ── Record (§10 pipeline: anchor/DPOA/policy/license/discipline gate → server score → insert) ────
    async recordAssessment(organizationId, actorUserId, patientId, args) {
      // Seam-resolved siting + anchor facts BEFORE the write tx, in ONE seam call (the M6 store opens
      // its own request-scoped read). GAP-016: the anchor half used to be discarded.
      const { siting, anchor, projectionGap } = await sitingResolver.resolveAnchor(
        organizationId,
        patientId,
        args.admissionId,
      );
      assertAdmissionAnchor(anchor, args.capturedAt, projectionGap);
      await assertProxyAttribution(organizationId, patientId, args.actingAs);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const scored = await scoredForWrite(t, organizationId, args);
        return insertScale(t, organizationId, actorUserId, patientId, args, scored, siting, null);
      });
    },

    // ── Correct (§2.2.1 append-only amendment; the DB trigger supersedes the target) ─────────────────
    async correctAssessment(
      organizationId,
      actorUserId,
      patientId,
      targetId,
      ifVersion,
      args: CorrectAssessmentArgs,
    ) {
      // Resolved up front (outside the write tx). The SITING half is used only where the target row is
      // legacy-unsited; the ANCHOR half gates the amendment itself (GAP-016) — a correction is a new
      // append-only clinical row, so §10 applies to it exactly as it does to the original capture.
      const {
        siting: fresh,
        anchor,
        projectionGap,
      } = await sitingResolver.resolveAnchor(organizationId, patientId, args.admissionId);
      assertAdmissionAnchor(anchor, args.capturedAt, projectionGap);
      await assertProxyAttribution(organizationId, patientId, args.actingAs);
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [target] = (await t
          .select(assessmentCols)
          .from(CA)
          .where(eq(CA.id, targetId))
          .limit(1)) as AssessmentRow[];
        if (!target || target.patientId !== patientId) throw new NotFoundError("assessment");
        // §2.3 — validate the correction against its target (active / mismatch / stale-version → §4.4 codes).
        const plan = planCorrection(
          {
            id: target.id as never,
            scaleType: target.scaleType,
            patientId: target.patientId as never,
            admissionId: target.admissionId as never,
            status: target.status,
            version: Number(target.version),
          },
          {
            scaleType: args.scaleType,
            patientId: patientId as never,
            admissionId: args.admissionId as never,
            expectedTargetVersion: ifVersion,
          },
        );
        const scored = await scoredForWrite(t, organizationId, args);
        // An amendment documents the SAME capture event — reuse the target's stored siting when it has
        // one, and fix forward (fresh seam resolve) only for a legacy-unsited target (per column).
        const siting: ResolvedCaptureSiting = {
          providerEntityId: target.providerEntityId ?? fresh.providerEntityId,
          locationId: target.locationId ?? fresh.locationId,
        };
        // The AFTER-INSERT `clinical_assessment_supersede_on_correction_trg` flips the target to
        // `superseded` + bumps its version; we only insert the amendment (reusing target.captured_at).
        const view = await insertScale(
          t,
          organizationId,
          actorUserId,
          patientId,
          args,
          scored,
          siting,
          {
            correctsAssessmentId: plan.supersedeTargetId as string,
            correctionReason: args.correctionReason,
            capturedAt: new Date(toIso(target.capturedAt)),
            version: plan.newVersion,
          },
        );
        await emit(t, organizationId, "m9.assessment.amended", "clinical_assessment", target.id, {
          supersededId: target.id,
          correctingId: view.id,
          scaleType: args.scaleType,
          reason: args.correctionReason,
        });
        return view;
      });
    },

    // ── Cosign (§7.4 LPN cosignature attest → assessment_cosignature row) ─────────────────────────────
    async cosign(organizationId, actorUserId, id, cosignerDiscipline) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [r] = (await t
          .select(assessmentCols)
          .from(CA)
          .where(eq(CA.id, id))
          .limit(1)) as AssessmentRow[];
        if (!r) throw new NotFoundError("assessment");
        const [existing] = await t
          .select({ id: COS.id })
          .from(COS)
          .where(eq(COS.clinicalAssessmentId, id))
          .limit(1);
        // §7.4 / §6 — requires-cosign / not-already / eligible-and-not-recorder (§4.4 codes).
        planCosignAttest({
          clinicalAssessmentId: r.id,
          cosignRequired: r.cosignRequired,
          alreadyCosigned: existing !== undefined,
          cosignerDiscipline,
          cosignerIsRecorder: r.capturedByMembershipId === actorUserId,
        });
        await t.insert(COS).values({
          organizationId,
          clinicalAssessmentId: id,
          cosignerMembershipId: actorUserId,
          cosignerRole: cosignerDiscipline,
          attestationText: COSIGN_ATTESTATION,
        });
        return { assessmentId: id, cosigned: true };
      });
    },

    // ── Acknowledge a significant-change event (§2.2.2) ───────────────────────────────────────────────
    async acknowledgeChange(organizationId, eventId, ack) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [ev] = await t
          .select({ status: SCE.status })
          .from(SCE)
          .where(eq(SCE.id, eventId))
          .limit(1);
        if (!ev) throw new NotFoundError("significant_change_event");
        const status = transitionSignificantChange(ev.status, { type: "acknowledge" });
        const ackAt = new Date();
        await t.update(SCE).set({ status, acknowledgedAt: ackAt }).where(eq(SCE.id, eventId));
        // GAP-177 — the catalogued event (M36 closes the alert; M33 reconciles) had no emit site.
        await emit(
          tx,
          organizationId,
          "m9.assessment.significant_change_acknowledged",
          "significant_change_event",
          eventId,
          {
            eventId,
            ackBy: ack?.ackBy || "unknown",
            ackAt: ackAt.toISOString(),
            ...(ack?.note ? { note: ack.note } : {}),
          },
        );
        return { status };
      });
    },

    // ── License / policy admin (org-level config; no PHI) ─────────────────────────────────────────────
    async createLicense(organizationId, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const row = firstOrThrow(
          await t
            .insert(LIC)
            .values({
              organizationId,
              scaleType: args.scaleType,
              licenseHolder: args.vendor,
              effectiveDate: args.effectiveDate,
              expiresAt: args.expiresAt,
            })
            .returning({ id: LIC.id, effectiveDate: LIC.effectiveDate, expiresAt: LIC.expiresAt }),
          "scale_license insert returned no row",
        );
        return {
          id: row.id,
          scaleType: args.scaleType,
          vendor: args.vendor,
          effectiveDate: row.effectiveDate,
          expiresAt: row.expiresAt,
          seats: args.seats ?? null, // scale_license has no `seats` column — echo the input only
          status: computeScaleLicenseStatus(
            { effectiveDate: row.effectiveDate, expiresAt: row.expiresAt },
            await todayForOrganization(t, organizationId),
          ),
        };
      });
    },
    async updateLicense(organizationId, id, args) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [existing] = await t.select({ id: LIC.id }).from(LIC).where(eq(LIC.id, id)).limit(1);
        if (!existing) throw new NotFoundError("scale_license");
        const row = firstOrThrow(
          await t
            .update(LIC)
            .set({
              ...(args.vendor !== undefined ? { licenseHolder: args.vendor } : {}),
              ...(args.effectiveDate !== undefined ? { effectiveDate: args.effectiveDate } : {}),
              ...(args.expiresAt !== undefined ? { expiresAt: args.expiresAt } : {}),
            })
            .where(eq(LIC.id, id))
            .returning({
              id: LIC.id,
              scaleType: LIC.scaleType,
              licenseHolder: LIC.licenseHolder,
              effectiveDate: LIC.effectiveDate,
              expiresAt: LIC.expiresAt,
            }),
          "scale_license update matched no row",
        );
        return {
          id: row.id,
          scaleType: row.scaleType,
          vendor: row.licenseHolder,
          effectiveDate: row.effectiveDate,
          expiresAt: row.expiresAt,
          seats: args.seats ?? null,
          status: computeScaleLicenseStatus(
            { effectiveDate: row.effectiveDate, expiresAt: row.expiresAt },
            await todayForOrganization(t, organizationId),
          ),
        };
      });
    },
    async updatePolicy(organizationId, scaleType, enabled) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const t = tx as unknown as DbClient;
        const [prior] = await t
          .select({ enabled: POL.enabled })
          .from(POL)
          .where(and(eq(POL.organizationId, organizationId), eq(POL.scaleType, scaleType)))
          .limit(1);
        // One policy row per (org, scale) — upsert on the `scale_policy_per_org_scale_uq` unique.
        const policyRow = firstOrThrow(
          await t
            .insert(POL)
            .values({ organizationId, scaleType, enabled })
            .onConflictDoUpdate({
              target: [POL.organizationId, POL.scaleType],
              set: { enabled, updatedAt: new Date() },
            })
            .returning({ id: POL.id }),
          "scale_policy upsert returned no row",
        );
        // GAP-177 — `m9.scale.policy_changed` (M33 reconciles) had no emit site. A no-op PATCH (same value,
        // existing row) changes nothing and emits nothing.
        if (prior === undefined || prior.enabled !== enabled) {
          await emit(tx, organizationId, "m9.scale.policy_changed", "scale_policy", policyRow.id, {
            scaleType,
            changedFields: ["enabled"],
          });
        }
        return { scaleType, enabled };
      });
    },
  };
}

/**
 * The production, RLS-backed AssessmentAbacResolver — M9's §4.7 `cosigner_role_match` predicate loads an
 * assessment's recorder facts through it. The single org-scoped read runs under `withOrgContext` (RLS
 * backstops), returning `null` when the row is absent/cross-tenant so the predicate fails closed.
 */
export function createDbAssessmentAbacResolver(db: DbClient): AssessmentAbacResolver {
  return {
    async loadAssessment(organizationId, assessmentId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: CA.id,
            patientId: CA.patientId,
            recorderDiscipline: CA.capturedByDiscipline,
            recordedByUserId: CA.capturedByMembershipId,
          })
          .from(CA)
          .where(eq(CA.id, assessmentId))
          .limit(1);
        return r
          ? {
              assessmentId: r.id,
              patientId: r.patientId,
              recorderDiscipline: r.recorderDiscipline,
              recordedByUserId: r.recordedByUserId,
            }
          : null;
      });
    },
    // GAP-015: `significant_change_event` carries no patient column — same join as `listSignificantChanges`.
    async loadSignificantChangeEvent(organizationId, eventId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({ patientId: CA.patientId })
          .from(SCE)
          .innerJoin(CA, eq(SCE.clinicalAssessmentId, CA.id))
          .where(eq(SCE.id, eventId))
          .limit(1);
        return r ? { patientId: r.patientId } : null;
      });
    },
  };
}
