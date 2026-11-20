// apps/web/src/modules/07-care-plan/change-proposals — the wire types of the plan-of-care change proposals (WF09), derived from the
// generated client so a server-side change breaks here at compile time, not at runtime.
import type { operations } from "@chartwarden/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok<Op> = Op extends { responses: { 200: infer R } }
  ? Json<R>
  : Op extends { responses: { 201: infer R } }
    ? Json<R>
    : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

/** `GET /care-plans/{planId}/change-proposals`: the review list. */
export type ProposalList = Ok<operations["getApiV1CareplansByPlanIdChangeproposals"]>;
export type ChangeProposal = ProposalList["proposals"][number];
export type ProposalKind = ChangeProposal["kind"];
export type ProposalStatus = ChangeProposal["status"];
export type DismissalReason = NonNullable<ChangeProposal["dismissalReason"]>;
/** The statuses the plan's review list can be asked for. */
export type ReviewStatus = "pending" | "accepted" | "dismissed";

type Change = ChangeProposal["change"];
export type ProblemKind = NonNullable<Change["problemKind"]>;
export type ProblemSource = NonNullable<Change["problemSource"]>;
export type GoalSource = NonNullable<Change["goalSource"]>;
export type GoalStatus = NonNullable<Change["goalStatus"]>;
export type Discipline = NonNullable<Change["discipline"]>;

/** One change, without the visit it came from: the PUT body (replaces a draft). */
export type ProposalChange = ReqBody<
  operations["putApiV1CareplansByPlanIdChangeproposalsByProposalId"]
>;
/** The POST body: a change plus the visit (`sourceEncounterId`) it was recorded in. */
export type CreateProposalBody = ReqBody<operations["postApiV1CareplansByPlanIdChangeproposals"]>;

export type VisitLinks = Ok<operations["getApiV1EncountersByEncounterIdCareplanlinks"]>["links"];
export type VisitLink = VisitLinks[number];
/** Exactly one plan element a visit is linked to. */
export type VisitLinkTarget = ReqBody<operations["postApiV1EncountersByEncounterIdCareplanlinks"]>;

/** The server's cap on live (draft or pending) proposals per visit. */
export const MAX_PROPOSALS_PER_VISIT = 50;
