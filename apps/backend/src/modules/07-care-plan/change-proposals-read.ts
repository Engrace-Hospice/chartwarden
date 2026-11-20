// apps/backend/src/modules/07-care-plan/change-proposals-read.ts — WF09: the read side of the plan-of-care change proposals. Turns rows into
// the view the review list and the visit composer show: the element each change touches resolved to what the plan calls it (the way the plan
// summary does), and the proposing / deciding clinician resolved to a name. Runs on the caller's tenant transaction (RLS scopes every read).
//
// Visibility (the only place it lives, so a list cannot forget it):
//   • a DRAFT (and a withdrawn draft) is visible to its proposer alone — the plan's review surfaces never see a visit still being written;
//   • a Part 2 proposal is omitted, in SQL, from a caller without disclosure (§7.6) and the list says `redacted`.
import { type DbClient, schema } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import { type SQL, and, desc, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { changeViewOf, targetRefOf } from "./change-proposals-rules";
import type {
  CarePlanChangeProposalView,
  ChangeProposalPlanListQuery,
} from "./routes/change-proposal-typebox";

const CPCP = schema.carePlanChangeProposals;
const CP = schema.carePlans;
const PROB = schema.problems;
const GOAL = schema.goals;
const INTV = schema.interventions;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;

export type ChangeProposalRow = typeof CPCP.$inferSelect;
type ProposalStatus = ChangeProposalRow["status"];

/**
 * The most proposals one list read returns: a guard, not a page size (a plan's pending list is a handful; only a long decided history
 * could reach it). The newest are kept, so a cap drops the oldest history.
 */
export const MAX_PROPOSALS_LISTED = 200;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const idsOf = (ids: readonly (string | null)[]): string[] => [
  ...new Set(ids.filter((id): id is string => id !== null)),
];

/** Names by membership id, within the org. Names only: never an email, a username or a status. */
async function memberNames(
  t: DbClient,
  org: string,
  membershipIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await t
    .select({ id: MEMBERSHIP.id, name: USER.name })
    .from(MEMBERSHIP)
    .innerJoin(USER, eq(USER.id, MEMBERSHIP.userId))
    .where(and(eq(MEMBERSHIP.organizationId, org), inArray(MEMBERSHIP.id, [...membershipIds])));
  const names = new Map<string, string>();
  for (const r of rows) {
    const name = r.name?.trim();
    if (name) names.set(r.id, name);
  }
  return names;
}

/**
 * What the plan calls each touched element: a problem's description, a goal's current text, an intervention's scope. A parent problem
 * PROPOSAL flagged Part 2 is never labelled for a caller without disclosure (§7.6): its description is the disclosure.
 */
async function elementLabels(
  t: DbClient,
  rows: readonly ChangeProposalRow[],
  sudDisclosureAllowed: boolean,
) {
  const refs = rows.map((r) => ({ row: r, ref: targetRefOf(r) }));
  const idsFor = (type: "problem" | "goal" | "intervention") =>
    idsOf(refs.filter((x) => x.ref?.type === type).map((x) => x.ref?.id ?? null));
  const [problemIds, goalIds, interventionIds] = [
    idsFor("problem"),
    idsFor("goal"),
    idsFor("intervention"),
  ];
  const parentIds = idsOf(rows.map((r) => r.parentProposalId));
  // One transaction connection runs one query at a time, so these are awaited in turn (not Promise.all).
  const problems = problemIds.length
    ? await t
        .select({ id: PROB.id, label: PROB.description })
        .from(PROB)
        .where(inArray(PROB.id, problemIds))
    : [];
  const goals = goalIds.length
    ? await t
        .select({ id: GOAL.id, original: GOAL.originalText, revised: GOAL.revisedText })
        .from(GOAL)
        .where(inArray(GOAL.id, goalIds))
    : [];
  const interventions = interventionIds.length
    ? await t
        .select({ id: INTV.id, label: INTV.scopeText })
        .from(INTV)
        .where(inArray(INTV.id, interventionIds))
    : [];
  const parents = parentIds.length
    ? await t
        .select({ id: CPCP.id, label: CPCP.description })
        .from(CPCP)
        .where(and(inArray(CPCP.id, parentIds), ...sudFilter(sudDisclosureAllowed)))
    : [];
  return {
    problem: new Map(problems.map((p) => [p.id, p.label])),
    goal: new Map(goals.map((g) => [g.id, g.revised ?? g.original])),
    intervention: new Map(interventions.map((i) => [i.id, i.label])),
    parent: new Map(parents.map((p) => [p.id, p.label])),
  };
}

/** The read view of `rows`, in order, for a caller who may (or may not) see Part 2 content. */
export async function viewsOf(
  t: DbClient,
  org: string,
  rows: readonly ChangeProposalRow[],
  sudDisclosureAllowed: boolean,
): Promise<CarePlanChangeProposalView[]> {
  if (rows.length === 0) return [];
  const names = await memberNames(
    t,
    org,
    idsOf(rows.flatMap((r) => [r.proposedByMembershipId, r.decidedByMembershipId])),
  );
  const labels = await elementLabels(t, rows, sudDisclosureAllowed);
  const member = (membershipId: string) => ({
    membershipId,
    displayName: names.get(membershipId) ?? null,
  });
  return rows.map((r) => {
    const ref = targetRefOf(r);
    const label = !ref
      ? null
      : ref.id
        ? (labels[ref.type].get(ref.id) ?? null)
        : r.parentProposalId
          ? (labels.parent.get(r.parentProposalId) ?? null)
          : null;
    return {
      id: r.id,
      carePlanId: r.carePlanId,
      patientId: r.patientId,
      sourceEncounterId: r.sourceEncounterId,
      kind: r.kind as CarePlanChangeProposalView["kind"],
      status: r.status as CarePlanChangeProposalView["status"],
      sudRelated: r.sudRelated,
      change: changeViewOf(r),
      target: ref ? { type: ref.type, id: ref.id, label } : null,
      parentProposalId: r.parentProposalId,
      proposedBy: member(r.proposedByMembershipId),
      proposedAt: r.createdAt.toISOString(),
      releasedAt: iso(r.releasedAt),
      decidedBy: r.decidedByMembershipId ? member(r.decidedByMembershipId) : null,
      decidedAt: iso(r.decidedAt),
      dismissalReason: r.dismissalReason as CarePlanChangeProposalView["dismissalReason"],
      resultElementId: r.resultElementId,
    };
  });
}

/** A Part 2 proposal is invisible to a caller without disclosure: SQL, not a post-fetch hide. */
const sudFilter = (sudDisclosureAllowed: boolean): SQL[] =>
  sudDisclosureAllowed ? [] : [eq(CPCP.sudRelated, false)];

/** A draft (or withdrawn draft) belongs to its proposer alone. */
const draftVisibility = (membershipId: string | null): SQL =>
  or(
    notInArray(CPCP.status, ["draft", "withdrawn"]),
    membershipId ? eq(CPCP.proposedByMembershipId, membershipId) : sql`false`,
  ) as SQL;

/** The newest `MAX_PROPOSALS_LISTED` proposals matching `where`, returned oldest first. */
async function newestFirstCapped(
  t: DbClient,
  where: SQL | undefined,
): Promise<ChangeProposalRow[]> {
  const newest = await t
    .select()
    .from(CPCP)
    .where(where)
    .orderBy(desc(CPCP.createdAt), desc(CPCP.id))
    .limit(MAX_PROPOSALS_LISTED);
  return newest.reverse();
}

async function hiddenSudCount(t: DbClient, where: SQL | undefined): Promise<boolean> {
  const [hidden] = await t
    .select({ n: sql<number>`count(*)::int` })
    .from(CPCP)
    .where(and(eq(CPCP.sudRelated, true), where));
  return Number(hidden?.n ?? 0) > 0;
}

/** The plan's review list: released proposals only (`pending` unless a decided history is asked for). */
export async function listForPlan(
  t: DbClient,
  org: string,
  planId: string,
  opts: {
    readonly status?: ChangeProposalPlanListQuery["status"];
    readonly sudDisclosureAllowed: boolean;
  },
) {
  const [plan] = await t
    .select({ patientId: CP.patientId })
    .from(CP)
    .where(eq(CP.id, planId))
    .limit(1);
  if (!plan) throw new NotFoundError("care_plan", planId);
  const scope = and(eq(CPCP.carePlanId, planId), eq(CPCP.status, opts.status ?? "pending"));
  const rows = await newestFirstCapped(t, and(scope, ...sudFilter(opts.sudDisclosureAllowed)));
  return {
    patientId: plan.patientId,
    proposals: await viewsOf(t, org, rows, opts.sudDisclosureAllowed),
    redacted: opts.sudDisclosureAllowed ? false : await hiddenSudCount(t, scope),
  };
}

/**
 * The patient's proposals: one visit's (the caller's own drafts included, withdrawn ones left out unless asked for), or — without a visit —
 * every `pending` one.
 */
export async function listForPatient(
  t: DbClient,
  org: string,
  patientId: string,
  opts: {
    readonly sourceEncounterId?: string;
    readonly status?: ProposalStatus;
    readonly membershipId: string | null;
    readonly sudDisclosureAllowed: boolean;
  },
) {
  const status = opts.status
    ? eq(CPCP.status, opts.status)
    : opts.sourceEncounterId
      ? ne(CPCP.status, "withdrawn")
      : eq(CPCP.status, "pending");
  const scope = and(
    eq(CPCP.patientId, patientId),
    opts.sourceEncounterId ? eq(CPCP.sourceEncounterId, opts.sourceEncounterId) : undefined,
    status,
    draftVisibility(opts.membershipId),
  );
  const rows = await newestFirstCapped(t, and(scope, ...sudFilter(opts.sudDisclosureAllowed)));
  return {
    patientId,
    proposals: await viewsOf(t, org, rows, opts.sudDisclosureAllowed),
    redacted: opts.sudDisclosureAllowed ? false : await hiddenSudCount(t, scope),
  };
}
