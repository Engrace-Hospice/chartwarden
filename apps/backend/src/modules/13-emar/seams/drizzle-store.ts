// apps/backend/src/modules/13-emar/seams/drizzle-store.ts — the Drizzle store behind M13's seam surface.
//
// Originally an OVERLAY carrying only the org-level measure reads M30 consumes; now the FULL
// {@link EmarSeamStore}: every read the §2.12 D16 providers (MedicationAdministrationProvider /
// ReconciliationProvider) compose over runs against M13's real tables — administration_record (+ its
// prn_administration / scheduled_dose / comfort_kit_deployment satellites) and
// medication_reconciliation_worksheet (+ decisions). No method falls back to the in-memory slice anymore.
//
// TENANCY, two modes (the M21 / M12 store precedents):
//   - Methods WITHOUT an organizationId run under the CONSUMER's ambient request context via
//     `withOrgContextFromRequest` — RLS pins `app.org_id` from the caller's request; outside a request
//     scope they THROW rather than read unscoped.
//   - The two ORG-AGGREGATE measure methods (`missedDoseCountsForOrg` / `prnReassessmentObligationsForOrg`)
//     SELF-SCOPE on their explicit `organizationId` via `withOrgContext` (a recompute worker has no ambient
//     request), with the explicit `organization_id` predicate as the second wall.
//
// The SIBLING measure, `prn_effectiveness_documented_rate`, is bound WITHOUT a schema change:
// `prnReassessmentObligationsForOrg` returns each PRN administration whose reassessment falls due in the
// window with its recommended scale, and the PROVIDER (providers.ts) joins each obligation against M9's
// ScaleSeriesProvider to decide whether a reassessment was actually captured — only the aggregate count
// crosses the M1 seam (D6). "Documented" is thus derived from the M9 assessment, not a slice-only flag.
// The per-patient `prnEffectivenessRowsForPatient` derives `hasReassessment` the same way, resolving M9's
// seam LAZILY per call (the seams/index.ts precedent) so an unbound M9 throws → the measure suppresses
// rather than scoring a fabricated zero.
//
// PHI (D12 / §3.6). The per-row free text (notes / refusal_reason / caregiver_attestation_text / dispute /
// override / correction / void reasons) never crosses — the DTO simply has no field for it. The per-mode
// free text lives INSIDE `administration_record.data` (sig_free_text / infusionDilution / titrationReason /
// pauseReason / stopReason / wastageReason — the exact `data->>...` audit-denylist paths), and the DTO DOES
// carry `data`, so `scrubAdministrationData` strips those keys before the payload leaves the store.
//
// PARTITIONED PARENT. `administration_record` is PARTITION BY RANGE (administered_at) monthly (mig 0133),
// so an id-only lookup fans out across every partition — accepted, a seam consumer has an id and no window
// (the M21/M12 trade); the patient/order/iv-session indexes carry the per-partition cost.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext, withOrgContextFromRequest } from "@wardenx/tenancy";
import type {
  AdministrationDto,
  PatientId,
  ReconciliationDecisionKind,
  ReconciliationWorksheetDto,
  ScaleType,
} from "@wardenx/types";
import { and, asc, eq, gte, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { getSeam } from "../../../bootstrap/index";
import type { EmarSeamStore, IvContinuousSessionRow, PrnEffectivenessRow } from "./store";

const ADM = schema.administrationRecords;
const SD = schema.scheduledDoses;
const MD = schema.missedDoses;
const PRN = schema.prnAdministrations;
const CKD = schema.comfortKitDeployments;
const WS = schema.medicationReconciliationWorksheets;
const RD = schema.medicationReconciliationDecisions;

/** The actor id the read's withOrgContext envelope carries — an aggregate read has no acting user. */
const EMAR_READER_SYSTEM_USER_ID = "";

/** ISO instant for a timestamptz column (Drizzle returns a Date). */
const iso = (d: Date): string => d.toISOString();
const isoN = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/** The §3.6 `data->>...` free-text json-paths (M13_AUDIT_DENYLIST) that must not cross the seam (D12). */
const DATA_FREE_TEXT_KEYS = [
  "sig_free_text",
  "infusionDilution",
  "titrationReason",
  "pauseReason",
  "stopReason",
  "wastageReason",
] as const;

/** Shallow-strip the per-mode free-text keys from the `data` jsonb before it leaves the store (D12). */
function scrubAdministrationData(data: unknown): unknown {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const key of DATA_FREE_TEXT_KEYS) delete out[key];
  return out;
}

