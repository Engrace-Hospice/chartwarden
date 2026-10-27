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
//   qio_review_open  (milestone 10a) admissions with an OPEN BFCC-QIO expedited review, a review with NO deadline typed first (the one most in need
//                    of attention), then soonest typed deadline.
//   nomnc_no_deadline    (milestone 10a) ACTIVE NOMNC records with no appeal-request deadline typed yet.
//   recently_discharged  admission discharged / closed (bereavement = a death) that ended ALIVE — a revocation, a
//                    transfer-out, or a completed non-death discharge — in the last RECENTLY_DISCHARGED_DAYS days,
//                    whose patient has no later admission: the readmission candidates (newest first).
// The page's discharge/transfer facts are read with ONE extra query per table, bounded by the page size.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { type SQL, and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";
import { type DischargeDetailKind, missingDischargeDetail } from "./discharge";
import type { DischargeWorklistService } from "./routes/discharge-worklist-service";
import {
  type DischargeWorklistItem,
  type DischargeWorklistPage,
  type DischargeWorklistQuery,
  RECENTLY_DISCHARGED_DAYS,
} from "./routes/discharge-worklist-typebox";
import type { AdmissionReadScope } from "./routes/service";

const ADM = schema.admissions;
const DE = schema.dischargeEvents;
const TE = schema.transferEvents;
const RE = schema.revocationEvents;
const QR = schema.expeditedReviews;
const NN = schema.nomncNotices;

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

const clampLimit = (n?: number): number =>
  n === undefined ? DEFAULT_LIMIT : Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n)));
