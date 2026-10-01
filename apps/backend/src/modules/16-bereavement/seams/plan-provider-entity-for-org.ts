// apps/backend/src/modules/16-bereavement/seams/plan-provider-entity-for-org.ts — F-160-follow-up (#248).
//
// An org-explicit, worker-callable read of ONE `bereavement_plan`'s provider-entity id, keyed by planId.
// Mirrors `06-admission/seams/drizzle-store.ts`'s `admissionSchedulingContextForOrg` /
// `electionPeriodContextForOrg` shape exactly, and for the same reason: M16's published §4.6
// `BereavementPlanProvider.planById` seam (`../seams/store.ts` / `../seams/drizzle-store.ts`) opens
// `withOrgContextFromRequest`, which pins `app.org_id` from the CONSUMER'S ambient HTTP request context —
// a relay tick delivering an outbox event has no such context, so that seam cannot be called from an M30
// outbox consumer. This is a NEW, narrow, org-explicit sibling read, not a widening of the published seam.
//
// WHY THIS IS NEEDED: `m16.bereavement.plan_closed_completed` / `.plan_closed_declined` / `.plan_closed_early`
// carry only `{planId, ...}` on the wire (no `providerEntityId`) — the fact `measure_recompute_queue
// .provider_entity_id` (NOT NULL) requires before M30 can enqueue a `bereavement_coverage_rate` recompute
// off one of these events (see `../../30-quality/outbox-consumers/m16-plan-closed.ts`).
//
// Cross-module import precedent: `admissionSchedulingContextForOrg` is imported directly (not through the
// M1 seam registry) by consumers in M10/M13/M15/M16/M23/M25/M26 today — an org-explicit "…ForOrg" read
// function exported from a module's own `seams/` directory is itself the seam surface for a background
// consumer, the same as a registered `getSeam(...)` accessor, and dependency-cruiser's M30 rule ("seam
// packages only, no schema-table imports across boundaries") is satisfied because this file — not the raw
// `bereavement_plan` Drizzle table — is what M30's consumer imports.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";

const PLAN = schema.bereavementPlan;
const CONTACT = schema.bereavedContact;

/** A consumer-driven read names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const PLAN_READER_SYSTEM_USER_ID = "";

/** The one fact a background M16-plan-closure consumer needs beyond what the event payload already
 *  carries. Deliberately minimal — not the full `BereavementPlanFacts` the request-scoped seam returns. */
export interface BereavementPlanSitingForOrg {
  readonly planId: string;
  readonly providerEntityId: string;
}

/**
 * One bereavement plan's provider-entity siting, org-explicit and worker-callable. `null` when the id is
 * unknown in `organizationId` — indistinguishable from another tenant's, which is the point (the same
 * `admissionSchedulingContextForOrg` null-on-miss contract).
 */
export function bereavementPlanSitingForOrg(
  db: DbClient,
  organizationId: string,
  planId: string,
): Promise<BereavementPlanSitingForOrg | null> {
  return withOrgContext(db, { organizationId, userId: PLAN_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx
      .select({ id: PLAN.id, providerEntityId: PLAN.providerEntityId })
      .from(PLAN)
      // The explicit organization_id predicate is the second wall behind RLS (the M6 precedent), so a
      // misconfigured GUC cannot widen this read.
      .where(and(eq(PLAN.organizationId, organizationId), eq(PLAN.id, planId)))
      .limit(1);
    if (!row) return null;
    return { planId: row.id, providerEntityId: row.providerEntityId };
  });
}

// F-165 (#248) — the `arch:tables` fix for M31's `m16.bereavement.plan_opened` consumer, which had
// imported `schema.bereavedContact` directly (M31's `dependsOn` carries no edge to 16 regardless). Same
// shape as `bereavementPlanSitingForOrg` above: an org-explicit, worker-callable read exported from M16's
// own `seams/` directory rather than a raw cross-module Drizzle import.

/** One already-confirmed bereaved contact on a plan, as an M31 consumer needs it to resolve a candidate
 *  portal-scope flip: the linked portal account and the exact consent record backing its `active` status. */
export interface BereavedContactFlipCandidate {
  readonly portalAccountId: string;
  readonly consentRecordId: string;
}

/**
 * Every `active`-status `bereaved_contact` on one plan that also carries a linked portal account and
 * consent record — the exact candidate set `planBereavedFlip` needs, org-explicit and worker-callable
 * (mirrors `bereavementPlanSitingForOrg`'s null-on-miss / RLS-plus-explicit-predicate shape).
 */
export function bereavedContactFlipCandidatesForPlanForOrg(
  db: DbClient,
  organizationId: string,
  planId: string,
): Promise<readonly BereavedContactFlipCandidate[]> {
  return withOrgContext(db, { organizationId, userId: PLAN_READER_SYSTEM_USER_ID }, async (tx) => {
    const rows = await tx
      .select({
        portalAccountId: CONTACT.portalAccountId,
        consentRecordId: CONTACT.consentRecordId,
      })
      .from(CONTACT)
      .where(
        and(
          eq(CONTACT.organizationId, organizationId),
          eq(CONTACT.planId, planId),
          eq(CONTACT.status, "active"),
        ),
      );
    return rows.filter(
      (r): r is BereavedContactFlipCandidate =>
        r.portalAccountId !== null && r.consentRecordId !== null,
    );
  });
}

// F-167 (#248) — the `m16.bereavement.contact_active` M31 consumer's read. Single-contact sibling of
// `bereavedContactFlipCandidatesForPlanForOrg` above (same null-on-miss / status='active' filter, same
// RLS-plus-explicit-predicate shape), keyed by `contactId` instead of scanning a whole plan — the event
// fires per-contact and this is the fact it needs, re-read fresh (never trusted off the payload) so a
// contact that has since left `active` (opted out, deceased) between publish and delivery is honestly a
// no-op rather than acting on stale payload state.

/** One already-confirmed bereaved contact, as the `contact_active` consumer needs it — widens the plan
 *  candidate shape with `planId` since this read is keyed by contact rather than scoped to one plan. */
export interface BereavedContactFlipCandidateByContact extends BereavedContactFlipCandidate {
  readonly planId: string;
}

/**
 * The current state of ONE `bereaved_contact`, org-explicit and worker-callable — `null` when the id is
 * unknown in `organizationId`, not currently `active`, or missing a linked portal account / consent
 * record (the exact candidacy `planBereavedFlip` needs).
 */
export function bereavedContactFlipCandidateForOrg(
  db: DbClient,
  organizationId: string,
  contactId: string,
): Promise<BereavedContactFlipCandidateByContact | null> {
  return withOrgContext(db, { organizationId, userId: PLAN_READER_SYSTEM_USER_ID }, async (tx) => {
    const [row] = await tx
      .select({
        planId: CONTACT.planId,
        portalAccountId: CONTACT.portalAccountId,
        consentRecordId: CONTACT.consentRecordId,
      })
      .from(CONTACT)
      .where(
        and(
          eq(CONTACT.organizationId, organizationId),
          eq(CONTACT.id, contactId),
          eq(CONTACT.status, "active"),
        ),
      )
      .limit(1);
    if (!row || row.portalAccountId === null || row.consentRecordId === null) return null;
    return {
      planId: row.planId,
      portalAccountId: row.portalAccountId,
      consentRecordId: row.consentRecordId,
    };
  });
}
