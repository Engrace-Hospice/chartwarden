// apps/backend/src/modules/09-assessments/seams/drizzle-store.ts — the Drizzle-backed
// {@link AssessmentReaderStore} (TASK-002). M9's §4.7 / D7 seam providers previously ran on the
// in-memory slice store (seeded empty in prod), so LatestAssessmentProvider (M7 CTI narrative draft,
// M10 HOPE prognosis, M14 IDG packet) and ScaleSeriesProvider (M14 deltas, M28 Observation series)
// read nothing.
//
// TENANCY. Every read opens `withOrgContextFromRequest`: `app.org_id` is pinned from the CONSUMER'S
// ambient request context and RLS scopes the statement (the M21 store-drizzle precedent) — the store
// keys only on patientId (+ scale/window), never a caller-passed org id, and called outside a request
// scope it THROWS rather than reading unscoped.
//
// PARTITIONED PARENT. `clinical_assessment` is PARTITION BY RANGE (captured_at) — reads query the
// parent and the partition router picks leaves, exactly like the production route service
// (assessments-route-service-db.ts). The latest reads stay id-free/window-free by contract, riding the
// partial `clinical_assessment_patient_scale_captured_idx` per leaf.
//
// D10 SUD REDACTION — fail-closed, the route-service convention verbatim: a SUD-context AIMS row
// projects with `score`/`scoreInterpretation` nulled and `redacted: true` until the M39 Part-2 consent
// join is wired SQL-side. Non-SUD / non-AIMS rows are never redacted.
//
// SIGNIFICANT CHANGE. `ScaleSeriesPoint.significantChange` is resolved as "a `significant_change_event`
// row exists for the capture" — one batched query over the series ids (never N+1). This is the row's
// real detector marker; the route service's series read hardcodes `false`, which the seam must not copy.
//
// CAPTURE SITING GAP — FIX-FORWARD POSTURE (no backfill migration). `AssessmentCaptureContext`
// requires non-null `providerEntityId`/`locationId`; §3.3 relaxed both to nullable (migration 0129).
// The production record/correct paths now populate `provider_entity_id` at INSERT time through the
// published M6 `AdmissionStatusReader` seam (../capture-siting.ts — M9 must not read M6's schema,
// architecture §11), so new captures project cleanly on that column. `location_id` remains NULL on
// every row: NO published seam carries an admission/patient location today (AdmissionSummary exposes
// only providerEntityId; M5's PatientIdentity carries neither) — populating it needs AdmissionSummary
// to grow `locationId` (an M6 + @chartwarden/types change). Legacy pre-fix rows also stay PE-null.
// The projection KEEPS THE THROW for both columns: a latest read that resolves a null-sited row THROWS
// {@link AssessmentSeamDataGapError} naming exactly the missing fact(s) rather than fabricating a
// siting, lying through the non-null DTO type, or silently substituting an older, fully-sited capture
// as "latest". Tolerance was considered and rejected — the DTO's `LocationId` is non-null, so any
// tolerant projection would be a wire-type lie; the honest states are "sited" or "loud, named gap".
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext, withOrgContextFromRequest } from "@chartwarden/tenancy";
import type { LatestAssessment, ScaleSeriesPoint, ScaleType } from "@chartwarden/types";
import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import type { AssessmentReaderStore } from "./store";

const CA = schema.clinicalAssessments;
const COS = schema.assessmentCosignatures;
const SCE = schema.significantChangeEvents;

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Thrown when the latest active capture cannot be projected because a fact the
 * {@link LatestAssessment} DTO requires non-null is missing on the row (the un-backfilled
 * `provider_entity_id`/`location_id` siting). The store REFUSES to fabricate a siting — and refuses
 * to skip to an older capture, which would present a stale score as "latest" to CTI/HOPE/IDG.
 */
export class AssessmentSeamDataGapError extends Error {
  constructor(
    readonly assessmentId: string,
    readonly missing: readonly string[],
  ) {
    super(
      `M9 seam projection gap: clinical_assessment '${assessmentId}' is missing required fact(s): ` +
        `${missing.join(", ")} — refusing to fabricate a value`,
    );
    this.name = "AssessmentSeamDataGapError";
  }
}

const toIso = (v: Date | string): string =>
  v instanceof Date ? v.toISOString() : new Date(v).toISOString();
const toNum = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The columns every latest-read projection selects from the partitioned parent. */
const latestCols = {
  id: CA.id,
  patientId: CA.patientId,
  admissionId: CA.admissionId,
  scaleType: CA.scaleType,
  scaleVersion: CA.scaleVersion,
  score: CA.score,
  scoreInterpretation: CA.scoreInterpretation,
  capturedAt: CA.capturedAt,
  capturedByMembershipId: CA.capturedByMembershipId,
  capturedByDiscipline: CA.capturedByDiscipline,
  providerEntityId: CA.providerEntityId,
  locationId: CA.locationId,
  sourceEncounterId: CA.sourceEncounterId,
  cosignRequired: CA.cosignRequired,
  sudContext: CA.sudContext,
  status: CA.status,
} as const;

interface LatestRow {
  id: string;
  patientId: string;
  admissionId: string;
  scaleType: ScaleType;
  scaleVersion: string;
  score: string | null;
  scoreInterpretation: string | null;
  capturedAt: Date | string;
  capturedByMembershipId: string;
  capturedByDiscipline: string;
  providerEntityId: string | null;
  locationId: string | null;
  sourceEncounterId: string | null;
  cosignRequired: boolean;
  sudContext: boolean;
  status: LatestAssessment["status"];
}

/** D10 fail-closed (the route-service `sudRedacted` rule): every SUD-context AIMS row is redacted
 *  until the M39 Part-2 consent join resolves the disclosure decision SQL-side. */
