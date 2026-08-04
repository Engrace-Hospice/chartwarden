// apps/backend/src/modules/12-dosespot/seams/drizzle-store.ts — the Drizzle-backed
// {@link DoseSpotSeamStore} the two §2.10 D17 published seams (MedicationOrderProvider /
// RefillInboxProvider) read through.
//
// TENANCY. Every read opens `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S
// ambient request context (the M21 store-drizzle precedent). That is the whole tenancy story: no
// DoseSpotSeamStore method takes an orgId and the providers never switch tenants — M13 asking for a
// patient's medication orders gets M13's caller's org because RLS scoped the statement, not because this
// file compared anything. Called outside a request scope (a platform job that forgot
// `runWithRequestContext`) it THROWS rather than reading unscoped, the correct direction for a surface
// that publishes controlled-substance prescriptions.
//
// PHI (D14 / §7.6). The per-class `data` jsonb carries the clinician free-text (sig_free_text /
// indication / clinical_justification / notes) and NEVER crosses the seam — only the server-canonicalized
// `sigStructured` projection does. `sigStructuredOf` below is an ALLOWLIST projection: it copies the
// named SigStructuredDto keys and nothing else, so an unexpected key in `data` (including every free-text
// field) structurally cannot leak through this store.
//
// PARTITIONED PARENT. `medication_order` is PARTITION BY RANGE (created_at) monthly (§3.5 D15), so an
// id-only lookup fans out across every partition. The reads stay id-keyed anyway — a seam consumer has an
// id and no time window, and inventing one would silently miss an order drafted last month (the M21
// dispatch-store trade). The patient/admission indexes carry the per-partition cost.
//
// GAPS (typed refusals, never fabricated numbers):
//   - `costBasisForAdmissionMonth` — the schema gap CLOSED (mig 0158: `medication_order.acquisition_cost_cents`,
//     integer CENTS, NULL = "not priced"), but the DATA gap remains until the DoseSpot fill/NDC pricing feed
//     populates it. The rollup aggregates ONLY when every in-scope line for the admission-month carries a
//     non-NULL cost; if ANY line is unpriced it THROWS the typed {@link DoseSpotSeamGapError} with the
//     priced/unpriced counts ("3 of 7 lines unpriced") so the M27 Worksheet S-7 reconciler sees exactly how
//     far the data is — `{ totalCostCents: 0, lineCount: 0 }` for an unpriced month would be a fabricated $0
//     drug spend. An admission-month with genuinely ZERO lines is a real `{ 0, 0 }` (port contract: empty
//     slice when the subject has no rows), not a refusal.
//   - `comfortKitTimelineForAdmission` — M12 owns NO comfort-kit table (deployment lives in M13's
//     `comfort_kit_deployment` / M21's `comfort_kit_dispatch`). Returning `null` would read as "no comfort
//     kit was ever deployed for this admission" — a fabricated negative for a timeliness measure — so it
//     THROWS the same typed refusal and points the consumer at M13's
//     `MedicationAdministrationProvider.getComfortKitDeploymentTimeline`, which computes the real timeline.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContextFromRequest } from "@wardenx/tenancy";
import type { MedicationOrderDto, RefillRequestDto, SigStructuredDto } from "@wardenx/types";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";
import type { DoseSpotSeamStore } from "./store";

const MO = schema.medicationOrders;
const RR = schema.refillRequests;

type MoRow = typeof MO.$inferSelect;
type RrRow = typeof RR.$inferSelect;

const iso = (d: Date): string => d.toISOString();
const isoN = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * A typed refusal for a seam read whose backing schema does not exist yet (D16 fail direction: a number
 * this store cannot materialize is thrown, never fabricated as 0). Consumers catch-and-degrade the same
 * way they do a boot deny-stub throw.
 */
export class DoseSpotSeamGapError extends Error {
  readonly code = "M12_SEAM_SCHEMA_GAP" as const;
  constructor(
    /** The store method that refused. */
    readonly method: string,
    detail: string,
  ) {
    super(`M12_SEAM_SCHEMA_GAP(${method}): ${detail}`);
    this.name = "DoseSpotSeamGapError";
  }
}

/** One in-scope cost line for {@link costBasisOfLines} — the projected cost column and nothing else. */
export interface CostBasisLine {
  /** `medication_order.acquisition_cost_cents` (mig 0158): integer CENTS; NULL = not priced. */
  readonly acquisitionCostCents: number | null;
}