type AdmRow = typeof ADM.$inferSelect;
type WsRow = typeof WS.$inferSelect;

/** Project an `administration_record` row onto the §2.12 read DTO (explicit column map; never the raw row). */
function toAdministrationDto(r: AdmRow): AdministrationDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    medicationOrderId: r.medicationOrderId,
    scheduledDoseId: r.scheduledDoseId ?? null,
    prnAdministrationId: r.prnAdministrationId ?? null,
    encounterId: r.encounterId ?? null,
    comfortKitDeploymentId: r.comfortKitDeploymentId ?? null,
    ivSessionId: r.ivSessionId ?? null,
    mode: r.mode,
    administeredAt: iso(r.administeredAt),
    recordedAt: iso(r.recordedAt),
    administeringClinicianMembershipId: r.administeringClinicianMembershipId ?? null,
    actorKind: r.actorKind,
    witnessMembershipId: r.witnessMembershipId ?? null,
    status: r.status,
    lateEntryTier: r.lateEntryTier,
    requiresRnReview: r.requiresRnReview,
    data: scrubAdministrationData(r.data),
    drugNameSnapshot: r.drugNameSnapshot,
    rxnormRxcuiSnapshot: r.rxnormRxcuiSnapshot ?? null,
    routeSnapshot: r.routeSnapshot,
    doseAmountSnapshot: r.doseAmountSnapshot === null ? null : Number(r.doseAmountSnapshot),
    doseUnitSnapshot: r.doseUnitSnapshot ?? null,
    isControlledSubstance: r.isControlledSubstance,
    isSudTreatment: r.isSudTreatment,
    isComfortKitDrawdown: r.isComfortKitDrawdown,
    documentId: r.documentId ?? null,
  };
}

