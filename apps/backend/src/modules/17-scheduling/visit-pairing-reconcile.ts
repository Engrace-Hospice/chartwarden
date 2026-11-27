// apps/backend/src/modules/17-scheduling/visit-pairing-reconcile.ts — CW-PI-04: detect, and optionally correct,
// older visits whose stamped clinician discipline today's pairing rules would refuse.
//
// WHAT IS "ILLEGAL": the visit's (visit_purpose, assigned_discipline_at_assignment) is not a pair
// `@chartwarden/scheduling` accepts today (the purpose's discipline gate AND a legal M8 encounter pair), see
// `classifyVisitPairing`. Visits created before those rules landed can carry one; no database CHECK stops it.
//
// WHAT "FIX" MEANS (decided here, never guessed):
//   - RESTAMP: an OPEN visit (proposed | published) whose own assignee is an active member and holds, as a live
//     role, and is credentialed on the service date for EXACTLY ONE discipline that is legal for the purpose. Only
//     `assigned_discipline_at_assignment` changes. The assignee, the purpose and the time are never touched:
//     moving a visit between people is a scheduling decision, not a data repair. No outbox event is emitted
//     (the assignee did not change), and the M8 draft a first publish may have created is left alone (the
//     report names the status of each restamp so an operator can check the published ones).
//   - REVIEW (a person decides; nothing is written): the assignee is not an active member, holds no legal
//     discipline, holds one without an active credential, holds more than one (the policy order is not a
//     tiebreak), or the visit is en route / in visit.
//   - HISTORICAL (reported, never changed): completed, cancelled, no-show and rescheduled visits are the record
//     of what happened.
//
// SAFETY: `planVisitPairingsForOrg` is read-only. `applyVisitPairingRestampsForOrg` writes only inside one
// `withOrgContext` transaction per tenant, as the system actor, refuses a plan bigger than `maxRows` before any
// write, guards each UPDATE on the (status, version, stamped discipline) it planned from (a visit changed in the
// meantime is skipped, not overwritten), and writes one `m17.visit.pairing_reconciled` audit event per changed
// visit in the same transaction (an audit failure rolls the whole tenant back). It never deletes a visit and
// re-running it finds nothing left to restamp. Output carries ids and codes only: no names, no free text.
import { audit } from "@chartwarden/audit";
import { type DbClient, schema } from "@chartwarden/db";
import {
  LEGAL_VISIT_PAIRING_KEYS,
  PAIRING_OPEN_STATUSES,
  type PairingReviewReason,
  type SchedulingDiscipline,
  classifyVisitPairing,
  isLegalVisitPairing,
  legalDisciplinesForPurpose,
} from "@chartwarden/scheduling";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { VisitPurpose } from "@chartwarden/types";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { createDrizzleCredentialStore } from "./seams/credentials-drizzle-store";
import { ALL_SCHEDULING_DISCIPLINES, heldSchedulingDisciplines } from "./visit-held-disciplines";

const V = schema.visit;
const MEMBERSHIP = schema.memberships;

export const PAIRING_RECONCILED_AUDIT_EVENT = "m17.visit.pairing_reconciled";
export const PAIRING_RESTAMP_REASON = "RESTAMP_SINGLE_LEGAL_DISCIPLINE";

/** A stored discipline as a safe code: a legacy free-text value is never echoed into a report or audit row. */
function safeCode(value: string): string {
  return /^[a-z_]{1,24}$/.test(value) ? value : "unrecognised";
}

export interface PairingFinding {
  readonly visitId: string;
  readonly purpose: string;
  readonly stampedDiscipline: string;
}

export interface PlannedRestamp extends PairingFinding {
  readonly toDiscipline: SchedulingDiscipline;
  /** `proposed` or `published`: a published visit may already have an M8 draft that this does not change. */
  readonly status: string;
  /** The planned-from state the UPDATE is guarded on. */
  readonly serviceDate: string;
  readonly version: number;
  readonly rawStampedDiscipline: string;
}

export interface ReviewItem extends PairingFinding {
  readonly reason: PairingReviewReason;
}

export interface OrgPairingPlan {
  readonly organizationId: string;
  readonly restamp: readonly PlannedRestamp[];
  readonly review: readonly ReviewItem[];
  readonly historical: readonly PairingFinding[];
}

export interface OrgPairingReport {
  readonly organizationId: string;
  readonly affected: number;
  readonly counts: {
    readonly restamp: number;
    readonly review: number;
    readonly historical: number;
  };
  readonly restamp: readonly (PairingFinding & {
    readonly toDiscipline: SchedulingDiscipline;
    readonly status: string;
  })[];
  readonly review: readonly ReviewItem[];
  readonly historical: readonly PairingFinding[];
}