/**
 * The drug-cost rollup HONESTY KERNEL (pure; the Drizzle read below feeds it, tests exercise it directly).
 * Sums `acquisitionCostCents` ONLY when every in-scope line is priced (non-NULL). If ANY line is unpriced
 * it throws the typed {@link DoseSpotSeamGapError} naming the counts ("3 of 7 lines unpriced") — treating
 * NULL as $0 would feed M27's Worksheet S-7 a fabricated drug spend. Zero lines is a REAL `{ 0, 0 }` (the
 * admission-month genuinely has no medication-order lines — no fabrication involved), and an explicit
 * 0-cent line is a real price (free/fully-rebated), distinct from NULL.
 */
export function costBasisOfLines(
  lines: readonly CostBasisLine[],
  admissionId: string,
  monthKey: string,
): { totalCostCents: number; lineCount: number } {
  const unpriced = lines.filter((l) => l.acquisitionCostCents === null).length;
  if (unpriced > 0) {
    throw new DoseSpotSeamGapError(
      "costBasisForAdmissionMonth",
      `${unpriced} of ${lines.length} medication_order lines for admission ${admissionId} month ${monthKey} ` +
        "carry no acquisition_cost_cents (NULL = not priced); the rollup refuses rather than zero-fill — " +
        "M27's Worksheet S-7 must never ingest a fabricated $0 drug spend. The DoseSpot fill/NDC pricing " +
        "feed (or a pricing backfill) must price every line before this month can be materialized.",
    );
  }
  let totalCostCents = 0;
  for (const l of lines) totalCostCents += l.acquisitionCostCents ?? 0;
  return { totalCostCents, lineCount: lines.length };
}

/**
 * The UTC month window `[start, end)` of a `monthIso` bucket key (`YYYY-MM` or any ISO instant within the
 * month — the port keys on the `YYYY-MM` prefix). Bucketing anchors on `created_at`: it is the partition
 * key (§3.5 D15 monthly partitions — the window prunes to one partition) and the only NOT NULL instant a
 * line is guaranteed to carry. A malformed key is a caller bug, not a data gap → RangeError, not the seam
 * refusal.
 */
function monthWindowOf(monthIso: string): { start: Date; end: Date; key: string } {
  const key = monthIso.slice(0, 7);
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  const month = m === null ? Number.NaN : Number(m[2]);
  if (m === null || month < 1 || month > 12) {
    throw new RangeError(
      `costBasisForAdmissionMonth: monthIso must begin with a YYYY-MM month bucket, got ${JSON.stringify(monthIso)}`,
    );
  }
  const year = Number(m[1]);
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
    key,
  };
}

/**
 * ALLOWLIST-project the per-class `data` jsonb onto the §3.4 server-canonicalized {@link SigStructuredDto}.
 *
 * Reads `data.sigStructured` when the writer nested it, else the top-level sig keys — and copies ONLY the
 * named DTO keys with type checks, so the free-text PHI living beside them (sig_free_text / indication /
 * clinical_justification / notes, D14) structurally cannot cross. A draft whose `data` carries no
 * canonical sig yet projects neutral empties (`route` falls back to the row's own `route` column) — the
 * projection is a display shape, not a measure input, and the raw free-text is never the fallback.
 */
function sigStructuredOf(data: unknown, rowRoute: string): SigStructuredDto {
  const root: Record<string, unknown> =
    typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const nested = root["sigStructured"];
  const src: Record<string, unknown> =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : root;

  const num = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) ? v : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;

  const durationSrc =
    typeof src["duration"] === "object" && src["duration"] !== null
      ? (src["duration"] as Record<string, unknown>)
      : undefined;
  const durationValue = num(durationSrc?.["durationValue"]);
  const durationUnit = str(durationSrc?.["durationUnit"]);
  let duration: SigStructuredDto["duration"];
  if (
    durationValue !== undefined &&
    (durationUnit === "days" || durationUnit === "weeks" || durationUnit === "months")
  ) {
    duration = { durationValue, durationUnit };
  }
  const asNeededReasonCode = str(src["asNeededReasonCode"]);

  return {
    doseQuantity: num(src["doseQuantity"]) ?? 0,
    doseUnit: str(src["doseUnit"]) ?? "",
    route: str(src["route"]) ?? rowRoute,
    frequencyCode: str(src["frequencyCode"]) ?? "",
    asNeeded: typeof src["asNeeded"] === "boolean" ? src["asNeeded"] : false,
    ...(duration !== undefined ? { duration } : {}),
    ...(asNeededReasonCode !== undefined ? { asNeededReasonCode } : {}),
  };
}

