// apps/backend/src/modules/07-care-plan/change-proposals-db.ts — WF09: the plan-of-care CHANGE PROPOSALS a visit records, over Drizzle + RLS.
//
// The flow the user chose — propose, then accept: while a visit note is being written the clinician records the plan changes it calls for as
// DRAFT proposals (create / replace / withdraw: the proposer's alone). The visit's finalization RELEASES them (`releaseForEncounter`, called by
// the `m8.encounter.finalized` consumer), which makes them `pending` on the plan's review list. The case manager or a supervisor then ACCEPTS
// (the change is applied through the very service operation the manual Care Plans route runs, ./change-proposals-apply.ts) or DISMISSES.
// A visit never edits the signed plan directly (42 CFR 418.56: the IDG revises it); a proposal is not a problem / goal / intervention, so
// nothing that reads the plan can see it.
//
// §7.6 Part 2: a proposal carries `sud_related` (copied from the problem it touches, or flagged on a new problem). A caller without
// disclosure cannot create one against such an element (404, as for a hidden problem), never lists one, and gets the non-leaking 404 on it.
// A problem proposal's goals / interventions carry its flag, so replacing the problem re-flags them with it.
//
// The visit a proposal is recorded in is checked, not trusted (./change-proposals-visit.ts): a draft can only be bound to the caller's own,
// still-open note for the plan's patient. That check calls M8's seam, which opens its own tenant context, so it runs BEFORE the transaction.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  type EncounterDraftReader,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { type CarePlanWriteOutboxPort, ensurePlanWritable } from "./care-plan-route-service-db";
import { type AppliedElement, type ProposalDecider, applyProposal } from "./change-proposals-apply";
import {
  type ChangeProposalRow,
  listForPatient,
  listForPlan,
  viewsOf,
} from "./change-proposals-read";
import { type ChangeColumns, assertChangeConsistent, columnsOf } from "./change-proposals-rules";
import {
  assertOwnDraftVisit,
  seamEncounterDraftReader,
  settlementOf,
} from "./change-proposals-visit";
import type {
  CarePlanChangeProposalView,
  ChangeProposalChange,
  ChangeProposalPlanListQuery,
  CreateChangeProposalInput,
} from "./routes/change-proposal-typebox";
import { MAX_PROPOSALS_PER_ENCOUNTER } from "./routes/change-proposal-typebox";
import { ensureNoVersionInReview } from "./version-in-review-guard";

const CPCP = schema.carePlanChangeProposals;
const CP = schema.carePlans;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;

type PlanRow = typeof CP.$inferSelect;
type ProposalStatus = ChangeProposalRow["status"];

/** The acting clinician, route-resolved from the session (never the body). */
export interface ProposalCaller {
  readonly userId: string;
  readonly membershipId: string;
  /** §7.6 — may this caller see Part 2 content for the plan's patient? */
  readonly sudDisclosureAllowed: boolean;
}
export type ProposalAcceptor = ProposalCaller & ProposalDecider;

/** A visit's release: its patient is required, so a release can never reach another patient's drafts under the same visit id. */
export interface EncounterReleaseScope {
  readonly patientId: string;
}

export interface ChangeProposalServiceOptions {
  /** M8's visit facts; defaults to the `EncounterDraftReader` seam (fail-closed deny-stub until M8 registers it). */
  readonly visits?: EncounterDraftReader;
}

