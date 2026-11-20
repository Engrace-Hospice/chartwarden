// The note composer's "Plan of care" step (WF09): the plan's live problems, goals and interventions with an "addressed on this visit"
// toggle (the visit <-> element link), the six proposal kinds as compact forms in a right-hand drawer, this visit's drafts with Edit and
// Withdraw, and every empty / read-only / refused state. Assertions are on the RECORDED requests: method, path, exact body, headers.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import type { JSX } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PanelStatus } from "../../../../shell/panel-status";
import { PlanOfCareStep } from "../plan-of-care-step";
import type { ChangeProposal, VisitLink } from "../proposal-types";
import {
  type Call,
  GOAL,
  INTERVENTION,
  PATIENT,
  PLAN,
  PROBLEM,
  type Responder,
  VISIT_A,
  mountWith,
  proposalView,
  refusal,
} from "./proposal-test-harness";

afterEach(cleanup);

const LINK = "99999999-9999-4999-8999-999999999999";
const DRAFT = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const PROBLEM_TEXT = "Dyspnea related to end-stage COPD";
const GOAL_TEXT = "Breathe easy enough to sit on the porch";
const INTERVENTION_TEXT = "Assess respiratory status and titrate oxygen";

const planFixture = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: PLAN,
  patientId: PATIENT,
  admissionId: "adm-1",
  status: "active",
  activeVersionId: "v-1",
  version: 3,
  versions: [{ id: "v-1", planId: PLAN, sequence: 1, kind: "initial", status: "signed" }],
  problems: [
    { id: PROBLEM, planId: PLAN, description: PROBLEM_TEXT, kind: "terminal", status: "active" },
    {
      id: "p-old",
      planId: PLAN,
      description: "Resolved pressure injury",
      kind: "related",
      status: "resolved",
    },
  ],
  goals: [
    {
      id: GOAL,
      planId: PLAN,
      problemId: PROBLEM,
      originalText: GOAL_TEXT,
      revisedText: null,
      status: "in_progress",
    },
    {
      id: "g-met",
      planId: PLAN,
      problemId: PROBLEM,
      originalText: "Met goal text",
      revisedText: null,
      status: "met",
    },
  ],
  interventions: [
    {
      id: INTERVENTION,
      planId: PLAN,
      problemId: PROBLEM,
      scopeText: INTERVENTION_TEXT,
      frequencyText: "RN visit 2x weekly",
      status: "active",
      goalRefs: [],
    },
    {
      id: "i-ended",
      planId: PLAN,
      problemId: PROBLEM,
      scopeText: "Ended intervention",
      frequencyText: "",
      status: "discontinued",
      goalRefs: [],
    },
  ],
  redacted: false,
  ...over,
});

interface State {
  plan: unknown;
  links: VisitLink[];
  drafts: ChangeProposal[];
  redacted: boolean;
  nextIds: string[];
}

const linkView = (over: Partial<VisitLink> = {}): VisitLink => ({
  id: LINK,
  encounterId: VISIT_A,
  problemId: PROBLEM,
  goalId: null,
  interventionId: null,
  createdAt: "2026-11-18T15:00:00.000Z",
  ...over,
});

const seededDraft = (): ChangeProposal =>
  proposalView({
    id: DRAFT,
    status: "draft",
    kind: "goal_add",
    change: { originalText: "Walk to the mailbox", goalSource: "patient_stated" },
  });

const PLAN_READ = `GET /api/v1/patients/${PATIENT}/care-plan`;
const LINKS = `/api/v1/encounters/${VISIT_A}/care-plan-links`;
const PROPOSALS = `/api/v1/care-plans/${PLAN}/change-proposals`;
const VISIT_DRAFTS = `GET /api/v1/patients/${PATIENT}/care-plan-change-proposals`;