/** Project a `medication_order` row onto the §2.10 read DTO (explicit column map; never the raw row). */
function toMedicationOrderDto(r: MoRow): MedicationOrderDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    admissionId: r.admissionId,
    medClass: r.medClass,
    status: r.status,
    rxnormRxcui: r.rxnormRxcui ?? null,
    ndc: r.ndc ?? null,
    drugName: r.drugName,
    strength: r.strength,
    doseForm: r.doseForm,
    route: r.route,
    sigStructured: sigStructuredOf(r.data, r.route),
    prescriberMembershipId: r.prescriberMembershipId,
    prescribingPhysicianMdmId: r.prescribingPhysicianMdmId,
    dispensingPharmacyMdmId: r.dispensingPharmacyMdmId ?? null,
    refillsRemaining: Number(r.refillsRemaining),
    signedAt: isoN(r.signedAt),
    transmittedAt: isoN(r.transmittedAt),
    activatedAt: isoN(r.activatedAt),
    discontinuedAt: isoN(r.discontinuedAt),
    isControlledSubstance: r.isControlledSubstance,
    deaSchedule: r.deaSchedule ?? null,
    isSudTreatment: r.isSudTreatment,
    derivedFromRefillId: r.derivedFromRefillId ?? null,
    derivedFromHistoryId: r.derivedFromHistoryId ?? null,
    replacesMedicationOrderId: r.replacesMedicationOrderId ?? null,
    documentId: r.documentId ?? null,
  };
}

/**
 * `requested_quantity` is stored as free-form text from the DoseSpot webhook ("30", "30.0", sometimes
 * "30 tablets"); the DTO wants `number | null`. Parse the leading numeric, and refuse (null) anything
 * non-numeric rather than fabricating a quantity.
 */
