// The form <-> request-body mapping of a proposal: what each kind sends, what it refuses to send, and how a stored proposal is edited.
import { describe, expect, it } from "vitest";
import {
  emptyForm,
  formErrorsFromServer,
  formFromProposal,
  toChange,
} from "../proposal-form-model";
import { proposalView } from "./proposal-test-harness";

const PROBLEM = "33333333-3333-4333-8333-333333333333";

describe("toChange", () => {
  it("builds a problem_add with only what was filled in", () => {
    const form = emptyForm({
      description: "  Anxiety at night ",
      sudRelated: true,
      onsetAt: "2026-11-01",
    });
    expect(toChange("problem_add", form)).toEqual({
      ok: true,
      change: {
        kind: "problem_add",
        description: "Anxiety at night",
        problemKind: "related",
        problemSource: "clinical",
        sudRelated: true,
        onsetAt: "2026-11-01T00:00:00.000Z",
      },
    });
  });

  it("names an existing problem by problemId and a proposed one by parentProposalId", () => {
    const text = { originalText: "Sleep through the night" };
    const existing = toChange("goal_add", emptyForm({ ...text, problemRef: `problem:${PROBLEM}` }));
    const proposed = toChange("goal_add", emptyForm({ ...text, problemRef: "proposal:abc" }));
    expect(existing).toMatchObject({ ok: true, change: { problemId: PROBLEM } });
    expect(existing.ok && "parentProposalId" in existing.change).toBe(false);
    expect(proposed).toMatchObject({ ok: true, change: { parentProposalId: "abc" } });
    expect(proposed.ok && "problemId" in proposed.change).toBe(false);
  });

  it("refuses a goal or intervention with no problem chosen", () => {
    const goal = toChange("goal_add", emptyForm({ originalText: "x" }));
    expect(goal).toEqual({
      ok: false,
      errors: { problemRef: "Choose the problem this belongs to." },
    });
  });

  it("refuses each required field left empty, with the field named", () => {
    expect(toChange("problem_resolve", emptyForm(), PROBLEM)).toMatchObject({
      ok: false,
      errors: { resolutionNote: "This field is required." },
    });
    expect(toChange("intervention_discontinue", emptyForm(), PROBLEM)).toMatchObject({
      ok: false,
      errors: { reason: "This field is required." },
    });
    const intervention = toChange(
      "intervention_add",
      emptyForm({ problemRef: `problem:${PROBLEM}` }),
    );
    expect(intervention).toMatchObject({
      ok: false,
      errors: {
        scopeText: "This field is required.",
        frequencyText: "This field is required.",
        frequencyValue: "This field is required.",
      },
    });
  });

  it("refuses a goal update that changes nothing, and sends a status-only update", () => {
    expect(toChange("goal_update", emptyForm(), "g-1")).toMatchObject({
      ok: false,
      errors: { revisedText: expect.stringContaining("at least one") },
    });
    expect(toChange("goal_update", emptyForm({ goalStatus: "met" }), "g-1")).toEqual({
      ok: true,
      change: { kind: "goal_update", goalId: "g-1", goalStatus: "met" },
    });
  });

  it("refuses a malformed day and never sends a blank optional field", () => {
    expect(toChange("goal_update", emptyForm({ targetAt: "2026-13-45" }), "g-1")).toMatchObject({
      ok: false,
      errors: { targetAt: "Enter a valid date." },
    });
    const intervention = toChange(
      "intervention_add",
      emptyForm({
        problemRef: `problem:${PROBLEM}`,
        scopeText: "Teach",
        frequencyText: "Weekly",
        frequencyValue: "1",
        responsibleRole: "   ",
      }),
    );
    expect(intervention.ok && "responsibleRole" in intervention.change).toBe(false);
    expect(intervention.ok && "goalRefs" in intervention.change).toBe(false);
  });

  it("links an intervention to the one goal it supports", () => {
    const result = toChange(
      "intervention_add",
      emptyForm({
        problemRef: `problem:${PROBLEM}`,
        scopeText: "Teach",
        frequencyText: "Weekly",
        frequencyValue: "1",
        goalRef: "g-1",
      }),
    );
    expect(result).toMatchObject({ ok: true, change: { goalRefs: ["g-1"] } });
  });
});

describe("formFromProposal", () => {
  it("round-trips a stored goal_add into the same body", () => {
    const stored = proposalView({
      kind: "goal_add",
      change: {
        originalText: "Walk to the mailbox",
        goalSource: "patient_stated",
        measurableOutcome: "Twice a day",
        targetAt: "2026-12-01T00:00:00.000Z",
      },
    });
    const form = formFromProposal(stored);
    expect(form.targetAt).toBe("2026-12-01");
    expect(toChange("goal_add", form)).toEqual({
      ok: true,
      change: {
        kind: "goal_add",
        problemId: PROBLEM,
        originalText: "Walk to the mailbox",
        goalSource: "patient_stated",
        measurableOutcome: "Twice a day",
        targetAt: "2026-12-01T00:00:00.000Z",
      },
    });
  });

  it("keeps a goal under a proposed problem pointing at that proposal", () => {
    const stored = proposalView({
      kind: "goal_add",
      parentProposalId: "prop-1",
      target: { type: "problem", id: null, label: null },
      change: { originalText: "Sleep" },
    });
    expect(formFromProposal(stored).problemRef).toBe("proposal:prop-1");
  });
});

describe("formErrorsFromServer", () => {
  it("maps the server's property names to the form's fields and drops what the form has no field for", () => {
    expect(
      formErrorsFromServer({
        originalText: "too vague",
        problemId: "not a problem of this plan",
        mystery: "x",
      }),
    ).toEqual({ originalText: "too vague", problemRef: "not a problem of this plan" });
  });
});