function routesFor(state: State, over: Record<string, Responder> = {}): Record<string, Responder> {
  return {
    [PLAN_READ]: () => ({ body: state.plan }),
    [`GET ${LINKS}`]: () => ({ body: { links: state.links } }),
    [VISIT_DRAFTS]: () => ({
      body: { patientId: PATIENT, proposals: state.drafts, redacted: state.redacted },
    }),
    [`POST ${LINKS}`]: (call) => {
      const body = call.body as Partial<VisitLink>;
      const link = linkView({
        problemId: body.problemId ?? null,
        goalId: body.goalId ?? null,
        interventionId: body.interventionId ?? null,
      });
      state.links = [...state.links, link];
      return { status: 201, body: link };
    },
    [`DELETE ${LINKS}/${LINK}`]: () => {
      state.links = [];
      return { status: 204 };
    },
    [`POST ${PROPOSALS}`]: (call) => {
      const b = call.body as Record<string, string | string[]>;
      const created = proposalView({
        id: state.nextIds.shift() ?? "created-0",
        status: "draft",
        kind: b.kind as ChangeProposal["kind"],
        parentProposalId: (b.parentProposalId as string | undefined) ?? null,
        change: {
          description: (b.description as string) ?? null,
          originalText: (b.originalText as string) ?? null,
          scopeText: (b.scopeText as string) ?? null,
        },
      });
      state.drafts = [...state.drafts, created];
      return { status: 201, body: created };
    },
    [`PUT ${PROPOSALS}/${DRAFT}`]: (call) => {
      const b = call.body as Record<string, string>;
      const updated = {
        ...(state.drafts.find((d) => d.id === DRAFT) as ChangeProposal),
        change: { ...seededDraft().change, originalText: b.originalText ?? null },
      };
      state.drafts = state.drafts.map((d) => (d.id === DRAFT ? updated : d));
      return { body: updated };
    },
    [`DELETE ${PROPOSALS}/${DRAFT}`]: () => {
      state.drafts = state.drafts.filter((d) => d.id !== DRAFT);
      return { body: { proposalId: DRAFT, status: "withdrawn" } };
    },
    ...over,
  };
}

function mountStep(
  over: Partial<State> = {},
  routeOver: Record<string, Responder> = {},
  props: { disabled?: boolean; onStatusChange?: (status: PanelStatus) => void } = {},
): { calls: Call[]; state: State; onChanged: ReturnType<typeof vi.fn> } {
  const state: State = {
    plan: planFixture(),
    links: [],
    drafts: [],
    redacted: false,
    nextIds: ["created-1", "created-2", "created-3"],
    ...over,
  };
  const calls: Call[] = [];
  const onChanged = vi.fn();
  mountWith({
    routes: routesFor(state, routeOver),
    calls,
    element: (
      <PlanOfCareStep
        encounterId={VISIT_A}
        patientId={PATIENT}
        disabled={props.disabled}
        onChanged={onChanged}
        onStatusChange={props.onStatusChange}
      />
    ),
  });
  return { calls, state, onChanged };
}

const writesOf = (calls: Call[]): Call[] => calls.filter((c) => c.method !== "GET");
const fill = (label: RegExp | string, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const drawer = (name: RegExp): Promise<HTMLElement> => screen.findByRole("complementary", { name });
const record = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Record proposal" }));
};