export interface CarePlanChangeProposalService {
  create(
    org: string,
    planId: string,
    input: CreateChangeProposalInput,
    caller: ProposalCaller,
  ): Promise<CarePlanChangeProposalView>;
  replace(
    org: string,
    planId: string,
    proposalId: string,
    change: ChangeProposalChange,
    caller: ProposalCaller,
  ): Promise<CarePlanChangeProposalView>;
  withdraw(
    org: string,
    planId: string,
    proposalId: string,
    caller: ProposalCaller,
  ): Promise<{ proposalId: string; status: "withdrawn" }>;
  listForPlan(
    org: string,
    planId: string,
    opts: { status?: ChangeProposalPlanListQuery["status"]; sudDisclosureAllowed: boolean },
  ): Promise<{ patientId: string; proposals: CarePlanChangeProposalView[]; redacted: boolean }>;
  listForPatient(
    org: string,
    patientId: string,
    opts: {
      sourceEncounterId?: string;
      status?: ProposalStatus;
      membershipId: string | null;
      sudDisclosureAllowed: boolean;
    },
  ): Promise<{ patientId: string; proposals: CarePlanChangeProposalView[]; redacted: boolean }>;
  accept(
    org: string,
    planId: string,
    proposalId: string,
    acceptor: ProposalAcceptor,
  ): Promise<{
    proposalId: string;
    status: "accepted";
    resultElementType: AppliedElement["type"];
    resultElementId: string;
    decidedAt: string;
  }>;
  dismiss(
    org: string,
    planId: string,
    proposalId: string,
    body: { readonly reason?: ChangeProposalRow["dismissalReason"] },
    decider: ProposalCaller,
  ): Promise<{
    proposalId: string;
    status: "dismissed";
    decidedAt: string;
    dismissalReason: ChangeProposalRow["dismissalReason"];
  }>;
  /** `draft` → `pending` for one visit's proposals of one patient (the visit was finalized). Returns how many were released. */
  releaseForEncounter(
    org: string,
    encounterId: string,
    scope: EncounterReleaseScope,
  ): Promise<number>;
  /** `draft` → `withdrawn` for one visit's proposals (the visit was voided). Returns how many were withdrawn. */
  withdrawForEncounter(org: string, encounterId: string): Promise<number>;
}

const notFound = (id: string): NotFoundError => new NotFoundError("care_plan_change_proposal", id);
const conflict = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 409);
const invalidParent = (message: string): ValidationError =>
  new ValidationError(message, [{ field: "parentProposalId", code: "INVALID", message }]);
/** Only a draft can still be changed or discarded by its proposer. */
function assertDraft(row: ChangeProposalRow, verb: string): void {
  if (row.status !== "draft") {
    throw conflict("PROPOSAL_NOT_DRAFT", `only a draft can be ${verb}; this one is ${row.status}`);
  }
}