/** The operator-facing projection of a plan: ids and codes, never the guard values. */
export function pairingReport(plan: OrgPairingPlan): OrgPairingReport {
  return {
    organizationId: plan.organizationId,
    affected: plan.restamp.length + plan.review.length + plan.historical.length,
    counts: {
      restamp: plan.restamp.length,
      review: plan.review.length,
      historical: plan.historical.length,
    },
    restamp: plan.restamp.map((r) => ({
      visitId: r.visitId,
      purpose: r.purpose,
      stampedDiscipline: r.stampedDiscipline,
      toDiscipline: r.toDiscipline,
      status: r.status,
    })),
    review: plan.review,
    historical: plan.historical,
  };
}

interface AffectedRow {
  readonly id: string;
  readonly serviceDate: string;
  readonly status: string;
  readonly visitPurpose: VisitPurpose;
  readonly stamped: string;
  readonly membershipId: string;
  readonly version: number;
}

const isOpen = (status: string): boolean =>
  (PAIRING_OPEN_STATUSES as readonly string[]).includes(status);

/** The visits whose stamped pair is not legal today, in one tenant transaction. */
async function selectIllegalPairs(tx: DbClient, organizationId: string): Promise<AffectedRow[]> {
  const pairKey = sql<string>`${V.visitPurpose}::text || ':' || ${V.assignedDisciplineAtAssignment}`;
  const rows = await tx
    .select({
      id: V.id,
      serviceDate: V.serviceDate,
      status: V.status,
      visitPurpose: V.visitPurpose,
      stamped: V.assignedDisciplineAtAssignment,
      membershipId: V.assignedMembershipId,
      version: V.version,
    })
    .from(V)
    .where(
      and(eq(V.organizationId, organizationId), notInArray(pairKey, [...LEGAL_VISIT_PAIRING_KEYS])),
    )
    .orderBy(V.id);
  return rows.map((r) => ({ ...r, visitPurpose: r.visitPurpose as VisitPurpose }));
}

/** Read-only, in one tenant transaction: the illegal-pair visits and what their open assignees hold. */
async function readAffected(db: DbClient, organizationId: string) {
  return withOrgContext(db, systemOrgContext(organizationId), async (txRaw) => {
    const tx = txRaw as DbClient;
    const rows = await selectIllegalPairs(tx, organizationId);
    const assignees = [...new Set(rows.filter((r) => isOpen(r.status)).map((r) => r.membershipId))];
    const held = new Map<string, readonly SchedulingDiscipline[]>();
    for (const membershipId of assignees) {
      held.set(membershipId, await heldSchedulingDisciplines(tx, organizationId, membershipId));
    }
    const active =
      assignees.length === 0
        ? []
        : await tx
            .select({ id: MEMBERSHIP.id })
            .from(MEMBERSHIP)
            .where(
              and(
                eq(MEMBERSHIP.organizationId, organizationId),
                eq(MEMBERSHIP.status, "active"),
                inArray(MEMBERSHIP.id, assignees),
              ),
            );
    return { rows, held, activeAssignees: new Set(active.map((m) => m.id)) };
  });
}

