// The strict-sequence rule: a step may only be started, completed or attested when every earlier gating step is done
// or skipped. Pure - no store.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import type { StepTask, StepTemplate, TaskStatus } from "../onboarding/model";
import {
  assertStepActionable,
  currentStepKey,
  gatingTemplateKeys,
  lockedByStep,
  orderedTemplates,
} from "../onboarding/sequence";

const tpl = (key: string, sequence: number, over: Partial<StepTemplate> = {}): StepTemplate => ({
  key,
  title: key,
  description: "",
  sequence,
  owner: "platform_ops",
  completionMode: "attestation",
  optional: false,
  canonical: true,
  ...over,
});

const task = (templateKey: string, status: TaskStatus): StepTask => ({
  id: `task-${templateKey}`,
  templateKey,
  status,
  assignedToMembershipId: null,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  dueAt: null,
  startedAt: null,
  completedAt: null,
  blockerReason: null,
  evidenceNote: null,
  evidenceRef: null,
  attestedByMembershipId: null,
  attestedByActorKind: null,
  attestedAt: null,
  skipRationale: null,
});

const TEMPLATES = [
  tpl("c", 3),
  tpl("a", 1),
  tpl("opt", 2, { optional: true }),
  tpl("b", 2.5 as number),
  tpl("extra", 100, { canonical: false }),
];

describe("orderedTemplates", () => {
  it("sorts by sequence regardless of input order", () => {
    expect(orderedTemplates(TEMPLATES).map((t) => t.key)).toEqual(["a", "opt", "b", "c", "extra"]);
  });
});

describe("gatingTemplateKeys", () => {
  it("is the canonical, non-optional templates: optional and tenant-added steps never gate", () => {
    expect(gatingTemplateKeys(TEMPLATES)).toEqual(["a", "b", "c"]);
  });
});

describe("lockedByStep", () => {
  const tasks = [task("a", "done"), task("b", "pending"), task("c", "pending")];

  it("names the first earlier gating step that is not settled", () => {
    expect(lockedByStep(TEMPLATES, tasks, "c")).toBe("b");
  });

  it("does not lock the first unsettled step or any settled one", () => {
    expect(lockedByStep(TEMPLATES, tasks, "b")).toBeNull();
    expect(lockedByStep(TEMPLATES, tasks, "a")).toBeNull();
  });

  it("treats done and skipped as settled, blocked and in_progress as not", () => {
    const skipped = [task("a", "skipped"), task("b", "done"), task("c", "pending")];
    expect(lockedByStep(TEMPLATES, skipped, "c")).toBeNull();
    const blocked = [task("a", "blocked"), task("b", "pending"), task("c", "pending")];
    expect(lockedByStep(TEMPLATES, blocked, "c")).toBe("a");
    const open = [task("a", "in_progress"), task("b", "pending"), task("c", "pending")];
    expect(lockedByStep(TEMPLATES, open, "b")).toBe("a");
  });

  it("an unsettled optional step does not lock later steps", () => {
    const t = [task("a", "done"), task("opt", "pending"), task("b", "pending")];
    expect(lockedByStep(TEMPLATES, t, "b")).toBeNull();
  });

  it("a gating step with no task row is unsettled", () => {
    expect(lockedByStep(TEMPLATES, [task("a", "done"), task("c", "pending")], "c")).toBe("b");
  });

  it("a tenant-added step is locked by unsettled gating steps but never locks one", () => {
    const t = [
      task("a", "done"),
      task("b", "done"),
      task("c", "pending"),
      task("extra", "pending"),
    ];
    expect(lockedByStep(TEMPLATES, t, "extra")).toBe("c");
    const early = [tpl("a", 1), tpl("x", 2, { canonical: false }), tpl("c", 3)];
    const e = [task("a", "done"), task("x", "pending"), task("c", "pending")];
    expect(lockedByStep(early, e, "c")).toBeNull();
  });
});

describe("currentStepKey", () => {
  it("is the first unsettled gating step", () => {
    const tasks = [task("a", "done"), task("b", "pending"), task("c", "pending")];
    expect(currentStepKey(TEMPLATES, tasks)).toBe("b");
  });

  it("is null once every gating step is settled", () => {
    const tasks = [task("a", "done"), task("b", "skipped"), task("c", "done")];
    expect(currentStepKey(TEMPLATES, tasks)).toBeNull();
  });
});

describe("assertStepActionable", () => {
  const tasks = [task("a", "pending"), task("b", "pending"), task("c", "pending")];

  it("passes for the current step", () => {
    expect(() => assertStepActionable(TEMPLATES, tasks, "a")).not.toThrow();
  });

  it("refuses an out-of-order step with a typed 409 naming the blocking step", () => {
    try {
      assertStepActionable(TEMPLATES, tasks, "c");
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ChartWardenError);
      const err = e as ChartWardenError;
      expect(err.code).toBe("ONBOARDING_STEP_OUT_OF_ORDER");
      expect(err.statusCode).toBe(409);
      expect(err.message).toContain("a");
      expect(err.details?.[0]).toMatchObject({ field: "templateKey", code: "a" });
    }
  });
});
