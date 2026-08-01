// apps/backend/src/modules/11-orders — PRODUCTION OrderRouteService + OrderAbacResolver, READ-first (M11L).
//
// The screen-driving READS (order worklists by patient/admission/kind/status, the pending-signature /
// verbal-expiring / cosign-pending / results-review queues, standing-order lists + detail, and the per-org
// verbal-order policy) run as real Drizzle queries over the M11-owned tables inside `withOrgContext`, so RLS
// scopes every row by `app.org_id` as the unprivileged `wardenx_app` role. `order_record` is PARTITION BY
// RANGE(created_at) — reads query the parent (partition pruning happens in PG). The full WRITE lifecycle
// (draft → sign / verbal / cosign → discontinue / complete, standing-order spawn, verbal-policy edit) is the
// M11L write follow-up; every write here fail-closes 501 (`NOT_IMPLEMENTED`) so the interface is satisfied and
// the mount is real. The in-memory `createInMemoryOrderBackend` (`routes/service.ts`) stays the behavioral
// reference for those writes. The returned object IS BOTH the OrderRouteService AND the §4.7 AbacResolver
// (`loadOrder`), mirroring the scaffold's `registerOrderRoutes({ service })` + `registerOrderAbacPredicates(
// { resolver })` both binding `core.m11`.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  NotFoundError,
  type OrderDiscontinuationReason,
  type OrderKind,
  type OrderPriority,
  type OrderStatus,
  type StandingOrderCadence,
  type StandingOrderStatus,
  WardenXError,
} from "@wardenx/types";
import { type SQL, and, desc, eq } from "drizzle-orm";
import { DEFAULT_COSIGN_POLICY } from "@wardenx/orders";
import type {
  OrderAbacFacts,
  OrderRouteService,
  OrderView,
  StandingOrderView,
  VerbalPolicyView,
} from "./routes/service";

const OR = schema.orderRecords;
const SO = schema.standingOrders;
const OS = schema.orderSignatures;
const VO = schema.verbalOrders;
const VP = schema.orderVerbalPolicies;

/** A never-returning stub for the write lifecycle still owed by the M11L write follow-up. */
const notImpl = (): never => {
  throw new WardenXError(
    "NOT_IMPLEMENTED",
    "order writes arrive in the M11L write follow-up (the Drizzle write lifecycle)",
    501,
  );
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The default per-org verbal policy the read returns when no `order_verbal_policy` row exists (mirrors the slice). */
const DEFAULT_POLICY: VerbalPolicyView = {
  windowHours: 48,
  businessHoursOnly: false,
  lpnCosignRequiredKinds: DEFAULT_COSIGN_POLICY.lpnCosignRequiredKinds,
  npCosignRequiredKinds: DEFAULT_COSIGN_POLICY.npCosignRequiredKinds,
  platformFloorWindowHours: 48,
  policyVersion: "v1",
};

/** The joined order-record read projection (order_record + its unique verbal-order + primary signature). */
type OrderRow = {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  status: string;
  priority: string;
  version: number;
  drafterMembershipId: string;
  drafterDiscipline: string;
  orderingPhysicianMdmId: string;
  cosignRequired: boolean;
  cosignStatus: string | null;
  transmissionStatus: string;
  resultsStatus: string;
  replacesOrderId: string | null;
  triggeringAssessmentId: string | null;
  triggeringHopeAssessmentId: string | null;
  signedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  verbalDeadlineAt: Date | null;
  signedBy: string | null;
};

const toOrderView = (r: OrderRow): OrderView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  kind: r.kind as OrderKind,
  status: r.status as OrderStatus,
  priority: r.priority as OrderPriority,
  version: Number(r.version),
  drafterMembershipId: r.drafterMembershipId,
  drafterDiscipline: r.drafterDiscipline,
  orderingPhysicianMdmId: r.orderingPhysicianMdmId,
  cosignRequired: r.cosignRequired,
  cosignStatus: (r.cosignStatus as "pending" | "attached" | null) ?? null,
  transmissionStatus: r.transmissionStatus,
  resultsStatus: r.resultsStatus,
  verbalDeadlineAt: iso(r.verbalDeadlineAt),
  // The discontinuation reason lives in `order_discontinuation` (no uniqueness → not joined to avoid
  // row-multiplication in the worklists); the M11L write follow-up projects it. Reads null for now.
  discontinuationReason: null as OrderDiscontinuationReason | null,
  replacesOrderId: r.replacesOrderId,
  triggeringAssessmentId: r.triggeringAssessmentId,
  triggeringHopeAssessmentId: r.triggeringHopeAssessmentId,
  signedAt: iso(r.signedAt),
  signedBy: r.signedBy,
  completedAt: iso(r.completedAt),
  createdAt: (iso(r.createdAt) as string) ?? new Date(0).toISOString(),
});