/** Active credential disciplines on a date, cached per (assignee, date); each read opens its own tenant tx. */
function credentialLookup(db: DbClient, organizationId: string) {
  const store = createDrizzleCredentialStore(db);
  const cache = new Map<string, readonly SchedulingDiscipline[]>();
  return async (membershipId: string, serviceDate: string) => {
    const key = `${membershipId}|${serviceDate}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const active = await store.activeAsOf(organizationId, membershipId, serviceDate);
    const kinds = active
      .map((c) => c.kind)
      .filter((k): k is SchedulingDiscipline => ALL_SCHEDULING_DISCIPLINES.has(k));
    cache.set(key, kinds);
    return kinds;
  };
}

/**
 * The reconciliation plan for ONE tenant. Read-only. The credential reads open their own tenant transaction, so
 * they run after the read transaction has closed.
 */
export async function planVisitPairingsForOrg(
  db: DbClient,
  organizationId: string,
): Promise<OrgPairingPlan> {
  const { rows, held, activeAssignees } = await readAffected(db, organizationId);
  const credentialedOn = credentialLookup(db, organizationId);
  const restamp: PlannedRestamp[] = [];
  const review: ReviewItem[] = [];
  const historical: PairingFinding[] = [];
  for (const row of rows) {
    const heldDisciplines = held.get(row.membershipId) ?? [];
    const legal = legalDisciplinesForPurpose(row.visitPurpose);
    const assigneeActive = activeAssignees.has(row.membershipId);
    const needsCredentials =
      isOpen(row.status) && assigneeActive && heldDisciplines.some((d) => legal.includes(d));
    const verdict = classifyVisitPairing({
      status: row.status,
      purpose: row.visitPurpose,
      stampedDiscipline: row.stamped,
      assigneeActive,
      heldDisciplines,
      credentialedDisciplines: needsCredentials
        ? await credentialedOn(row.membershipId, row.serviceDate)
        : [],
    });
    const finding = {
      visitId: row.id,
      purpose: row.visitPurpose,
      stampedDiscipline: safeCode(row.stamped),
    };
    if (verdict.kind === "restamp") {
      restamp.push({
        ...finding,
        toDiscipline: verdict.toDiscipline,
        status: row.status,
        serviceDate: row.serviceDate,
        version: row.version,
        rawStampedDiscipline: row.stamped,
      });
    } else if (verdict.kind === "review") {
      review.push({ ...finding, reason: verdict.reason });
    } else if (verdict.kind === "historical") {
      historical.push(finding);
    }
  }
  return { organizationId, restamp, review, historical };
}

/** Thrown, before any write, when a tenant's plan is bigger than the rows the run may still change. */
export class PairingPlanTooLargeError extends Error {
  constructor(
    readonly organizationId: string,
    readonly planned: number,
    readonly maxRows: number,
  ) {
    super(
      `visit pairing plan for organization ${organizationId} changes ${planned} visit(s), more than the ${maxRows} allowed; nothing was written`,
    );
    this.name = "PairingPlanTooLargeError";
  }
}

export interface ApplyOptions {
  /** The most rows this tenant's apply may change; a bigger plan is refused whole. */
  readonly maxRows: number;
  /** Stitches the audit rows of one run together. */
  readonly runId: string;
  /** A short operator label (slug), recorded in the audit context. */
  readonly operator: string;
}

export interface OrgApplyResult {
  readonly organizationId: string;
  readonly changed: readonly string[];
  /** Visits that changed after the plan was read (status, version or stamp): left alone. */
  readonly skippedStale: readonly string[];
}

/** One guarded UPDATE plus its audit event, in the caller's transaction. False when the row is no longer as planned. */
async function restampOne(
  tx: DbClient,
  organizationId: string,
  item: PlannedRestamp,
  options: ApplyOptions,
): Promise<boolean> {
  // Defence in depth: the target must still be a legal discipline for the purpose, whatever the plan says.
  if (!isLegalVisitPairing(item.purpose as VisitPurpose, item.toDiscipline)) return false;
  const updated = await tx
    .update(V)
    .set({
      assignedDisciplineAtAssignment: item.toDiscipline,
      version: sql`${V.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(V.organizationId, organizationId),
        eq(V.id, item.visitId),
        eq(V.serviceDate, item.serviceDate),
        eq(V.version, item.version),
        eq(V.assignedDisciplineAtAssignment, item.rawStampedDiscipline),
        inArray(V.status, [...PAIRING_OPEN_STATUSES]),
      ),
    )
    .returning({ id: V.id });
  if (updated.length === 0) return false;
  await audit(
    tx,
    {
      organizationId,
      userId: null,
      actorKind: "system",
      actorRole: "m17.pairing-reconcile",
      correlationId: options.runId,
    },
    {
      eventType: PAIRING_RECONCILED_AUDIT_EVENT,
      resourceKind: "visit",
      resourceId: item.visitId,
      outcome: "success",
      severity: "warn",
      before: { assignedDisciplineAtAssignment: item.stampedDiscipline },
      after: { assignedDisciplineAtAssignment: item.toDiscipline },
      context: {
        control: "CW-PI-04",
        reason: PAIRING_RESTAMP_REASON,
        visitPurpose: item.purpose,
        visitStatus: item.status,
        runId: options.runId,
        operator: options.operator,
      },
    },
  );
  return true;
}

/**
 * Apply ONE tenant's restamps (see the file header). One transaction, one audit event per changed visit.
 * Pass the plan from {@link planVisitPairingsForOrg}; a stale entry is skipped, never forced.
 */
export async function applyVisitPairingRestampsForOrg(
  db: DbClient,
  plan: OrgPairingPlan,
  options: ApplyOptions,
): Promise<OrgApplyResult> {
  const { organizationId } = plan;
  if (plan.restamp.length > options.maxRows) {
    throw new PairingPlanTooLargeError(organizationId, plan.restamp.length, options.maxRows);
  }
  return withOrgContext(db, systemOrgContext(organizationId), async (txRaw) => {
    const tx = txRaw as DbClient;
    const changed: string[] = [];
    const skippedStale: string[] = [];
    for (const item of plan.restamp) {
      const done = await restampOne(tx, organizationId, item, options);
      (done ? changed : skippedStale).push(item.visitId);
    }
    return { organizationId, changed, skippedStale };
  });
}