const parseOffset = (cursor?: string): number => {
  const n = cursor ? Number.parseInt(cursor, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/**
 * The row scope: org-wide, nothing, or `patient in caseload OR admission at the caller's site`. The site arm is the
 * SQL twin of M6's `admission_clinical_site_scope` site test — the location decides when both the row and the caller
 * know one, otherwise the provider entity.
 */
function scopeFilterOf(scope: AdmissionReadScope): SQL | "org" | "none" {
  if (scope.patientIds === null) return "org";
  const arms: SQL[] = [];
  if (scope.patientIds.length > 0) arms.push(inArray(ADM.patientId, [...scope.patientIds]));
  const pes = [...(scope.sites?.providerEntityIds ?? [])];
  const locs = [...(scope.sites?.locationIds ?? [])];
  if (locs.length > 0)
    arms.push(and(isNotNull(ADM.locationId), inArray(ADM.locationId, locs)) as SQL);
  if (pes.length > 0)
    arms.push(
      (locs.length > 0
        ? and(isNull(ADM.locationId), inArray(ADM.providerEntityId, pes))
        : inArray(ADM.providerEntityId, pes)) as SQL,
    );
  if (arms.length === 0) return "none";
  return (arms.length === 1 ? arms[0] : or(...arms)) as SQL;
}

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

/** The name + MRN a Readmit row carries (`recently_discharged` only). */
export type WorklistPatientIdentity = NonNullable<DischargeWorklistItem["patient"]>;

export interface DischargeWorklistServiceDeps {
  /** Resolves a patient's name + MRN (defaults to M5's org-scoped PatientIntakeResolver seam; null = unresolved). */
  readonly patientIdentity?: (
    organizationId: string,
    patientId: string,
  ) => Promise<WorklistPatientIdentity | null>;
  /** Where a failed name lookup is reported (ids + error class only, never PHI). Defaults to stderr. */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
}

const defaultLog = (event: string, detail: Record<string, unknown>): void => {
  console.warn(JSON.stringify({ event, ...detail }));
};

const seamPatientIdentity = async (
  organizationId: string,
  patientId: string,
): Promise<WorklistPatientIdentity | null> => {
  const p = await getSeam("PatientIntakeResolver").confirmPatient({ organizationId, patientId });
  return p ? { firstName: p.firstName, lastName: p.lastName, mrn: p.mrn } : null;
};

export function createDbDischargeWorklistService(
  db: DbClient,
  deps: DischargeWorklistServiceDeps = {},
): DischargeWorklistService {
  const patientIdentity = deps.patientIdentity ?? seamPatientIdentity;
  const log = deps.log ?? defaultLog;

  /** Attach name + MRN to a Readmit page (one M5 read per distinct patient, bounded by the page size). */
  async function withPatients(
    organizationId: string,
    page: DischargeWorklistPage,
  ): Promise<DischargeWorklistPage> {
    const ids = [...new Set(page.items.map((i) => i.patientId))];
    const resolved = new Map(
      await Promise.all(
        ids.map(
          async (id) =>
            [
              id,
              await patientIdentity(organizationId, id).catch((error: unknown) => {
                // The row still renders ("Unresolved patient"); the failure must not be silent.
                log("m6.discharge_worklist.patient_lookup_failed", {
                  organizationId,
                  patientId: id,
                  error: error instanceof Error ? error.name : "unknown",
                });
                return null;
              }),
            ] as const,
        ),
      ),
    );
    return {
      ...page,
      items: page.items.map((i) => ({ ...i, patient: resolved.get(i.patientId) ?? null })),
    };
  }

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

  async function recentlyDischarged(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const LATER = schema.admissions;
    const rows = await tx
      .select(ADMISSION_COLS)
      .from(ADM)
      .where(
        and(
          ...filters,
          inArray(ADM.status, ["discharged", "closed"]),
          sql`${ADM.dischargedAt} >= now() - make_interval(days => ${RECENTLY_DISCHARGED_DAYS})`,
          sql`(
            EXISTS (SELECT 1 FROM ${RE} WHERE ${RE.admissionId} = ${ADM.id})
            OR EXISTS (SELECT 1 FROM ${TE} WHERE ${TE.admissionId} = ${ADM.id} AND ${TE.direction} = 'out')
            OR EXISTS (SELECT 1 FROM ${DE} WHERE ${DE.admissionId} = ${ADM.id} AND ${DE.status} = 'completed'
                       AND ${DE.dischargeType} <> 'death')
          )`,
          sql`NOT EXISTS (SELECT 1 FROM ${LATER} later WHERE later.patient_id = ${ADM.patientId}
                          AND later.id <> ${ADM.id} AND later.created_at > ${ADM.createdAt})`,
        ),
      )
      .orderBy(desc(ADM.dischargedAt), desc(ADM.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    const ids = p.rows.map((r) => r.id);
    if (ids.length === 0) return { items: [], nextCursor: p.nextCursor };
    const revs = await tx
      .select({ admissionId: RE.admissionId, effectiveAt: RE.effectiveAt })
      .from(RE)
      .where(inArray(RE.admissionId, ids));
    const xfers = await tx
      .select({ id: TE.id, admissionId: TE.admissionId, effectiveAt: TE.effectiveAt })
      .from(TE)
      .where(and(inArray(TE.admissionId, ids), eq(TE.direction, "out")))
      .orderBy(desc(TE.effectiveAt));
    const dis = await tx
      .select({
        id: DE.id,
        admissionId: DE.admissionId,
        dischargeType: DE.dischargeType,
        effectiveAt: DE.effectiveAt,
      })
      .from(DE)
      .where(and(inArray(DE.admissionId, ids), eq(DE.status, "completed")));
    const items = p.rows.map((a): DischargeWorklistItem => {
      const rev = revs.find((r) => r.admissionId === a.id);
      const te = xfers.find((t) => t.admissionId === a.id);
      const de = dis.find((d) => d.admissionId === a.id);
      const [dischargeType, effectiveDate] = rev
        ? ["revocation", String(rev.effectiveAt)]
        : te
          ? ["transfer_out", String(te.effectiveAt)]
          : [de ? String(de.dischargeType) : null, de ? String(de.effectiveAt) : null];
      return {
        ...baseItem(a),
        dischargeEventId: de?.id ?? null,
        transferEventId: te?.id ?? null,
        dischargeType,
        effectiveDate,
      };
    });
    return { items, nextCursor: p.nextCursor };
  }

  async function qioReviewOpen(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const nextDeadline = sql<string | null>`(
      SELECT min(d.due_at) FROM expedited_deadline d
      WHERE d.satisfied_at IS NULL
        AND (d.expedited_review_id = ${QR.id} OR d.nomnc_notice_id = ${QR.nomncNoticeId}))`;
    const rows = await tx
      .select({ ...ADMISSION_COLS, nextDeadlineAt: nextDeadline })
      .from(QR)
      .innerJoin(ADM, eq(ADM.id, QR.admissionId))
      .where(and(...filters, eq(QR.state, "open")))
      .orderBy(sql`${nextDeadline} ASC NULLS FIRST`, asc(QR.qioNotifiedAt), asc(QR.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    return {
      items: p.rows.map((r) => ({
        ...baseItem(r),
        nextDeadlineAt: r.nextDeadlineAt ? new Date(r.nextDeadlineAt).toISOString() : null,
      })),
      nextCursor: p.nextCursor,
    };
  }

  async function nomncNoDeadline(
    tx: DbClient,
    filters: SQL[],
    limit: number,
    offset: number,
  ): Promise<DischargeWorklistPage> {
    const rows = await tx
      .select({ ...ADMISSION_COLS, deliveredAt: NN.deliveredAt })
      .from(NN)
      .innerJoin(ADM, eq(ADM.id, NN.admissionId))
      .where(
        and(
          ...filters,
          eq(NN.status, "active"),
          sql`NOT EXISTS (SELECT 1 FROM expedited_deadline d
                          WHERE d.nomnc_notice_id = ${NN.id} AND d.kind = 'appeal_request')`,
        ),
      )
      .orderBy(desc(NN.deliveredAt), asc(NN.id))
      .limit(limit + 1)
      .offset(offset);
    const p = page(rows, limit, offset);
    return {
      items: p.rows.map((r) => ({ ...baseItem(r), noticeDeliveredAt: iso(r.deliveredAt) })),
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
      const scopeFilter = scopeFilterOf(scope);
      if (scopeFilter === "none") return { items: [], nextCursor: null };
      const page = await withOrgContext(db, { organizationId, userId: "" }, async (txRaw) => {
        const tx = txRaw as DbClient;
        const filters: SQL[] = [eq(ADM.organizationId, organizationId)];
        if (scopeFilter !== "org") filters.push(scopeFilter);
        if (query.bucket === "ready") return ready(tx, filters, limit, offset);
        if (query.bucket === "needs_details") return needsDetails(tx, filters, limit, offset);
        if (query.bucket === "recently_discharged")
          return recentlyDischarged(tx, filters, limit, offset);
        if (query.bucket === "qio_review_open") return qioReviewOpen(tx, filters, limit, offset);
        if (query.bucket === "nomnc_no_deadline")
          return nomncNoDeadline(tx, filters, limit, offset);
        return awaitingCosign(tx, filters, limit, offset);
      });
      // The seam opens its own org context, so the names are read after the worklist transaction.
      return query.bucket === "recently_discharged" ? withPatients(organizationId, page) : page;
    },
  };
}
