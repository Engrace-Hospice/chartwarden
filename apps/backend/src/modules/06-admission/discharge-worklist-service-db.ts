// apps/backend/src/modules/06-admission/discharge-worklist-service-db.ts — the Drizzle implementation of the
// end-of-episode worklist (routes/discharge-worklist-routes.ts). One `withOrgContext` read per call (RLS-scoped);
// the caseload narrowing is applied in SQL exactly like the admission census (GAP-020).
//
// BUCKETS
//   ready            admission active / on_hold AND no non-voided discharge_event (a for-cause discharge awaiting
//                    cosign keeps the admission active but must not be offered a second discharge).
//   needs_details    admission discharged / bereavement AND its stay-ending record lacks the claim detail
//                    (`missingDischargeDetail`: a completed death without a place of death, or — with no completed
//                    discharge — a transfer-out without a receiving care setting).
//   awaiting_cosign  discharge_event status pending_cosign (oldest first).
// The page's discharge/transfer facts are read with ONE extra query per table, bounded by the page size.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { type SQL, and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type DischargeDetailKind, missingDischargeDetail } from "./discharge";
import type { DischargeWorklistService } from "./routes/discharge-worklist-service";
import type {
  DischargeWorklistItem,
  DischargeWorklistPage,
  DischargeWorklistQuery,
} from "./routes/discharge-worklist-typebox";
import type { AdmissionReadScope } from "./routes/service";

const ADM = schema.admissions;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
const parseOffset = (cursor?: string): number => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

interface AdmissionRow {
  readonly id: string;
  readonly patientId: string;
  readonly status: string;
  readonly admissionAt: Date | null;
  readonly dischargedAt: Date | null;
}

const ADMISSION_COLS = {
  id: ADM.id,
  patientId: ADM.patientId,
  status: ADM.status,
  admissionAt: ADM.admissionAt,
  dischargedAt: ADM.dischargedAt,
};

function baseItem(a: AdmissionRow): DischargeWorklistItem {
  return {
    admissionId: a.id,
    patientId: a.patientId,
    admissionState: String(a.status),
    admissionAt: iso(a.admissionAt),
    dischargedAt: iso(a.dischargedAt),
    missing: null,
    dischargeEventId: null,
    transferEventId: null,
    dischargeType: null,
    effectiveDate: null,
  };
}

function page<T>(rows: readonly T[], limit: number, offset: number) {
  return {
    rows: rows.slice(0, limit),
    nextCursor: rows.length > limit ? String(offset + limit) : null,
  };
}

export function createDbDischargeWorklistService(db: DbClient): DischargeWorklistService {
  async function ready(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const rows = await tx
      .select(ADMISSION_COLS)
      .from(ADM)
      .where(
        and(
          ...filters,
          inArray(ADM.status, ["active", "on_hold"]),
          sql`NOT EXISTS (SELECT 1 FROM ${DE} WHERE ${DE.admissionId} = ${ADM.id} AND ${DE.status} <> 'voided')`,
        ),
      )
      .orderBy(desc(ADM.admissionAt), desc(ADM.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    return { items: p.rows.map(baseItem), nextCursor: p.nextCursor };
  }

  async function needsDetails(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const rows = await tx
      .select(ADMISSION_COLS)
      .from(ADM)
      .where(
        and(
          ...filters,
          inArray(ADM.status, ["discharged", "bereavement"]),
          sql`(
            EXISTS (SELECT 1 FROM ${DE} WHERE ${DE.admissionId} = ${ADM.id} AND ${DE.status} = 'completed'
                    AND ${DE.dischargeType} = 'death' AND ${DE.placeOfDeath} IS NULL)
            OR (
              NOT EXISTS (SELECT 1 FROM ${DE} WHERE ${DE.admissionId} = ${ADM.id} AND ${DE.status} = 'completed')
              AND EXISTS (SELECT 1 FROM ${TE} WHERE ${TE.admissionId} = ${ADM.id} AND ${TE.direction} = 'out'
                          AND ${TE.receivingCareSetting} IS NULL)
            )
          )`,
        ),
      )
      .orderBy(desc(ADM.dischargedAt), desc(ADM.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    const ids = p.rows.map((r) => r.id);
    if (ids.length === 0) return { items: [], nextCursor: p.nextCursor };

    const discharges = await tx
      .select({
        id: DE.id,
        admissionId: DE.admissionId,
        dischargeType: DE.dischargeType,
        effectiveAt: DE.effectiveAt,
        placeOfDeath: DE.placeOfDeath,
      })
      .from(DE)
      .where(and(inArray(DE.admissionId, ids), eq(DE.status, "completed")));
    const transfers = await tx
      .select({
        id: TE.id,
        admissionId: TE.admissionId,
        effectiveAt: TE.effectiveAt,
        setting: TE.receivingCareSetting,
      })
      .from(TE)
      .where(and(inArray(TE.admissionId, ids), eq(TE.direction, "out")))
      .orderBy(desc(TE.effectiveAt));

    const items = p.rows.map((a): DischargeWorklistItem => {
      const de = discharges.find((d) => d.admissionId === a.id) ?? null;
      const te = transfers.find((t) => t.admissionId === a.id) ?? null; // latest first
      const missing: DischargeDetailKind | null = missingDischargeDetail({
        discharge: de
          ? { reason: String(de.dischargeType), placeOfDeath: de.placeOfDeath ?? null }
          : null,
        transferOut: te ? { receivingCareSetting: te.setting ?? null } : null,
      });
      const viaDischarge = missing === "place_of_death" && de !== null;
      return {
        ...baseItem(a),
        missing,
        dischargeEventId: de?.id ?? null,
        transferEventId: te?.id ?? null,
        dischargeType: de ? String(de.dischargeType) : te ? "transfer_out" : null,
        effectiveDate: viaDischarge
          ? String(de?.effectiveAt)
          : te
            ? String(te.effectiveAt)
            : de
              ? String(de.effectiveAt)
              : null,
      };
    });
    return { items, nextCursor: p.nextCursor };
  }

  async function awaitingCosign(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const rows = await tx
      .select({
        ...ADMISSION_COLS,
        dischargeEventId: DE.id,
        dischargeType: DE.dischargeType,
        effectiveAt: DE.effectiveAt,
      })
      .from(DE)
      .innerJoin(ADM, eq(ADM.id, DE.admissionId))
      .where(and(...filters, eq(DE.status, "pending_cosign"), isNull(DE.cosignedAt)))
      .orderBy(asc(DE.createdAt), asc(DE.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    return {
      items: p.rows.map((r) => ({
        ...baseItem(r),
        dischargeEventId: r.dischargeEventId,
        dischargeType: String(r.dischargeType),
        effectiveDate: String(r.effectiveAt),
      })),
      nextCursor: p.nextCursor,
    };
  }

  return {
    async list(
      organizationId: string,
      query: DischargeWorklistQuery,
      scope: AdmissionReadScope,
    ): Promise<DischargeWorklistPage> {
      const limit = clampLimit(query.limit);
      const offset = parseOffset(query.cursor);
      const scopedIds = scope.patientIds;
      if (scopedIds !== null && scopedIds.length === 0) return { items: [], nextCursor: null };
      return withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const filters: SQL[] = [eq(ADM.organizationId, organizationId)];
        if (scopedIds !== null) filters.push(inArray(ADM.patientId, [...scopedIds]));
        if (query.bucket === "ready") return ready(tx, filters, limit, offset);
        if (query.bucket === "needs_details") return needsDetails(tx, filters, limit, offset);
        return awaitingCosign(tx, filters, limit, offset);
      });
    },
  };
}