describe("the plan items", () => {
  it("lists the active problems with their open goals and active interventions, and says proposals go to review", async () => {
    mountStep();
    expect(await screen.findByText(PROBLEM_TEXT)).toBeInTheDocument();
    expect(screen.getByText(GOAL_TEXT)).toBeInTheDocument();
    expect(screen.getByText(INTERVENTION_TEXT)).toBeInTheDocument();
    // not live: a resolved problem, a met goal, a discontinued intervention
    expect(screen.queryByText("Resolved pressure injury")).not.toBeInTheDocument();
    expect(screen.queryByText("Met goal text")).not.toBeInTheDocument();
    expect(screen.queryByText("Ended intervention")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Proposed changes go to the case manager for review when this visit is finalized. They do not change the plan.",
      ),
    ).toBeInTheDocument();
  });

  it("reads the plan, this visit's links and this visit's drafts (the visit id in the query, never any text)", async () => {
    const { calls } = mountStep();
    await screen.findByText(PROBLEM_TEXT);
    const gets = calls
      .filter((c) => c.method === "GET")
      .map((c) => `${c.path}${c.query.size ? `?${c.query}` : ""}`);
    expect(gets).toContain(`/api/v1/patients/${PATIENT}/care-plan`);
    expect(gets).toContain(LINKS);
    expect(gets).toContain(
      `/api/v1/patients/${PATIENT}/care-plan-change-proposals?sourceEncounterId=${VISIT_A}`,
    );
  });

  it("shows a plain empty state when the patient has no care plan, and offers nothing to change", async () => {
    mountStep({ plan: { carePlan: null } });
    expect(await screen.findByText("No care plan yet")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add problem" })).not.toBeInTheDocument();
  });

  it("says restricted content was omitted when the plan is redacted", async () => {
    mountStep({ plan: planFixture({ redacted: true }) });
    expect(await screen.findByText(/restricted content omitted/i)).toBeInTheDocument();
  });

  it("still lets a draft be recorded while a version is in review, and says accepting waits", async () => {
    mountStep({
      plan: planFixture({
        versions: [
          { id: "v-2", planId: PLAN, sequence: 2, kind: "idg_review", status: "in_review" },
        ],
      }),
    });
    expect(await screen.findByText(/waiting for signatures/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add problem" })).toBeEnabled();
  });

  it("offers no proposal on a closed plan", async () => {
    mountStep({ plan: planFixture({ status: "discharged" }) });
    expect(await screen.findByText(/this care plan is closed/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add problem" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Update goal/ })).not.toBeInTheDocument();
  });

  it("shows a read failure with Try again", async () => {
    let answers = 0;
    mountStep(
      {},
      {
        [PLAN_READ]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, "INTERNAL") : { body: planFixture() };
        },
      },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(PROBLEM_TEXT)).toBeInTheDocument();
  });
});

describe("addressed on this visit", () => {
  it("links the element on, shows it checked, and removes the link when toggled off", async () => {
    const { calls, onChanged } = mountStep();
    const box = await screen.findByRole("checkbox", {
      name: `Addressed on this visit: ${PROBLEM_TEXT}`,
    });
    expect(box).not.toBeChecked();

    fireEvent.click(box);
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
      ).toBeChecked(),
    );
    const post = writesOf(calls)[0];
    expect(post).toMatchObject({ method: "POST", path: LINKS, body: { problemId: PROBLEM } });
    expect(onChanged).toHaveBeenCalledTimes(1);

    fireEvent.click(
      screen.getByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
      ).not.toBeChecked(),
    );
    expect(writesOf(calls)[1]).toMatchObject({ method: "DELETE", path: `${LINKS}/${LINK}` });
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("names a goal and an intervention by their own ids", async () => {
    const { calls } = mountStep();
    fireEvent.click(
      await screen.findByRole("checkbox", { name: `Addressed on this visit: ${GOAL_TEXT}` }),
    );
    await waitFor(() => expect(writesOf(calls)).toHaveLength(1));
    fireEvent.click(
      screen.getByRole("checkbox", { name: `Addressed on this visit: ${INTERVENTION_TEXT}` }),
    );
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls).map((c) => c.body)).toEqual([
      { goalId: GOAL },
      { interventionId: INTERVENTION },
    ]);
  });

  it("shows the links the visit already carries", async () => {
    mountStep({ links: [linkView({ problemId: null, goalId: GOAL })] });
    expect(
      await screen.findByRole("checkbox", { name: `Addressed on this visit: ${GOAL_TEXT}` }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
    ).not.toBeChecked();
  });

  it("says why a link was refused instead of failing silently", async () => {
    const { onChanged } = mountStep(
      {},
      {
        [`POST ${LINKS}`]: () =>
          refusal(422, "VALIDATION_ERROR", "problem is not valid for this encounter"),
      },
    );
    fireEvent.click(
      await screen.findByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
    );
    expect(await screen.findByText(/cannot be linked to this visit/i)).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: `Addressed on this visit: ${PROBLEM_TEXT}` }),
    ).not.toBeChecked();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe("proposing a change", () => {
  it("records a draft: the exact body with the visit, and an Idempotency-Key", async () => {
    const { calls, onChanged } = mountStep();
    fireEvent.click(
      await screen.findByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` }),
    );
    const aside = await drawer(/propose: add goal/i);
    expect(within(aside).getByLabelText(/linked problem/i)).toHaveValue(`problem:${PROBLEM}`);

    fill(/goal statement/i, "  Sleep through the night  ");
    record();

    expect(await screen.findByText(/recorded as a draft/i)).toBeInTheDocument();
    const post = writesOf(calls)[0];
    expect(post?.path).toBe(PROPOSALS);
    expect(post?.body).toEqual({
      sourceEncounterId: VISIT_A,
      kind: "goal_add",
      problemId: PROBLEM,
      originalText: "Sleep through the night",
      goalSource: "clinical",
    });
    expect(post?.headers.get("idempotency-key")).toBeTruthy();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    // the draft is now listed under this visit's proposed changes
    const list = screen.getByRole("table", { name: "Changes proposed in this visit" });
    expect(within(list).getByText("Add goal")).toBeInTheDocument();
    expect(within(list).getByText("Draft")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("proposes a new problem and a goal under it together (parentProposalId, no problemId)", async () => {
    const { calls } = mountStep();
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/propose: add problem/i);
    fill(/problem description/i, "Anxiety at night");
    record();
    await screen.findByText(/recorded as a draft/i);
    expect(writesOf(calls)[0]?.body).toEqual({
      sourceEncounterId: VISIT_A,
      kind: "problem_add",
      description: "Anxiety at night",
      problemKind: "related",
      problemSource: "clinical",
    });

    fireEvent.click(screen.getByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` }));
    await drawer(/propose: add goal/i);
    fill(/linked problem/i, "proposal:created-1");
    fill(/goal statement/i, "Sleep through the night");
    record();
    await waitFor(() => expect(writesOf(calls)).toHaveLength(2));
    expect(writesOf(calls)[1]?.body).toEqual({
      sourceEncounterId: VISIT_A,
      kind: "goal_add",
      parentProposalId: "created-1",
      originalText: "Sleep through the night",
      goalSource: "clinical",
    });
  });

  it.each([
    [
      "problem_resolve",
      `Resolve problem: ${PROBLEM_TEXT}`,
      /propose: resolve problem/i,
      () => fill(/resolution note/i, "Dyspnea resolved with oxygen"),
      {
        kind: "problem_resolve",
        problemId: PROBLEM,
        resolutionNote: "Dyspnea resolved with oxygen",
      },
    ],
    [
      "goal_update",
      `Update goal: ${GOAL_TEXT}`,
      /propose: update goal/i,
      () => {
        fill(/revised goal statement/i, "Sit on the porch for an hour");
        fill(/new status/i, "revised");
      },
      {
        kind: "goal_update",
        goalId: GOAL,
        revisedText: "Sit on the porch for an hour",
        goalStatus: "revised",
      },
    ],
    [
      "intervention_add",
      `Add an intervention to problem: ${PROBLEM_TEXT}`,
      /propose: add intervention/i,
      () => {
        fill(/^Intervention/, "Teach pursed-lip breathing");
        fill(/^Frequency(?! value)/, "Twice weekly");
        fill(/^Frequency value/, "2");
      },
      {
        kind: "intervention_add",
        problemId: PROBLEM,
        scopeText: "Teach pursed-lip breathing",
        frequencyText: "Twice weekly",
        frequencyValue: "2",
        discipline: "rn",
      },
    ],
    [
      "intervention_discontinue",
      `Discontinue intervention: ${INTERVENTION_TEXT}`,
      /propose: discontinue intervention/i,
      () => fill(/reason for discontinuing/i, "Oxygen no longer needed"),
      {
        kind: "intervention_discontinue",
        interventionId: INTERVENTION,
        reason: "Oxygen no longer needed",
      },
    ],
  ])("sends the exact body for %s", async (_kind, button, heading, fillIn, expected) => {
    const { calls } = mountStep();
    fireEvent.click(await screen.findByRole("button", { name: button }));
    await drawer(heading);
    fillIn();
    record();
    await screen.findByText(/recorded as a draft/i);
    expect(writesOf(calls)[0]?.body).toEqual({ sourceEncounterId: VISIT_A, ...expected });
  });

  it("will not send a form with a required field empty, and says which one", async () => {
    const { calls } = mountStep();
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/propose: add problem/i);
    record();
    expect(await screen.findByText("This field is required.")).toBeInTheDocument();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("will not send a goal update that changes nothing", async () => {
    const { calls } = mountStep();
    fireEvent.click(await screen.findByRole("button", { name: `Update goal: ${GOAL_TEXT}` }));
    await drawer(/propose: update goal/i);
    record();
    expect(await screen.findByText(/change at least one of the revised goal/i)).toBeInTheDocument();
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("shows the server's refusal of one field beside that field", async () => {
    mountStep(
      {},
      {
        [`POST ${PROPOSALS}`]: () => ({
          status: 422,
          body: {
            error: {
              code: "VALIDATION_ERROR",
              message: "invalid",
              details: [
                { field: "originalText", code: "INVALID", message: "Goal text is too vague" },
              ],
            },
          },
        }),
      },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` }),
    );
    await drawer(/propose: add goal/i);
    fill(/goal statement/i, "Be better");
    record();
    expect(await screen.findByText("Goal text is too vague")).toBeInTheDocument();
    // the drawer stays open with what was typed
    expect(screen.getByLabelText(/goal statement/i)).toHaveValue("Be better");
  });

  it.each([
    ["TOO_MANY_PROPOSALS", 409, /most proposed changes allowed \(50\)/i],
    ["CARE_PLAN_CLOSED", 409, /this care plan is closed/i],
    ["PROPOSAL_TARGET_UNAVAILABLE", 409, /removed or is already finished/i],
    ["VERSION_IN_REVIEW", 409, /waiting for signatures/i],
  ])("renders %s in plain words and keeps what was typed", async (code, status, words) => {
    const { onChanged } = mountStep({}, { [`POST ${PROPOSALS}`]: () => refusal(status, code) });
    fireEvent.click(
      await screen.findByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` }),
    );
    await drawer(/propose: add goal/i);
    fill(/goal statement/i, "Sleep through the night");
    record();
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(screen.getByLabelText(/goal statement/i)).toHaveValue("Sleep through the night");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("replays a retry of the same proposal under the same Idempotency-Key after a lost reply", async () => {
    let attempts = 0;
    const { calls } = mountStep(
      {},
      {
        [`POST ${PROPOSALS}`]: () => {
          attempts += 1;
          if (attempts === 1) throw new TypeError("network down");
          return {
            status: 201,
            body: proposalView({
              status: "draft",
              kind: "goal_add",
              change: { originalText: "Sleep through the night" },
            }),
          };
        },
      },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` }),
    );
    await drawer(/propose: add goal/i);
    fill(/goal statement/i, "Sleep through the night");
    record();
    expect(await screen.findByText(/could not reach the server/i)).toBeInTheDocument();
    record();
    await screen.findByText(/recorded as a draft/i);
    const keys = writesOf(calls).map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });
});

describe("this visit's drafts", () => {
  it("edits a draft in place: the form starts from its fields and the PUT carries the change without the visit", async () => {
    const { calls, onChanged } = mountStep({ drafts: [seededDraft()] });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit proposal: Add goal: Walk to the mailbox" }),
    );
    await drawer(/edit: add goal/i);
    expect(screen.getByLabelText(/goal statement/i)).toHaveValue("Walk to the mailbox");

    fill(/goal statement/i, "Walk to the garden gate");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByText("Draft updated.");
    const put = writesOf(calls)[0];
    expect(put).toMatchObject({ method: "PUT", path: `${PROPOSALS}/${DRAFT}` });
    expect(put?.body).toEqual({
      kind: "goal_add",
      problemId: PROBLEM,
      originalText: "Walk to the garden gate",
      goalSource: "patient_stated",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Walk to the garden gate")).toBeInTheDocument();
  });

  it("withdraws a draft", async () => {
    const { calls, onChanged } = mountStep({ drafts: [seededDraft()] });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw proposal: Add goal: Walk to the mailbox",
      }),
    );
    expect(await screen.findByText("Draft withdrawn.")).toBeInTheDocument();
    expect(writesOf(calls)[0]).toMatchObject({ method: "DELETE", path: `${PROPOSALS}/${DRAFT}` });
    expect(screen.getByText("No changes proposed in this visit yet.")).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("says a draft can no longer be withdrawn once it went to review, and reads the drafts again", async () => {
    const { calls } = mountStep(
      { drafts: [seededDraft()] },
      {
        [`DELETE ${PROPOSALS}/${DRAFT}`]: () => refusal(409, "PROPOSAL_NOT_DRAFT"),
      },
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw proposal: Add goal: Walk to the mailbox",
      }),
    );
    expect(await screen.findByText(/already gone to review/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.path.endsWith("care-plan-change-proposals")),
      ).toHaveLength(2),
    );
  });

  it("flags a problem proposal's dependents: withdrawing it withdraws them too", async () => {
    const parent = proposalView({
      id: DRAFT,
      status: "draft",
      kind: "problem_add",
      target: null,
      change: { description: "Anxiety at night" },
    });
    const child = proposalView({
      status: "draft",
      kind: "goal_add",
      parentProposalId: DRAFT,
      target: { type: "problem", id: null, label: null },
      change: { originalText: "Sleep through the night" },
    });
    mountStep({ drafts: [parent, child] });
    expect(
      await screen.findByText(/withdrawing this also withdraws its goals and interventions/i),
    ).toBeInTheDocument();
  });

  it("shows a released draft as waiting for review, read-only", async () => {
    mountStep({
      drafts: [
        proposalView({
          status: "pending",
          kind: "goal_add",
          change: { originalText: "Walk to the mailbox" },
        }),
      ],
    });
    expect(await screen.findByText("Waiting for review")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit proposal/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Withdraw proposal/ })).not.toBeInTheDocument();
  });

  it("does not list a withdrawn draft", async () => {
    mountStep({
      drafts: [proposalView({ status: "withdrawn", change: { originalText: "Gone text" } })],
    });
    await screen.findByText(PROBLEM_TEXT);
    expect(screen.queryByText("Gone text")).not.toBeInTheDocument();
  });
});

describe("read-only (the note cannot be edited)", () => {
  it("shows links and drafts but changes nothing: no toggles, no proposal actions, no Edit or Withdraw", async () => {
    mountStep({ links: [linkView()], drafts: [seededDraft()] }, {}, { disabled: true });
    const box = await screen.findByRole("checkbox", {
      name: `Addressed on this visit: ${PROBLEM_TEXT}`,
    });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: `Addressed on this visit: ${GOAL_TEXT}` }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add problem" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Resolve|Update|Discontinue|Add a)/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^(Edit|Withdraw) proposal/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Walk to the mailbox")).toBeInTheDocument();
  });
});

/** The step as the composer holds it: a toggle stands for the note going read-only or busy and coming back. */
function DisabledHost(): JSX.Element {
  const [disabled, setDisabled] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setDisabled((held) => !held)}>
        Toggle disabled
      </button>
      <PlanOfCareStep encounterId={VISIT_A} patientId={PATIENT} disabled={disabled} />
    </>
  );
}

describe("its place in the note", () => {
  it("is its own labelled region with an h2, and its tables' headings sit under it", async () => {
    mountStep();
    const region = await screen.findByRole("region", { name: "Plan of care" });
    expect(within(region).getByRole("heading", { level: 2, name: "Plan of care" })).toBeVisible();
    expect(within(region).getByRole("heading", { level: 3, name: "Plan items" })).toBeVisible();
    expect(
      within(region).getByRole("heading", { level: 3, name: "Changes proposed in this visit" }),
    ).toBeVisible();
  });

  it("keeps the region while it loads and when there is no plan", async () => {
    mountStep({ plan: null });
    expect(await screen.findByText("No care plan yet")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Plan of care" })).toBeVisible();
  });
});

describe("what it tells the note it sits in", () => {
  it("is not unsaved until something is typed into an open proposal, and not again once it is closed", async () => {
    const onStatusChange = vi.fn();
    mountStep({}, {}, { onStatusChange });
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith({
        dirty: false,
        saving: false,
        recorded: false,
      }),
    );

    fill(/problem description/i, "Anxiety at night");
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: true })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false })),
    );
  });

  it("says a write is in flight while a proposal is being recorded", async () => {
    const onStatusChange = vi.fn();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mountStep(
      { nextIds: ["created-1"] },
      {
        [`POST ${PROPOSALS}`]: async () => {
          await held;
          return { status: 201, body: proposalView({ id: "created-1", status: "draft" }) };
        },
      },
      { onStatusChange },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);
    fill(/problem description/i, "Anxiety at night");
    record();

    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ saving: true })),
    );
    release();
    await waitFor(() =>
      expect(onStatusChange).toHaveBeenLastCalledWith(
        expect.objectContaining({ saving: false, dirty: false }),
      ),
    );
  });
});

describe("while the note cannot take a write", () => {
  it("keeps an open proposal form, with its text, read-only and unsendable until the note is open again", async () => {
    const state: State = {
      plan: planFixture(),
      links: [],
      drafts: [],
      redacted: false,
      nextIds: [],
    };
    const calls: Call[] = [];
    mountWith({ routes: routesFor(state), calls, element: <DisabledHost /> });
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);
    fill(/problem description/i, "Anxiety at night");

    fireEvent.click(screen.getByRole("button", { name: "Toggle disabled" }));
    expect(screen.getByRole("button", { name: "Record proposal" })).toBeDisabled();
    expect(screen.getByLabelText(/problem description/i)).toBeDisabled();
    expect(screen.getByLabelText(/problem description/i)).toHaveValue("Anxiety at night");
    fireEvent.submit(screen.getByLabelText(/problem description/i).closest("form") as HTMLElement);
    expect(writesOf(calls)).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Toggle disabled" }));
    expect(screen.getByRole("button", { name: "Record proposal" })).toBeEnabled();
    expect(screen.getByLabelText(/problem description/i)).toHaveValue("Anxiety at night");
  });
});

describe("a draft other drafts hang off", () => {
  const parent = (): ChangeProposal =>
    proposalView({
      id: DRAFT,
      status: "draft",
      kind: "problem_add",
      target: null,
      change: { description: "Anxiety at night" },
    });
  const child = (): ChangeProposal =>
    proposalView({
      status: "draft",
      kind: "goal_add",
      parentProposalId: DRAFT,
      target: { type: "problem", id: null, label: null },
      change: { originalText: "Sleep through the night" },
    });
  const withdrawParent = (): void => {
    fireEvent.click(
      screen.getByRole("button", { name: "Withdraw proposal: Add problem: Anxiety at night" }),
    );
  };

  it("asks before withdrawing it, because the goals and interventions under it go with it", async () => {
    const { calls } = mountStep({ drafts: [parent(), child()] });
    await screen.findByText("Anxiety at night");

    withdrawParent();

    const dialog = await screen.findByRole("alertdialog", { name: "Withdraw this proposal?" });
    expect(within(dialog).getByText(/also withdraws 1 goal or intervention/)).toBeVisible();
    expect(writesOf(calls)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await screen.findByText("Draft withdrawn.");
    expect(writesOf(calls)).toEqual([
      expect.objectContaining({ method: "DELETE", path: `${PROPOSALS}/${DRAFT}` }),
    ]);
  });

  it("withdraws nothing when the question is declined", async () => {
    const { calls } = mountStep({ drafts: [parent(), child()] });
    await screen.findByText("Anxiety at night");

    withdrawParent();
    const dialog = await screen.findByRole("alertdialog", { name: "Withdraw this proposal?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("alertdialog", { name: "Withdraw this proposal?" })).toBeNull(),
    );
    expect(writesOf(calls)).toHaveLength(0);
  });

  it("withdraws a draft with nothing under it at once, without asking", async () => {
    const { calls } = mountStep({ drafts: [seededDraft()] });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw proposal: Add goal: Walk to the mailbox",
      }),
    );
    expect(await screen.findByText("Draft withdrawn.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(writesOf(calls)).toHaveLength(1);
  });
});

describe("overlapping link writes", () => {
  const box = (text: string): HTMLElement =>
    screen.getByRole("checkbox", { name: `Addressed on this visit: ${text}` });

  it("keeps each toggle's own busy flag: the first stays disabled until its own write lands", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let posts = 0;
    const handle = {} as { state: State };
    const mounted = mountStep(
      {},
      {
        [`POST ${LINKS}`]: async (call) => {
          posts += 1;
          if (posts === 1) await held;
          return (routesFor(handle.state)[`POST ${LINKS}`] as Responder)(call);
        },
      },
    );
    handle.state = mounted.state;
    await screen.findByText(PROBLEM_TEXT);

    fireEvent.click(box(PROBLEM_TEXT));
    fireEvent.click(box(GOAL_TEXT));
    await waitFor(() => expect(box(GOAL_TEXT)).toBeChecked());
    // The goal's write is done; the problem's is still out.
    expect(box(PROBLEM_TEXT)).toBeDisabled();
    expect(box(GOAL_TEXT)).toBeEnabled();

    release();
    await waitFor(() => expect(box(PROBLEM_TEXT)).toBeEnabled());
  });

  it("shows the latest read of the links when an older read answers last", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    let staleTaken!: () => void;
    const stalePromise = new Promise<void>((resolve) => {
      staleTaken = resolve;
    });
    const state: State = {
      plan: planFixture(),
      links: [],
      drafts: [],
      redacted: false,
      nextIds: [],
    };
    mountStep(
      {},
      {
        [`GET ${LINKS}`]: async () => {
          reads += 1;
          // The initial read, then the slow answer to the first toggle's re-read, then the quick one to the second's.
          if (reads === 2) {
            await held;
            return { body: { links: [] }, onRead: staleTaken };
          }
          return { body: { links: state.links } };
        },
        [`POST ${LINKS}`]: (call) => {
          const body = call.body as Partial<VisitLink>;
          const link = linkView({ problemId: body.problemId ?? null, goalId: body.goalId ?? null });
          state.links = [...state.links, link];
          return { status: 201, body: link };
        },
      },
    );
    await screen.findByText(PROBLEM_TEXT);

    fireEvent.click(box(PROBLEM_TEXT));
    await waitFor(() => expect(reads).toBe(2));
    fireEvent.click(box(GOAL_TEXT));
    await waitFor(() => expect(box(GOAL_TEXT)).toBeChecked());

    release();
    // The slow, older answer is delivered and handled (one turn of the event loop inside act); only then is "it undid nothing" worth asserting.
    await stalePromise;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The slow, older read said "no links"; it must not undo what the newer read showed.
    expect(box(PROBLEM_TEXT)).toBeChecked();
    expect(box(GOAL_TEXT)).toBeChecked();
  });
});

describe("a proposal already open", () => {
  const addGoalToProblem = (): HTMLElement =>
    screen.getByRole("button", { name: `Add a goal to problem: ${PROBLEM_TEXT}` });

  it("is not replaced by starting another while it holds typed input: the proposal actions wait", async () => {
    mountStep({ drafts: [seededDraft()] });
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);
    expect(addGoalToProblem()).toBeEnabled();

    fill(/problem description/i, "Anxiety at night");

    expect(addGoalToProblem()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add problem" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Edit proposal/ })).toBeDisabled();
    expect(
      screen.getByText(/Save or cancel the open proposal before starting another/),
    ).toBeVisible();
    // Nothing was replaced: the typed text is still in the drawer.
    expect(screen.getByLabelText(/problem description/i)).toHaveValue("Anxiety at night");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(addGoalToProblem()).toBeEnabled());
    expect(screen.getByRole("button", { name: /^Edit proposal/ })).toBeEnabled();
  });

  it("can be replaced by another while nothing has been typed in it", async () => {
    mountStep({ drafts: [seededDraft()] });
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);

    fireEvent.click(addGoalToProblem());

    expect(await drawer(/Propose: Add goal/)).toBeInTheDocument();
  });

  it("keeps the proposal actions locked while it is being recorded", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = {} as { state: State };
    const mounted = mountStep(
      { drafts: [seededDraft()] },
      {
        [`POST ${PROPOSALS}`]: async (call) => {
          await held;
          return (routesFor(handle.state)[`POST ${PROPOSALS}`] as Responder)(call);
        },
      },
    );
    handle.state = mounted.state;
    fireEvent.click(await screen.findByRole("button", { name: "Add problem" }));
    await drawer(/Propose: /);
    fill(/problem description/i, "Anxiety at night");
    record();

    await waitFor(() => expect(addGoalToProblem()).toBeDisabled());
    expect(screen.getByRole("button", { name: /^Edit proposal/ })).toBeDisabled();

    release();
    await screen.findByText(RECORDED_NOTICE_TEXT);
    await waitFor(() => expect(addGoalToProblem()).toBeEnabled());
  });
});

describe("withdrawing several dependents", () => {
  it("says how many go with it: goals and interventions in the plural", async () => {
    const parent = proposalView({
      id: DRAFT,
      status: "draft",
      kind: "problem_add",
      target: null,
      change: { description: "Anxiety at night" },
    });
    const dependent = (text: string): ChangeProposal =>
      proposalView({
        status: "draft",
        kind: "goal_add",
        parentProposalId: DRAFT,
        target: { type: "problem", id: null, label: null },
        change: { originalText: text },
      });
    mountStep({
      drafts: [parent, dependent("Sleep through the night"), dependent("Calm evenings")],
    });
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Withdraw proposal: Add problem: Anxiety at night",
      }),
    );

    const dialog = await screen.findByRole("alertdialog", { name: "Withdraw this proposal?" });
    expect(
      within(dialog).getByText(/also withdraws 2 goals and interventions proposed/),
    ).toBeVisible();
  });
});

describe("focus after a retry", () => {
  it("lands on the plan of care region when Try again replaces the error", async () => {
    let answers = 0;
    mountStep(
      {},
      {
        [PLAN_READ]: () => {
          answers += 1;
          return answers === 1 ? refusal(500, "INTERNAL") : { body: planFixture() };
        },
      },
    );
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);

    await screen.findByText(PROBLEM_TEXT);
    await waitFor(() => expect(screen.getByRole("region", { name: "Plan of care" })).toHaveFocus());
  });
});

const RECORDED_NOTICE_TEXT =
  "Change recorded as a draft. It goes to the case manager for review when this visit is finalized.";
