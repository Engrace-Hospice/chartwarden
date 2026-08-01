// apps/backend/src/modules/09-assessments — PRODUCTION AssessmentRouteService, READ-first (M9L).
//
// The screen-driving READS (patient assessment list + detail, latest/summary/series/delta/batch trend,
// significant-change inbox, scale licenses + policies) run as real Drizzle queries over the M9-owned
// tables inside `withOrgContext`, so RLS scopes every row by `app.org_id` as the unprivileged
// `wardenx_app` role. `clinical_assessment` is PARTITION BY RANGE (captured_at) — reads query the parent
// (the partition router picks leaves). The full §10 WRITE pipeline (record → correct → cosign →
// acknowledge → license/policy admin, with the server-authoritative score + the `m9.*` outbox) is the
// M9L follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is satisfied and
// the mount is real. The in-memory `createInMemoryAssessmentBackend` (`routes/service.ts`) stays the
// behavioral reference for those writes.
import { computeScaleLicenseStatus } from "@wardenx/assessments";
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { ScaleDelta, ScaleSeries, ScaleSeriesPoint, ScaleType } from "@wardenx/types";
import { NotFoundError, WardenXError } from "@wardenx/types";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type {
  AssessmentAbacResolver,
  AssessmentRouteService,
  AssessmentView,
  ScaleLicenseView,
  ScalePolicyView,
  SignificantChangeView,
} from "./routes/service";

const CA = schema.clinicalAssessments;
const COS = schema.assessmentCosignatures;
const SCE = schema.significantChangeEvents;
const LIC = schema.scaleLicenses;
const POL = schema.scalePolicies;

/** A never-returning stub for the §10 write pipeline still owed by the M9L write follow-up. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "assessment writes arrive in the M9L Drizzle write pipeline (record/correct/cosign/admin)",
    501,
  );
};

const today = (): string => new Date().toISOString().slice(0, 10);
const toIso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());
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
// creation, never redacting non-SUD/non-AIMS rows. The full decision is consent-driven (M5 PrivacyFlag +
// M39 consent.evaluate, resolved SQL-side); until that join is wired here it FAILS CLOSED — every
// SUD-context AIMS row is redacted. TODO(M9L): resolve the active 42 CFR Part 2 release and unredact.
const sudRedacted = (r: AssessmentRow): boolean => r.scaleType === "aims" && r.sudContext;

const toView = (r: AssessmentRow, cosignedAt: string | null, redacted: boolean): AssessmentView => ({
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
export function createDbAssessmentRouteService(db: DbClient): AssessmentRouteService {
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

  async function viewsFor(tx: DbClient, rows: AssessmentRow[]): Promise<AssessmentView[]> {
    const map = await cosignedMap(tx, rows.map((r) => r.id));
    return rows.map((r) => toView(r, map.get(r.id) ?? null, sudRedacted(r)));
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
        return { assessments: await viewsFor(tx as DbClient, rows) };
      });
    },

    async getAssessment(organizationId, patientId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx.select(assessmentCols).from(CA).where(eq(CA.id, id)).limit(1)) as AssessmentRow[];
        if (!r || r.patientId !== patientId) throw new NotFoundError("assessment");
        const map = await cosignedMap(tx as DbClient, [r.id]);
        return toView(r, map.get(r.id) ?? null, sudRedacted(r));
      });
    },

    async summary(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(and(eq(CA.patientId, patientId), eq(CA.status, "active")))) as AssessmentRow[];
        return { patientId, latest: await viewsFor(tx as DbClient, latestPerScale(rows)) };
      });
    },

    async latestScale(organizationId, patientId, scaleType) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = (await tx
          .select(assessmentCols)
          .from(CA)
          .where(and(eq(CA.patientId, patientId), eq(CA.scaleType, scaleType), eq(CA.status, "active")))
          .orderBy(desc(CA.capturedAt), desc(CA.id))
          .limit(1)) as AssessmentRow[];
        if (!r) throw new NotFoundError("assessment");
        const map = await cosignedMap(tx as DbClient, [r.id]);
        return toView(r, map.get(r.id) ?? null, sudRedacted(r));
      });
    },

    async seriesScale(organizationId, patientId, scaleType, from, to) {
      const fromI = `${from}T00:00:00.000Z`;
      const toI = `${to}T23:59:59.999Z`;
      return withOrgContext(db, { organizationId, userId: "" }, async (tx): Promise<ScaleSeries> => {
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
        const points: ScaleSeriesPoint[] = rows.map((r) => {
          const redacted = sudRedacted(r);
          return {
            assessmentId: r.id,
            capturedAt: toIso(r.capturedAt),
            score: redacted ? null : toNum(r.score),
            scoreInterpretation: redacted ? null : r.scoreInterpretation,
            significantChange: false,
          };
        });
        return { scaleType, patientId, from: fromI, to: toI, points };
      });
    },

    async deltaScale(organizationId, patientId, scaleType, from, to) {
      const series = await this.seriesScale(organizationId, patientId, scaleType, from, to);
      const window = { from, to };
      const { points } = series;
      const empty: ScaleDelta = { scaleType, patientId, window, latestScore: null, priorScore: null, delta: null };
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
        return { latest: await viewsFor(tx as DbClient, latestPerScale(rows)) };
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
        const licenses: ScaleLicenseView[] = rows.map((l) => ({
          id: l.id,
          scaleType: l.scaleType,
          vendor: l.licenseHolder,
          effectiveDate: l.effectiveDate,
          expiresAt: l.expiresAt,
          // scale_license has no `seats` column; the in-memory shape carries it, so it reads null here.
          seats: null,
          status: computeScaleLicenseStatus({ effectiveDate: l.effectiveDate, expiresAt: l.expiresAt }, today()),
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
        const policies: ScalePolicyView[] = rows.map((p) => ({ scaleType: p.scaleType, enabled: p.enabled }));
        return { policies };
      });
    },

    // ── Writes — the M9L §10 Drizzle pipeline. Fail-closed 501 until then. ──────────────────────────
    recordAssessment: async () => notImpl(),
    correctAssessment: async () => notImpl(),
    cosign: async () => notImpl(),
    acknowledgeChange: async () => notImpl(),
    createLicense: async () => notImpl(),
    updateLicense: async () => notImpl(),
    updatePolicy: async () => notImpl(),
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
  };
}