const toStandingView = (r: {
  id: string;
  patientId: string;
  admissionId: string;
  kind: string;
  cadence: string;
  status: string;
  nextSpawnAt: Date | null;
  spawnCount: number;
  maxSpawns: number | null;
}): StandingOrderView => ({
  id: r.id,
  patientId: r.patientId,
  admissionId: r.admissionId,
  kind: r.kind as OrderKind,
  cadence: r.cadence as StandingOrderCadence,
  status: r.status as StandingOrderStatus,
  nextSpawnAt: iso(r.nextSpawnAt),
  spawnCount: Number(r.spawnCount),
  maxSpawns: r.maxSpawns == null ? null : Number(r.maxSpawns),
});

/**
 * The production, RLS-backed OrderRouteService + §4.7 OrderAbacResolver. Reads are real; writes fail-closed
 * 501. Org is bound from the request context by the caller and passed as `organizationId` — never the body.
 */
export function createDbOrderBackend(db: DbClient): OrderRouteService {
  /** The reusable order-record select — parent partition, left-joined to its unique verbal-order + primary signature. */
  const selectOrders = (tx: DbClient, where: SQL | undefined) =>
    tx
      .select({
        id: OR.id,
        patientId: OR.patientId,
        admissionId: OR.admissionId,
        kind: OR.kind,
        status: OR.status,
        priority: OR.priority,
        version: OR.version,
        drafterMembershipId: OR.drafterMembershipId,
        drafterDiscipline: OR.drafterDiscipline,
        orderingPhysicianMdmId: OR.orderingPhysicianMdmId,
        cosignRequired: OR.cosignRequired,
        cosignStatus: OR.cosignStatus,
        transmissionStatus: OR.transmissionStatus,
        resultsStatus: OR.resultsStatus,
        replacesOrderId: OR.replacesOrderId,
        triggeringAssessmentId: OR.triggeringAssessmentId,
        triggeringHopeAssessmentId: OR.triggeringHopeAssessmentId,
        signedAt: OR.signedAt,
        completedAt: OR.completedAt,
        createdAt: OR.createdAt,
        verbalDeadlineAt: VO.deadlineAt,
        signedBy: OS.signerMembershipId,
      })
      .from(OR)
      .leftJoin(VO, and(eq(VO.targetKind, "order"), eq(VO.targetId, OR.id)))
      .leftJoin(
        OS,
        and(eq(OS.targetKind, "order"), eq(OS.targetId, OR.id), eq(OS.signatureKind, "signature")),
      )
      .where(where)
      .orderBy(desc(OR.createdAt), desc(OR.id));

  const listWhere = (organizationId: string, extra: SQL | undefined): Promise<{ orders: OrderView[] }> =>
    withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
      const rows = (await selectOrders(tx as DbClient, extra)) as unknown as OrderRow[];
      return { orders: rows.map(toOrderView) };
    });

  return {
    // ── Order reads ────────────────────────────────────────────────────────────────────────────────
    async listOrders(organizationId, filter) {
      const conds: SQL[] = [];
      if (filter.patientId) conds.push(eq(OR.patientId, filter.patientId));
      if (filter.admissionId) conds.push(eq(OR.admissionId, filter.admissionId));
      if (filter.kind) conds.push(eq(OR.kind, filter.kind as OrderKind));
      if (filter.status) conds.push(eq(OR.status, filter.status as OrderStatus));
      return listWhere(organizationId, conds.length ? and(...conds) : undefined);
    },
    async getOrder(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const rows = (await selectOrders(tx as DbClient, eq(OR.id, id)).limit(1)) as unknown as OrderRow[];
        if (!rows[0]) throw new NotFoundError(`order ${id} not found`);
        return toOrderView(rows[0]);
      });
    },
    async pendingSignature(organizationId) {
      return listWhere(organizationId, eq(OR.status, "pending_signature"));
    },
    async verbalExpiring(organizationId) {
      return listWhere(organizationId, eq(OR.status, "verbal_pending"));
    },
    async cosignPending(organizationId) {
      return listWhere(organizationId, eq(OR.cosignStatus, "pending"));
    },
    async resultsPendingReview(organizationId) {
      return listWhere(organizationId, and(eq(OR.kind, "lab"), eq(OR.resultsStatus, "results_received")));
    },
    async suggestions(_organizationId, patientId) {
      // §2.7 assessment/HOPE order suggestions are event-driven projections owed to the write follow-up.
      return { patientId, suggestions: [] };
    },

    // ── Standing-order reads ─────────────────────────────────────────────────────────────────────────
    async listStandingOrders(organizationId, patientId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const where = patientId ? eq(SO.patientId, patientId) : undefined;
        const rows = await tx
          .select({
            id: SO.id,
            patientId: SO.patientId,
            admissionId: SO.admissionId,
            kind: SO.kind,
            cadence: SO.cadence,
            status: SO.status,
            nextSpawnAt: SO.nextSpawnAt,
            spawnCount: SO.spawnCount,
            maxSpawns: SO.maxSpawns,
          })
          .from(SO)
          .where(where)
          .orderBy(desc(SO.createdAt));
        return { standingOrders: rows.map(toStandingView) };
      });
    },
    async getStandingOrder(organizationId, id) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            id: SO.id,
            patientId: SO.patientId,
            admissionId: SO.admissionId,
            kind: SO.kind,
            cadence: SO.cadence,
            status: SO.status,
            nextSpawnAt: SO.nextSpawnAt,
            spawnCount: SO.spawnCount,
            maxSpawns: SO.maxSpawns,
          })
          .from(SO)
          .where(eq(SO.id, id))
          .limit(1);
        if (!r) throw new NotFoundError(`standing order ${id} not found`);
        return toStandingView(r);
      });
    },

    // ── Verbal-order policy read (one row per org; default when unseeded) ────────────────────────────
    async getVerbalPolicy(organizationId) {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            windowHours: VP.windowHours,
            businessHoursOnly: VP.businessHoursOnly,
            lpnCosignRequiredKinds: VP.lpnCosignRequiredKinds,
            npCosignRequiredKinds: VP.npCosignRequiredKinds,
            platformFloorWindowHours: VP.platformFloorWindowHours,
            policyVersion: VP.policyVersion,
          })
          .from(VP)
          .limit(1);
        if (!r) return DEFAULT_POLICY;
        return {
          windowHours: Number(r.windowHours),
          businessHoursOnly: r.businessHoursOnly,
          lpnCosignRequiredKinds: (r.lpnCosignRequiredKinds as OrderKind[]) ?? [],
          npCosignRequiredKinds: (r.npCosignRequiredKinds as OrderKind[]) ?? [],
          platformFloorWindowHours: Number(r.platformFloorWindowHours),
          policyVersion: r.policyVersion,
        };
      });
    },

    // ── §4.7 ABAC resolver (loadOrder) — org-scoped, RLS-backstopped; null fails the predicate closed ──
    async loadOrder(organizationId, orderId): Promise<OrderAbacFacts | null> {
      return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
        const [r] = await tx
          .select({
            kind: OR.kind,
            drafterMembershipId: OR.drafterMembershipId,
            cosignRequired: OR.cosignRequired,
            cosignStatus: OR.cosignStatus,
          })
          .from(OR)
          .where(eq(OR.id, orderId))
          .limit(1);
        if (!r) return null;
        // `order_record` carries no explicit cosigner-role column; the resolved axis is derived by the write
        // path. Reads surface `null` (the predicate defaults it to 'rn_case_manager'), matching the slice
        // for records that have not yet requested signature.
        return {
          kind: r.kind as OrderKind,
          drafterMembershipId: r.drafterMembershipId,
          cosignerRoleNeeded: null,
          cosignRequired: r.cosignRequired,
          alreadyCosigned: r.cosignStatus === "attached",
        };
      });
    },

    // ── Writes — the M11L Drizzle write lifecycle. Fail-closed 501 until then. ──────────────────────
    createDraft: async () => notImpl(),
    editDraft: async () => notImpl(),
    requestSignature: async () => notImpl(),
    signOrder: async () => notImpl(),
    signOnBehalf: async () => notImpl(),
    recordVerbal: async () => notImpl(),
    cosignOrder: async () => notImpl(),
    discontinueOrder: async () => notImpl(),
    correctOrder: async () => notImpl(),
    completeOrder: async () => notImpl(),
    createStandingOrder: async () => notImpl(),
    editStandingOrder: async () => notImpl(),
    pauseStandingOrder: async () => notImpl(),
    resumeStandingOrder: async () => notImpl(),
    discontinueStandingOrder: async () => notImpl(),
    spawnStandingOrder: async () => notImpl(),
    putVerbalPolicy: async () => notImpl(),
    regenerateVerbalTimer: async () => notImpl(),

    // No events are buffered on the read path (writes are 501); drain is a no-op.
    drainEvents: () => [],
  };
}