const sudRedacted = (r: LatestRow): boolean => r.scaleType === "aims" && r.sudContext;

/** Project a row (+ its earliest cosignature instant) to the §4.7 {@link LatestAssessment} DTO. */
function toLatest(r: LatestRow, cosignedAt: string | null): LatestAssessment {
  const missing: string[] = [];
  if (r.providerEntityId === null) missing.push("provider_entity_id");
  if (r.locationId === null) missing.push("location_id");
  if (missing.length > 0) throw new AssessmentSeamDataGapError(r.id, missing);
  const redacted = sudRedacted(r);
  return {
    assessmentId: r.id,
    patientId: r.patientId,
    admissionId: r.admissionId,
    scaleType: r.scaleType,
    scaleVersion: r.scaleVersion,
    score: redacted ? null : toNum(r.score),
    scoreInterpretation: redacted ? null : r.scoreInterpretation,
    capturedAt: toIso(r.capturedAt),
    capture: {
      capturedByMembershipId: r.capturedByMembershipId,
      capturedByDiscipline: r.capturedByDiscipline,
      providerEntityId: r.providerEntityId,
      locationId: r.locationId,
    },
    sourceEncounterId: r.sourceEncounterId,
    cosignRequired: r.cosignRequired,
    cosignedAt,
    status: r.status,
    redacted,
  } as LatestAssessment;
}

/** Build the production Drizzle-backed {@link AssessmentReaderStore}. */
export function createDrizzleAssessmentReaderStore(db: DbClient): AssessmentReaderStore {
  /** Earliest cosignature instant per assessment id (ONE query — the route-service `cosignedMap`). */
  async function cosignedMap(tx: Tx, ids: readonly string[]): Promise<Map<string, string>> {
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

  /** Latest `active` row per scale from a candidate set (the route-service reduce: newest capturedAt). */
  const latestPerScale = (rows: LatestRow[]): LatestRow[] => {
    const latest = new Map<ScaleType, LatestRow>();
    for (const r of rows) {
      const cur = latest.get(r.scaleType);
      if (!cur || toIso(r.capturedAt) > toIso(cur.capturedAt)) latest.set(r.scaleType, r);
    }
    return [...latest.values()];
  };

  return {
    async linkSummary(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: CA.id,
            patientId: CA.patientId,
            status: CA.status,
            capturedAt: CA.capturedAt,
          })
          .from(CA)
          .where(
            and(
              // Explicit second wall behind RLS (PHI-bearing seam).
              eq(CA.organizationId, organizationId),
              eq(CA.id, id),
              // Part 2: the consent join is not wired, so a SUD-context row is withheld like a missing one.
              eq(CA.sudContext, false),
            ),
          )
          .limit(1);
        if (!r) return null;
        return {
          id: r.id,
          patientId: r.patientId,
          status: r.status,
          occurredAt: toIso(r.capturedAt),
        };
      });
    },

    async latestActive(patientId, scaleType) {
      return withOrgContextFromRequest(db, async (tx): Promise<LatestAssessment | null> => {
        const [r] = (await tx
          .select(latestCols)
          .from(CA)
          .where(
            and(eq(CA.patientId, patientId), eq(CA.scaleType, scaleType), eq(CA.status, "active")),
          )
          .orderBy(desc(CA.capturedAt), desc(CA.id))
          .limit(1)) as LatestRow[];
        if (!r) return null; // no visible active capture — the contract's null, never a throw
        const map = await cosignedMap(tx, [r.id]);
        return toLatest(r, map.get(r.id) ?? null);
      });
    },

    async latestActiveBatch(patientId, scaleTypes) {
      return withOrgContextFromRequest(db, async (tx) => {
        if (scaleTypes.length === 0) return [];
        const rows = (await tx
          .select(latestCols)
          .from(CA)
          .where(
            and(
              eq(CA.patientId, patientId),
              eq(CA.status, "active"),
              inArray(CA.scaleType, [...scaleTypes] as ScaleType[]),
            ),
          )) as LatestRow[];
        const latest = latestPerScale(rows);
        const map = await cosignedMap(
          tx,
          latest.map((r) => r.id),
        );
        return latest.map((r) => toLatest(r, map.get(r.id) ?? null));
      });
    },

    async seriesPoints(patientId, scaleType, from, to) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({
            id: CA.id,
            scaleType: CA.scaleType,
            score: CA.score,
            scoreInterpretation: CA.scoreInterpretation,
            capturedAt: CA.capturedAt,
            sudContext: CA.sudContext,
          })
          .from(CA)
          .where(
            and(
              eq(CA.patientId, patientId),
              eq(CA.scaleType, scaleType),
              eq(CA.status, "active"),
              gte(CA.capturedAt, new Date(from)), // inclusive window, ascending — the D4 contract
              lte(CA.capturedAt, new Date(to)),
            ),
          )
          .orderBy(asc(CA.capturedAt), asc(CA.id));
        // The detector marker: a significant_change_event row exists for the capture (ONE query).
        const flaggedRows = rows.length
          ? await tx
              .select({ id: SCE.clinicalAssessmentId })
              .from(SCE)
              .where(
                inArray(
                  SCE.clinicalAssessmentId,
                  rows.map((r) => r.id),
                ),
              )
          : [];
        const flagged = new Set(flaggedRows.map((r) => r.id));
        return rows.map((r): ScaleSeriesPoint => {
          const redacted = r.scaleType === "aims" && r.sudContext;
          return {
            assessmentId: r.id,
            capturedAt: toIso(r.capturedAt),
            score: redacted ? null : toNum(r.score),
            scoreInterpretation: redacted ? null : r.scoreInterpretation,
            significantChange: flagged.has(r.id),
          } as ScaleSeriesPoint;
        });
      });
    },
  };
}