export function createDbChangeProposalService(
  db: DbClient,
  outbox: CarePlanWriteOutboxPort = { async publish() {} },
  options: ChangeProposalServiceOptions = {},
): CarePlanChangeProposalService {
  const visits = options.visits ?? seamEncounterDraftReader;
  const inOrg = <T>(org: string, userId: string, fn: (t: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(db, { organizationId: org, userId }, (tx) => fn(tx as unknown as DbClient));

  async function loadPlan(t: DbClient, planId: string): Promise<PlanRow> {
    const [plan] = await t.select().from(CP).where(eq(CP.id, planId)).limit(1);
    if (!plan) throw new NotFoundError("care_plan", planId);
    return plan;
  }

  /** One proposal of this plan. Absent, or hidden from this caller by §7.6, is the non-leaking 404. */
  async function findProposal(
    t: DbClient,
    planId: string,
    proposalId: string,
    sudDisclosureAllowed: boolean,
    lock: boolean,
  ): Promise<ChangeProposalRow> {
    const query = t
      .select()
      .from(CPCP)
      .where(and(eq(CPCP.id, proposalId), eq(CPCP.carePlanId, planId)));
    const [row] = await (lock ? query.for("update") : query);
    if (!row || (row.sudRelated && !sudDisclosureAllowed)) throw notFound(proposalId);
    return row;
  }
  const lockProposal = (t: DbClient, planId: string, proposalId: string, sud: boolean) =>
    findProposal(t, planId, proposalId, sud, true);
  /** A draft is its proposer's alone: anyone else sees nothing at all. */
  async function ownProposal(
    t: DbClient,
    planId: string,
    proposalId: string,
    caller: ProposalCaller,
    lock: boolean,
  ): Promise<ChangeProposalRow> {
    const row = await findProposal(t, planId, proposalId, caller.sudDisclosureAllowed, lock);
    if (row.proposedByMembershipId !== caller.membershipId) throw notFound(proposalId);
    return row;
  }

  /**
   * The seam check, done outside any transaction: the plan is open and the visit is the caller's own note for the plan's patient, still being
   * written. The transaction that follows loads the plan again, so a discharge in between is still refused.
   */
  async function assertVisitAllowsDraft(
    org: string,
    plan: PlanRow,
    encounterId: string,
    caller: ProposalCaller,
  ): Promise<void> {
    ensurePlanWritable(plan);
    await assertOwnDraftVisit(visits, {
      organizationId: org,
      encounterId,
      patientId: plan.patientId,
      membershipId: caller.membershipId,
    });
  }

  /** The problem behind an element, or 404 for one the caller may not see (Part 2) — the manual routes' redaction. */
  async function problemSud(
    t: DbClient,
    planId: string,
    problemId: string,
    caller: ProposalCaller,
    resource: string,
    /** The id the 404 names: always the one the caller SENT (a goal's id, never the Part 2 problem behind it). */
    reportedId: string = problemId,
  ): Promise<boolean> {
    const [problem] = await t
      .select({ sudRelated: PROB.sudRelated })
      .from(PROB)
      .where(and(eq(PROB.id, problemId), eq(PROB.carePlanId, planId)))
      .limit(1);
    if (!problem || (problem.sudRelated && !caller.sudDisclosureAllowed)) {
      throw new NotFoundError(resource, reportedId);
    }
    return problem.sudRelated;
  }

  /** The problem / goal / intervention a resolve / update / discontinue targets, 404 as the manual routes answer; its problem's Part 2 flag. */
  async function targetElementSud(
    t: DbClient,
    planId: string,
    cols: ChangeColumns,
    caller: ProposalCaller,
  ): Promise<boolean> {
    const id = cols.targetElementId as string;
    if (cols.kind === "problem_resolve") return problemSud(t, planId, id, caller, "problem");
    const isGoal = cols.kind === "goal_update";
    const [element] = isGoal
      ? await t
          .select({ problemId: GOAL.problemId })
          .from(GOAL)
          .where(and(eq(GOAL.id, id), eq(GOAL.carePlanId, planId)))
          .limit(1)
      : await t
          .select({ problemId: INTV.problemId })
          .from(INTV)
          .where(and(eq(INTV.id, id), eq(INTV.carePlanId, planId)))
          .limit(1);
    const resource = isGoal ? "goal" : "intervention";
    if (!element) throw new NotFoundError(resource, id);
    // The element answers 404 exactly as a Part 2 problem's does: its existence is the disclosure.
    return problemSud(t, planId, element.problemId, caller, resource, id);
  }

  /**
   * Every goal a goal / intervention proposal links must be on THIS plan (a foreign key bypasses RLS, so another tenant's uuid would pass),
   * and a goal under a Part 2 problem is as absent to a caller without disclosure as the problem itself: the same 404 as a missing goal, so
   * the answer is not an existence oracle for a hidden goal. Returns whether any linked goal is Part 2 (the caller may see it): a proposal that
   * links one is itself Part 2, whatever problem it touches.
   */
  async function assertGoalRefsOnPlan(
    t: DbClient,
    planId: string,
    goalRefs: readonly string[],
    caller: ProposalCaller,
  ): Promise<boolean> {
    if (goalRefs.length === 0) return false;
    const found = await t
      .select({ id: GOAL.id, sudRelated: PROB.sudRelated })
      .from(GOAL)
      .innerJoin(PROB, and(eq(PROB.id, GOAL.problemId), eq(PROB.carePlanId, GOAL.carePlanId)))
      .where(and(eq(GOAL.carePlanId, planId), inArray(GOAL.id, [...goalRefs])));
    const missing = goalRefs.find((id) => {
      const goal = found.find((g) => g.id === id);
      return !goal || (goal.sudRelated && !caller.sudDisclosureAllowed);
    });
    if (missing) throw new NotFoundError("goal", missing);
    return found.some((g) => g.sudRelated);
  }

  /** The problem proposal a new goal / intervention hangs off: a live one of the same visit, visible to the caller. Its Part 2 flag. */
  async function parentProposalSud(
    t: DbClient,
    planId: string,
    parentId: string,
    sourceEncounterId: string,
    caller: ProposalCaller,
  ): Promise<boolean> {
    const [parent] = await t
      .select()
      .from(CPCP)
      .where(and(eq(CPCP.id, parentId), eq(CPCP.carePlanId, planId)))
      .limit(1);
    const visible =
      parent &&
      (parent.status !== "draft" || parent.proposedByMembershipId === caller.membershipId) &&
      (!parent.sudRelated || caller.sudDisclosureAllowed);
    if (!visible) throw notFound(parentId);
    if (
      parent.kind !== "problem_add" ||
      parent.sourceEncounterId !== sourceEncounterId ||
      (parent.status !== "draft" && parent.status !== "pending")
    ) {
      throw invalidParent("parentProposalId must be a live problem proposal of this visit");
    }
    return parent.sudRelated;
  }

  /**
   * Check every id the change points at belongs to THIS plan and return the Part 2 flag the proposal carries: the proposer's own for a new
   * problem, otherwise the touched problem's.
   */
  async function resolveReferences(
    t: DbClient,
    planId: string,
    cols: ChangeColumns,
    sourceEncounterId: string,
    caller: ProposalCaller,
  ): Promise<boolean> {
    switch (cols.kind) {
      case "problem_add":
        return cols.sudRelated === true;
      case "problem_resolve":
      case "goal_update":
      case "intervention_discontinue":
        return targetElementSud(t, planId, cols, caller);
      case "goal_add":
      case "intervention_add": {
        // An existing problem, or a problem proposal of the same visit.
        const linksPart2Goal = await assertGoalRefsOnPlan(t, planId, cols.goalRefs, caller);
        const touchesPart2Problem = cols.problemId
          ? await problemSud(t, planId, cols.problemId, caller, "problem")
          : await parentProposalSud(
              t,
              planId,
              cols.parentProposalId as string,
              sourceEncounterId,
              caller,
            );
        return linksPart2Goal || touchesPart2Problem;
      }
    }
  }

  /** A visit's live proposals by one proposer on one plan are capped: another clinician's drafts never fill the author's room. */
  async function assertRoom(
    t: DbClient,
    planId: string,
    membershipId: string,
    sourceEncounterId: string,
  ): Promise<void> {
    const [live] = await t
      .select({ n: sql<number>`count(*)::int` })
      .from(CPCP)
      .where(
        and(
          eq(CPCP.carePlanId, planId),
          eq(CPCP.proposedByMembershipId, membershipId),
          eq(CPCP.sourceEncounterId, sourceEncounterId),
          inArray(CPCP.status, ["draft", "pending"]),
        ),
      );
    if (Number(live?.n ?? 0) >= MAX_PROPOSALS_PER_ENCOUNTER) {
      throw conflict(
        "TOO_MANY_PROPOSALS",
        `a visit may carry at most ${MAX_PROPOSALS_PER_ENCOUNTER} proposed plan changes`,
      );
    }
  }

  /** Withdraw the still-draft goals / interventions hanging off a problem proposal that is going away. */
  async function withdrawDraftChildren(t: DbClient, parentId: string): Promise<void> {
    await t
      .update(CPCP)
      .set({ status: "withdrawn", updatedAt: new Date() })
      .where(and(eq(CPCP.parentProposalId, parentId), eq(CPCP.status, "draft")));
  }

  /** One visit's still-draft proposals, moved on together (the visit's lifecycle events). Only drafts: a decided proposal is never touched. */
  async function transitionDrafts(
    org: string,
    encounterId: string,
    patientId: string | undefined,
    set: Partial<typeof CPCP.$inferInsert>,
  ): Promise<number> {
    return withOrgContext(db, systemOrgContext(org), async (tx) => {
      const moved = await (tx as unknown as DbClient)
        .update(CPCP)
        .set(set)
        .where(
          and(
            eq(CPCP.sourceEncounterId, encounterId),
            eq(CPCP.status, "draft"),
            patientId ? eq(CPCP.patientId, patientId) : undefined,
          ),
        )
        .returning({ id: CPCP.id });
      return moved.length;
    });
  }

  /**
   * A visit can be finalized or voided in the gap between the seam check (before the transaction) and the commit: the lifecycle consumer
   * would then already have run and found no draft to move, leaving this one a draft of a closed note for ever. So once committed the visit
   * is asked again, and the draft makes the move the consumer would have made (`draft` → `pending`, or `withdrawn`). A draft already moved by
   * the consumer is left alone and reported as it now is. Safe on an idempotent replay: the response is what the row is.
   */
  async function settleAfterCommit(
    org: string,
    view: CarePlanChangeProposalView,
    caller: ProposalCaller,
  ): Promise<CarePlanChangeProposalView> {
    const facts = await visits.draftOf({
      organizationId: org,
      encounterId: view.sourceEncounterId,
    });
    const settlement = settlementOf(facts?.status);
    if (!settlement) return view;
    return inOrg(org, caller.userId, async (t) => {
      const now = new Date();
      const [moved] = await t
        .update(CPCP)
        .set(
          settlement === "release"
            ? { status: "pending", releasedAt: now, updatedAt: now }
            : { status: "withdrawn", updatedAt: now },
        )
        .where(and(eq(CPCP.id, view.id), eq(CPCP.status, "draft")))
        .returning();
      const current = moved ?? (await findProposal(t, view.carePlanId, view.id, true, false));
      return (
        await viewsOf(t, org, [current], caller.sudDisclosureAllowed)
      )[0] as CarePlanChangeProposalView;
    });
  }

  return {
    async create(org, planId, input, caller) {
      const { sourceEncounterId, ...change } = input;
      assertChangeConsistent(change as ChangeProposalChange);
      const cols = columnsOf(change as ChangeProposalChange);
      const checked = await inOrg(org, caller.userId, (t) => loadPlan(t, planId));
      await assertVisitAllowsDraft(org, checked, sourceEncounterId, caller);
      const created = await inOrg(org, caller.userId, async (t) => {
        const plan = await loadPlan(t, planId);
        ensurePlanWritable(plan);
        if (plan.patientId !== checked.patientId) throw new NotFoundError("care_plan", planId);
        // The cap is a count, then an insert: two creates racing it would both read 49. A transaction-scoped advisory lock on (plan,
        // proposer, visit) serialises them, so the second counts the first.
        await t.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m7-change-proposal:${planId}:${caller.membershipId}:${sourceEncounterId}`}, 0))`,
        );
        await assertRoom(t, planId, caller.membershipId, sourceEncounterId);
        const sudRelated = await resolveReferences(t, planId, cols, sourceEncounterId, caller);
        const [row] = await t
          .insert(CPCP)
          .values({
            ...cols,
            sudRelated,
            organizationId: org,
            providerEntityId: plan.providerEntityId,
            locationId: plan.locationId,
            carePlanId: planId,
            patientId: plan.patientId,
            sourceEncounterId,
            status: "draft",
            proposedByMembershipId: caller.membershipId,
          })
          .returning();
        if (!row) throw new Error("care_plan_change_proposal insert returned no row");
        return (
          await viewsOf(t, org, [row], caller.sudDisclosureAllowed)
        )[0] as CarePlanChangeProposalView;
      });
      return settleAfterCommit(org, created, caller);
    },

    async replace(org, planId, proposalId, change, caller) {
      assertChangeConsistent(change);
      const cols = columnsOf(change);
      if (cols.parentProposalId === proposalId) {
        throw invalidParent("a proposal cannot hang off itself");
      }
      // The draft's own visit, read without a lock so the seam check can run outside the transaction that follows.
      const { peek, checked } = await inOrg(org, caller.userId, async (t) => ({
        peek: await ownProposal(t, planId, proposalId, caller, false),
        checked: await loadPlan(t, planId),
      }));
      assertDraft(peek, "replaced");
      await assertVisitAllowsDraft(org, checked, peek.sourceEncounterId, caller);
      const replaced = await inOrg(org, caller.userId, async (t) => {
        const row = await ownProposal(t, planId, proposalId, caller, true);
        assertDraft(row, "replaced");
        ensurePlanWritable(await loadPlan(t, planId));
        if (row.kind === "problem_add" && cols.kind !== "problem_add") {
          const [child] = await t
            .select({ id: CPCP.id })
            .from(CPCP)
            .where(and(eq(CPCP.parentProposalId, proposalId), eq(CPCP.status, "draft")))
            .limit(1);
          if (child) {
            throw conflict(
              "PROPOSAL_HAS_DEPENDENTS",
              "goals or interventions of this visit hang off this problem: withdraw them first",
            );
          }
        }
        const sudRelated = await resolveReferences(t, planId, cols, row.sourceEncounterId, caller);
        const [updated] = await t
          .update(CPCP)
          .set({ ...cols, sudRelated, updatedAt: new Date() })
          .where(and(eq(CPCP.id, proposalId), eq(CPCP.status, "draft")))
          .returning();
        if (!updated) throw conflict("PROPOSAL_NOT_DRAFT", "this proposal is no longer a draft");
        // The goals / interventions under a problem proposal carry its Part 2 flag: re-flagging the problem re-flags them, or a caller without
        // disclosure would see them (and the problem's text, as their target label) while the problem itself stays hidden. Only the still-draft
        // ones: a withdrawn row is final (migration 1532's guard), and a released one cannot sit under a draft problem.
        if (updated.kind === "problem_add") {
          await t
            .update(CPCP)
            .set({ sudRelated, updatedAt: new Date() })
            .where(
              and(
                eq(CPCP.parentProposalId, proposalId),
                eq(CPCP.status, "draft"),
                ne(CPCP.sudRelated, sudRelated),
              ),
            );
        }
        return (
          await viewsOf(t, org, [updated], caller.sudDisclosureAllowed)
        )[0] as CarePlanChangeProposalView;
      });
      return settleAfterCommit(org, replaced, caller);
    },

    async withdraw(org, planId, proposalId, caller) {
      return withOrgContext(db, { organizationId: org, userId: caller.userId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const row = await ownProposal(t, planId, proposalId, caller, true);
        if (row.status === "withdrawn") return { proposalId, status: "withdrawn" as const };
        assertDraft(row, "withdrawn");
        await t
          .update(CPCP)
          .set({ status: "withdrawn", updatedAt: new Date() })
          .where(eq(CPCP.id, proposalId));
        await withdrawDraftChildren(t, proposalId);
        return { proposalId, status: "withdrawn" as const };
      });
    },

    async listForPlan(org, planId, opts) {
      return withOrgContext(db, { organizationId: org, userId: "" }, (tx) =>
        listForPlan(tx as unknown as DbClient, org, planId, opts),
      );
    },

    async listForPatient(org, patientId, opts) {
      return withOrgContext(db, { organizationId: org, userId: "" }, (tx) =>
        listForPatient(tx as unknown as DbClient, org, patientId, opts),
      );
    },

    async accept(org, planId, proposalId, acceptor) {
      return withOrgContext(db, { organizationId: org, userId: acceptor.userId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const row = await lockProposal(t, planId, proposalId, acceptor.sudDisclosureAllowed);
        // A draft is not on the review list (a visit still being written) and a withdrawn one never was: neither exists for a decider.
        if (row.status === "draft" || row.status === "withdrawn") throw notFound(proposalId);
        if (row.status === "accepted") {
          // Idempotent: a second accept (a retry, a double click, two reviewers) reports the first result and writes nothing.
          return acceptedResult(row);
        }
        if (row.status !== "pending") {
          throw conflict("PROPOSAL_NOT_PENDING", `this proposed change was already ${row.status}`);
        }
        ensurePlanWritable(await loadPlan(t, planId));
        // A version in review is being signed as sealed: nothing may edit the plan under it. The 409 leaves the proposal pending.
        await ensureNoVersionInReview(t, planId);
        const applied = await applyProposal(t, outbox, org, planId, row, acceptor);
        // The service's own `withOrgContext` re-set the actor GUC for the rest of this transaction; the proposal's audit row names the acceptor.
        await t.execute(sql`SELECT set_config('app.user_id', ${acceptor.userId}, true)`);
        const [updated] = await t
          .update(CPCP)
          .set({
            status: "accepted",
            decidedByMembershipId: acceptor.membershipId,
            decidedAt: new Date(),
            resultElementId: applied.id,
            updatedAt: new Date(),
          })
          .where(and(eq(CPCP.id, proposalId), eq(CPCP.status, "pending")))
          .returning();
        if (!updated)
          throw conflict("PROPOSAL_NOT_PENDING", "this proposed change is no longer pending");
        return acceptedResult(updated);
      });
    },

    async dismiss(org, planId, proposalId, body, decider) {
      return withOrgContext(db, { organizationId: org, userId: decider.userId }, async (tx) => {
        const t = tx as unknown as DbClient;
        const row = await lockProposal(t, planId, proposalId, decider.sudDisclosureAllowed);
        if (row.status === "draft" || row.status === "withdrawn") throw notFound(proposalId);
        if (row.status === "dismissed") return dismissedResult(row);
        if (row.status !== "pending") {
          throw conflict("PROPOSAL_NOT_PENDING", `this proposed change was already ${row.status}`);
        }
        const decidedAt = new Date();
        const dismissal = {
          status: "dismissed",
          decidedByMembershipId: decider.membershipId,
          decidedAt,
          dismissalReason: body.reason ?? null,
          updatedAt: decidedAt,
        } as const;
        const [updated] = await t
          .update(CPCP)
          .set(dismissal)
          .where(and(eq(CPCP.id, proposalId), eq(CPCP.status, "pending")))
          .returning();
        if (!updated)
          throw conflict("PROPOSAL_NOT_PENDING", "this proposed change is no longer pending");
        // The goals / interventions of a dismissed problem proposal have nothing to hang off: they go with it (same reason, same decider),
        // instead of waiting on a problem that will never be accepted.
        await t
          .update(CPCP)
          .set(dismissal)
          .where(and(eq(CPCP.parentProposalId, proposalId), eq(CPCP.status, "pending")));
        return dismissedResult(updated);
      });
    },

    async releaseForEncounter(org, encounterId, scope) {
      return transitionDrafts(org, encounterId, scope.patientId, {
        status: "pending",
        releasedAt: new Date(),
        updatedAt: new Date(),
      });
    },

    async withdrawForEncounter(org, encounterId) {
      return transitionDrafts(org, encounterId, undefined, {
        status: "withdrawn",
        updatedAt: new Date(),
      });
    },
  };
}

function acceptedResult(row: ChangeProposalRow) {
  const type = (
    row.kind === "problem_add" || row.kind === "problem_resolve"
      ? "problem"
      : row.kind === "goal_add" || row.kind === "goal_update"
        ? "goal"
        : "intervention"
  ) as AppliedElement["type"];
  return {
    proposalId: row.id,
    status: "accepted" as const,
    resultElementType: type,
    resultElementId: row.resultElementId as string,
    decidedAt: (row.decidedAt as Date).toISOString(),
  };
}

function dismissedResult(row: ChangeProposalRow) {
  return {
    proposalId: row.id,
    status: "dismissed" as const,
    decidedAt: (row.decidedAt as Date).toISOString(),
    dismissalReason: row.dismissalReason,
  };
}