function requestedQuantityOf(raw: string | null): number | null {
  if (raw === null) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Project a `refill_request` row onto the §2.7 read DTO. `prescriberMembershipId` is the NAMED prescriber
 * of the SOURCE medication order (the inbox routing identity the `refill_inbox_scope` ABAC keys on, and
 * what `refillRequestsForPrescriber` filters by) — resolved by the caller from a batched source-order read
 * and passed in; a decided row falls back to its decider so a post-decision read still names an owner.
 */
function toRefillRequestDto(
  r: RrRow,
  sourcePrescriberMembershipId: string | null,
): RefillRequestDto {
  return {
    id: r.id,
    organizationId: r.organizationId,
    patientId: r.patientId,
    sourceMedicationOrderId: r.sourceMedicationOrderId,
    status: r.status,
    requestedAt: iso(r.receivedAt),
    requestedQuantity: requestedQuantityOf(r.requestedQuantity),
    prescriberMembershipId:
      sourcePrescriberMembershipId ?? r.approvedByMembershipId ?? r.deniedByMembershipId ?? null,
    resultingMedicationOrderId: r.resultingMedicationOrderId ?? null,
  };
}

/**
 * Build the production Drizzle-backed {@link DoseSpotSeamStore} (READ-only over `medication_order` /
 * `refill_request`, under the consumer's ambient RLS context). Injected into `registerDoseSpotSeams` by
 * the composition root's db branch so one adapter backs the whole medication-order/refill read surface.
 */
export function createDrizzleDoseSpotSeamStore(db: DbClient): DoseSpotSeamStore {
  /** Batch-resolve the source orders' named prescriber for a set of refill rows (ONE query, never N+1). */
  async function sourcePrescribersFor(
    tx: Parameters<Parameters<DbClient["transaction"]>[0]>[0],
    rows: readonly RrRow[],
  ): Promise<ReadonlyMap<string, string>> {
    const sourceIds = [...new Set(rows.map((r) => r.sourceMedicationOrderId))];
    if (sourceIds.length === 0) return new Map();
    const sources = await tx
      .select({ id: MO.id, prescriberMembershipId: MO.prescriberMembershipId })
      .from(MO)
      .where(inArray(MO.id, sourceIds));
    return new Map(sources.map((s) => [s.id, s.prescriberMembershipId] as const));
  }

  return {
    // ── medication-order reads (MedicationOrderProvider) ──────────────────────────────────────────────
    async medicationOrderById(medicationOrderId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [row] = await tx.select().from(MO).where(eq(MO.id, medicationOrderId)).limit(1);
        return row ? toMedicationOrderDto(row) : null;
      });
    },

    async medicationOrdersForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(MO)
          .where(eq(MO.patientId, patientId))
          .orderBy(desc(MO.createdAt), desc(MO.id));
        return rows.map(toMedicationOrderDto);
      });
    },

    async medicationOrdersForAdmission(admissionId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(MO)
          .where(eq(MO.admissionId, admissionId))
          .orderBy(desc(MO.createdAt), desc(MO.id));
        return rows.map(toMedicationOrderDto);
      });
    },

    async comfortKitTimelineForAdmission(admissionId) {
      // SCHEMA GAP (see header): M12 owns no comfort-kit table — deployment is M13's
      // `comfort_kit_deployment` (and M21's dispatch). `null` here would fabricate "no kit was deployed"
      // into the comfort-kit-timeliness measure, so this refuses loudly instead.
      throw new DoseSpotSeamGapError(
        "comfortKitTimelineForAdmission",
        `M12 owns no comfort-kit deployment table (admission ${admissionId}); resolve the timeline through ` +
          "M13's MedicationAdministrationProvider.getComfortKitDeploymentTimeline (backed by " +
          "comfort_kit_deployment + administration_record), which M12 cannot read (§25.15 table ownership).",
      );
    },

    async costBasisForAdmissionMonth(admissionId, monthIso) {
      // DATA-GAP honesty (see header): the cost column exists (mig 0158) but only the future DoseSpot
      // fill/NDC pricing feed populates it. In-scope = EVERY medication_order line created in the month
      // for the admission, regardless of status — fail-closed: a never-transmitted draft with a NULL cost
      // blocks the month rather than being silently dropped (narrowing scope to dispensed statuses is a
      // future refinement for when the pricing feed defines which states bear cost). The pure kernel
      // {@link costBasisOfLines} then answers only when every line is priced, else throws the typed
      // refusal with the counts.
      const { start, end, key } = monthWindowOf(monthIso);
      return withOrgContextFromRequest(db, async (tx) => {
        const lines = await tx
          .select({ acquisitionCostCents: MO.acquisitionCostCents })
          .from(MO)
          .where(
            and(eq(MO.admissionId, admissionId), gte(MO.createdAt, start), lt(MO.createdAt, end)),
          );
        return costBasisOfLines(lines, admissionId, key);
      });
    },

    // ── refill-inbox reads (RefillInboxProvider) ──────────────────────────────────────────────────────
    async refillRequestById(refillRequestId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const [row] = await tx.select().from(RR).where(eq(RR.id, refillRequestId)).limit(1);
        if (!row) return null;
        const prescribers = await sourcePrescribersFor(tx, [row]);
        return toRefillRequestDto(row, prescribers.get(row.sourceMedicationOrderId) ?? null);
      });
    },

    async refillRequestsForPrescriber(prescriberMembershipId) {
      return withOrgContextFromRequest(db, async (tx) => {
        // The inbox identity is the SOURCE order's named prescriber (`refill_request` itself carries no
        // prescriber column — only the post-decision approve/deny actors), so the filter joins through
        // `medication_order`. The partitioned parent makes this a fan-out join; the by-prescriber partial
        // index on medication_order carries it.
        const rows = await tx
          .select({ rr: RR, sourcePrescriberMembershipId: MO.prescriberMembershipId })
          .from(RR)
          .innerJoin(
            MO,
            and(eq(MO.id, RR.sourceMedicationOrderId), eq(MO.organizationId, RR.organizationId)),
          )
          .where(eq(MO.prescriberMembershipId, prescriberMembershipId))
          .orderBy(desc(RR.receivedAt), desc(RR.id));
        return rows.map((r) => toRefillRequestDto(r.rr, r.sourcePrescriberMembershipId));
      });
    },

    async refillRequestsForPatient(patientId) {
      return withOrgContextFromRequest(db, async (tx) => {
        const rows = await tx
          .select()
          .from(RR)
          .where(eq(RR.patientId, patientId))
          .orderBy(desc(RR.receivedAt), desc(RR.id));
        const prescribers = await sourcePrescribersFor(tx, rows);
        return rows.map((r) =>
          toRefillRequestDto(r, prescribers.get(r.sourceMedicationOrderId) ?? null),
        );
      });
    },
  };
}