/** Numeric jsonb field, or undefined (never a fabricated rate). */
function numField(data: unknown, key: string): number | undefined {
  const v =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
/** String jsonb field, or undefined. */
function strField(data: unknown, key: string): string | undefined {
  const v =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * The infusion rate a segment carries, per the §2.1 mode catalog's `data` shape: `iv_continuous_start`
 * carries `infusionRate`, `iv_continuous_rate_change` carries `newRate`; pause/resume/stop carry none.
 */
function segmentRateOf(data: unknown): { rate?: number; rateUnit?: string } {
  const rate =
    numField(data, "infusionRate") ?? numField(data, "newRate") ?? numField(data, "rate");
  const rateUnit = strField(data, "rateUnit") ?? strField(data, "infusionRateUnit");
  return {
    ...(rate !== undefined ? { rate } : {}),
    ...(rateUnit !== undefined ? { rateUnit } : {}),
  };
}

/** All five §2.8 decision kinds zeroed (the DTO's `decisionCounts` is a total Record). */
function zeroDecisionCounts(): Record<ReconciliationDecisionKind, number> {
  return { carry_forward: 0, discontinue: 0, hold: 0, new_order: 0, document_only: 0 };
}

/** Project a worksheet row + its per-kind decision tallies onto the §2.12 read DTO. */
function toWorksheetDto(
  w: WsRow,
  counts: Record<ReconciliationDecisionKind, number>,
): ReconciliationWorksheetDto {
  return {
    id: w.id,
    organizationId: w.organizationId,
    patientId: w.patientId,
    admissionId: w.admissionId,
    triggerKind: w.triggerKind,
    triggeredAt: iso(w.triggeredAt),
    finalizedAt: isoN(w.finalizedAt),
    finalizedByMembershipId: w.finalizedByMembershipId ?? null,
    status: w.status,
    lineCount: Object.values(counts).reduce((a, b) => a + b, 0),
    decisionCounts: counts,
  };
}

/**
 * Build the production {@link EmarSeamStore} — the FULL Drizzle adapter behind both §2.12 seams.
 *
 * `missedDoseCountsForOrg` counts scheduled doses DUE inside `[from, to)` and, of those, the ones with a
 * `missed_dose` row against them. Keying the window on `due_at` (rather than on the missed-dose
 * `detected_at`) is what makes the denominator the real population: a dose that was due in the window and
 * simply never actioned still counts, instead of the window only ever seeing doses someone got around to
 * flagging.
 *
 * Returns the PAIR, never a rate: an empty window (0/0) must SUPPRESS rather than score zero missed doses.
 */
export function createDrizzleEmarSeamStore(db: DbClient): EmarSeamStore {
  /** Batch the per-worksheet decision tallies for a set of worksheet ids (ONE grouped query, never N+1). */
  async function decisionCountsFor(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    worksheetIds: readonly string[],
  ): Promise<ReadonlyMap<string, Record<ReconciliationDecisionKind, number>>> {
    const out = new Map<string, Record<ReconciliationDecisionKind, number>>();
    if (worksheetIds.length === 0) return out;
    const rows = await tx
      .select({
        worksheetId: RD.worksheetId,
        kind: RD.decisionKind,
        n: sql<number>`count(*)::int`,
      })
      .from(RD)
      .where(inArray(RD.worksheetId, worksheetIds as string[]))
      .groupBy(RD.worksheetId, RD.decisionKind);
    for (const row of rows) {
      const counts = out.get(row.worksheetId) ?? zeroDecisionCounts();
      counts[row.kind] = Number(row.n) || 0;
      out.set(row.worksheetId, counts);
    }
    return out;
  }

  return {
    // ── administration reads (consumer's ambient request context) ─────────────────────────────────────
    async administrationById(administrationId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [row] = await tx.select().from(ADM).where(eq(ADM.id, administrationId)).limit(1);
        return row ? toAdministrationDto(row) : null;
      });
    },

    async administrationsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(ADM)
          .where(eq(ADM.patientId, patientId))
          .orderBy(asc(ADM.administeredAt), asc(ADM.id));
        return rows.map(toAdministrationDto);
      });
    },

    async administrationsForOrder(medicationOrderId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(ADM)
          .where(eq(ADM.medicationOrderId, medicationOrderId))
          .orderBy(asc(ADM.administeredAt), asc(ADM.id));
        return rows.map(toAdministrationDto);
      });
    },

    async prnEffectivenessRowsForPatient(patientId) {
      // Fetch the obligation-bearing PRN rows inside the tenant tx, then decide coverage against M9's
      // ScaleSeriesProvider OUTSIDE it (never hold a tx across cross-seam IO). Rows with no recommended
      // scale carry no obligation and are excluded — they can never be "documented" (the org-path rule).
      // The M9 seam resolves LAZILY per call (seams/index.ts precedent): unbound → this read THROWS and the
      // measure suppresses rather than scoring every PRN as un-reassessed (a fabricated failing rate, D6).
      const prnRows = await withOrgContextFromRequest(db, (tx) =>
        tx
          .select({
            patientId: PRN.patientId,
            scaleType: PRN.recommendedReassessmentScale,
            // The coverage-window anchors (the org-path convention: created_at starts the window).
            administeredAt: PRN.createdAt,
            reassessmentDueAt: PRN.reassessmentDueAt,
          })
          .from(PRN)
          .where(and(eq(PRN.patientId, patientId), isNotNull(PRN.recommendedReassessmentScale)))
          .orderBy(asc(PRN.createdAt), asc(PRN.id)),
      );
      const scaleSeries = getSeam("ScaleSeriesProvider");
      const out: PrnEffectivenessRow[] = [];
      for (const r of prnRows) {
        const series = await scaleSeries.series(
          r.patientId as PatientId,
          // The obligation query only surfaces rows carrying a recommended scale, so the cast is sound.
          r.scaleType as ScaleType,
          iso(r.administeredAt),
          iso(r.reassessmentDueAt),
        );
        out.push({
          administeredAt: iso(r.administeredAt),
          hasReassessment: series.points.length > 0,
        });
      }
      return out;
    },

    async doseScheduleRowsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select({ dueAt: SD.dueAt, status: SD.status })
          .from(SD)
          .where(eq(SD.patientId, patientId))
          .orderBy(asc(SD.dueAt), asc(SD.id));
        return rows.map((r) => ({ dueAt: iso(r.dueAt), status: r.status }));
      });
    },

    // ── org-aggregate measure reads (explicit organizationId; self-scoped withOrgContext) ─────────────
    missedDoseCountsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: EMAR_READER_SYSTEM_USER_ID },
        async (tx) => {
          const [row] = await tx
            .select({
              denominator: sql<number>`count(*)::int`,
              numerator: sql<number>`count(*) filter (where exists (
              select 1 from ${MD}
              where ${MD.scheduledDoseId} = ${SD.id}
                and ${MD.organizationId} = ${SD.organizationId}
            ))::int`,
            })
            .from(SD)
            .where(
              and(
                eq(SD.organizationId, organizationId),
                gte(SD.dueAt, new Date(window.from)),
                lt(SD.dueAt, new Date(window.to)),
              ),
            );
          return {
            numerator: Number(row?.numerator) || 0,
            denominator: Number(row?.denominator) || 0,
          };
        },
      );
    },

    prnReassessmentObligationsForOrg(organizationId, window) {
      return withOrgContext(
        db,
        { organizationId, userId: EMAR_READER_SYSTEM_USER_ID },
        async (tx) => {
          const rows = await tx
            .select({
              patientId: PRN.patientId,
              scaleType: PRN.recommendedReassessmentScale,
              administeredAt: PRN.createdAt,
              reassessmentDueAt: PRN.reassessmentDueAt,
            })
            .from(PRN)
            .where(
              and(
                eq(PRN.organizationId, organizationId),
                // Only administrations that carry a reassessment obligation (a recommended scale).
                isNotNull(PRN.recommendedReassessmentScale),
                // Obligation window keys on the reassessment-due instant (the population, not when actioned).
                gte(PRN.reassessmentDueAt, new Date(window.from)),
                lt(PRN.reassessmentDueAt, new Date(window.to)),
              ),
            );
          return rows.map((r) => ({
            patientId: r.patientId as PatientId,
            scaleType: r.scaleType as ScaleType,
            administeredAt: iso(r.administeredAt),
            reassessmentDueAt: iso(r.reassessmentDueAt),
          }));
        },
      );
    },

    // ── comfort-kit / IV-session reads (consumer's ambient request context) ───────────────────────────
    async comfortKitTimelineForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The EARLIEST deployment anchors the timeline (an admission can see a replacement kit later).
        const [deployment] = await tx
          .select({ deployedAt: CKD.deployedAt })
          .from(CKD)
          .where(eq(CKD.admissionId, admissionId))
          .orderBy(asc(CKD.deployedAt), asc(CKD.id))
          .limit(1);
        if (!deployment) return null; // no kit deployed for this admission — a real negative, not a gap
        // First comfort-kit administration = earliest non-voided drawdown row on the admission (a voided
        // row is entered-in-error and must not anchor a timeliness measure).
        const [firstAdministration] = await tx
          .select({ administeredAt: ADM.administeredAt })
          .from(ADM)
          .where(
            and(
              eq(ADM.admissionId, admissionId),
              eq(ADM.isComfortKitDrawdown, true),
              ne(ADM.status, "voided"),
            ),
          )
          .orderBy(asc(ADM.administeredAt), asc(ADM.id))
          .limit(1);
        return {
          admissionId,
          deployedAt: iso(deployment.deployedAt),
          firstAdministrationAt: firstAdministration
            ? iso(firstAdministration.administeredAt)
            : null,
        };
      });
    },

    async ivContinuousSessionById(ivSessionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The ordered segment sequence (the admin_rec_iv_session_idx ascending order); a voided segment is
        // entered-in-error and drops out of the projection.
        const segs = await tx
          .select()
          .from(ADM)
          .where(and(eq(ADM.ivSessionId, ivSessionId), ne(ADM.status, "voided")))
          .orderBy(asc(ADM.administeredAt), asc(ADM.id));
        const first = segs[0];
        if (!first) return null;
        const stop = segs.find((s) => s.mode === "iv_continuous_stop");
        // The M37 pump-double-check credit: the first segment that carries a verifier names it.
        const pumpVerifiedByMembershipId =
          segs.find((s) => s.pumpProgrammingVerifiedByMembershipId !== null)
            ?.pumpProgrammingVerifiedByMembershipId ?? null;
        const row: IvContinuousSessionRow = {
          sessionId: ivSessionId,
          medicationOrderId: first.medicationOrderId,
          startedAt: iso(first.administeredAt),
          endedAt: stop ? iso(stop.administeredAt) : null,
          // Segment instants are the clinical `administered_at` (the anchor startedAt/endedAt derive from,
          // and the order the session graph is legal in) — not the server-receive `recorded_at`.
          segments: segs.map((s) => ({
            kind: s.mode,
            recordedAt: iso(s.administeredAt),
            ...segmentRateOf(s.data),
          })),
          pumpVerifiedByMembershipId,
        };
        return row;
      });
    },

    // ── reconciliation reads (consumer's ambient request context) ─────────────────────────────────────
    async worksheetById(worksheetId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [w] = await tx.select().from(WS).where(eq(WS.id, worksheetId)).limit(1);
        if (!w) return null;
        const counts = await decisionCountsFor(tx, [w.id]);
        return toWorksheetDto(w, counts.get(w.id) ?? zeroDecisionCounts());
      });
    },

    async worksheetsForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const sheets = await tx
          .select()
          .from(WS)
          .where(eq(WS.admissionId, admissionId))
          .orderBy(asc(WS.triggeredAt), asc(WS.id));
        const counts = await decisionCountsFor(
          tx,
          sheets.map((w) => w.id),
        );
        return sheets.map((w) => toWorksheetDto(w, counts.get(w.id) ?? zeroDecisionCounts()));
      });
    },

    async reconciliationTimelinessForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The ADMISSION-triggered worksheet is the D17 anchor: it is opened BY the `m6.admission.activated`
        // outbox event, so its `triggered_at` IS the admission instant — no M6 read needed. A voided
        // worksheet is excluded (its re-trigger row, if any, is the live anchor).
        const [w] = await tx
          .select({ triggeredAt: WS.triggeredAt, finalizedAt: WS.finalizedAt })
          .from(WS)
          .where(
            and(
              eq(WS.admissionId, admissionId),
              eq(WS.triggerKind, "admission"),
              ne(WS.status, "voided"),
            ),
          )
          .orderBy(asc(WS.triggeredAt), asc(WS.id))
          .limit(1);
        if (!w) return null;
        return {
          admissionId,
          admissionAt: iso(w.triggeredAt),
          reconciliationFinalizedAt: isoN(w.finalizedAt),
        };
      });
    },
  };
}
