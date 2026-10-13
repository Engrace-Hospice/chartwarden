// onboarding → active (§2.4.12 / D11): the guards the platform status route feeds the lifecycle machine's
// `activate` event, computed from the tenant's onboarding tasks and its latest BAA record.
import { describe, expect, it } from "vitest";
import { evaluateActivationGuards } from "../routes/platform/activation-guards";

const TODAY = new Date("2026-10-13T00:00:00Z");
const canonical = ["account_created", "ccn_registered"];

const executedBaa = (expiresOn: string | null) => ({
  baaStatus: "executed" as const,
  expiresOn,
});

describe("evaluateActivationGuards", () => {
  it("passes when every canonical task is done or skipped and the BAA is executed and far from expiry", () => {
    const guards = evaluateActivationGuards({
      canonicalTemplateKeys: canonical,
      tasks: [
        { templateKey: "account_created", status: "done" },
        { templateKey: "ccn_registered", status: "skipped" },
      ],
      latestBaa: executedBaa("2027-12-31"),
      today: TODAY,
    });

    expect(guards).toEqual({
      canonicalTasksComplete: true,
      baaExecuted: true,
      baaExpiryClearsNinetyDays: true,
      tasksCompleted: 1,
      tasksSkipped: 1,
    });
  });

  it("is incomplete while a canonical task is pending or has no row at all", () => {
    const pending = evaluateActivationGuards({
      canonicalTemplateKeys: canonical,
      tasks: [
        { templateKey: "account_created", status: "done" },
        { templateKey: "ccn_registered", status: "pending" },
      ],
      latestBaa: executedBaa(null),
      today: TODAY,
    });
    const missingRow = evaluateActivationGuards({
      canonicalTemplateKeys: canonical,
      tasks: [{ templateKey: "account_created", status: "done" }],
      latestBaa: executedBaa(null),
      today: TODAY,
    });

    expect(pending.canonicalTasksComplete).toBe(false);
    expect(missingRow.canonicalTasksComplete).toBe(false);
  });

  it("ignores non-canonical tenant-added tasks when judging completeness and counting", () => {
    const guards = evaluateActivationGuards({
      canonicalTemplateKeys: ["account_created"],
      tasks: [
        { templateKey: "account_created", status: "done" },
        { templateKey: "custom_step", status: "pending" },
        { templateKey: "custom_done", status: "done" },
      ],
      latestBaa: executedBaa(null),
      today: TODAY,
    });

    expect(guards.canonicalTasksComplete).toBe(true);
    expect(guards.tasksCompleted).toBe(1);
  });

  it("is not executed when the latest BAA is pending or the tenant has none", () => {
    const pending = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: { baaStatus: "pending", expiresOn: null },
      today: TODAY,
    });
    const none = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: undefined,
      today: TODAY,
    });

    expect(pending.baaExecuted).toBe(false);
    expect(none.baaExecuted).toBe(false);
    expect(none.baaExpiryClearsNinetyDays).toBe(false);
  });

  it("fails the 90-day expiry guard inside the window, passes beyond it and on a null expiry", () => {
    const soon = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: executedBaa("2026-12-01"),
      today: TODAY,
    });
    const exactlyNinety = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: executedBaa("2027-01-11"),
      today: TODAY,
    });
    const beyond = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: executedBaa("2027-01-12"),
      today: TODAY,
    });
    const never = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: executedBaa(null),
      today: TODAY,
    });

    expect(soon.baaExpiryClearsNinetyDays).toBe(false);
    expect(exactlyNinety.baaExpiryClearsNinetyDays).toBe(false);
    expect(beyond.baaExpiryClearsNinetyDays).toBe(true);
    expect(never.baaExpiryClearsNinetyDays).toBe(true);
  });
});
