// onboarding → active (§2.4.12 / D11): the guards the platform status route feeds the lifecycle machine's
// `activate` event, computed from the tenant's onboarding tasks and its latest BAA record.
import { describe, expect, it } from "vitest";
import {
  baaTermCoversToday,
  evaluateActivationGuards,
  pickGoverningBaa,
} from "../routes/platform/activation-guards";

const TODAY = new Date("2026-10-13T00:00:00Z");
const canonical = ["account_created", "ccn_registered"];

const executedBaa = (expiresOn: string | null) => ({
  baaStatus: "executed" as const,
  expiresOn,
  documentFiled: true,
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

  it("does not count an executed BAA whose document does not verify: the status rests on a link that proves nothing", () => {
    const input = {
      canonicalTemplateKeys: canonical,
      tasks: [
        { templateKey: "account_created", status: "done" },
        { templateKey: "ccn_registered", status: "done" },
      ],
      today: TODAY,
    };
    const unverified = evaluateActivationGuards({
      ...input,
      latestBaa: { ...executedBaa("2027-12-31"), documentFiled: false },
    });
    expect(unverified).toMatchObject({ baaExecuted: false, baaExpiryClearsNinetyDays: false });
    // a verified document is an executed BAA
    expect(
      evaluateActivationGuards({ ...input, latestBaa: executedBaa("2027-12-31") }),
    ).toMatchObject({ baaExecuted: true, baaExpiryClearsNinetyDays: true });
  });

  it("an input that does not say whether the document verifies is not an executed BAA (fail closed, as the sweep does)", () => {
    const { documentFiled: _omitted, ...unjudged } = executedBaa("2027-12-31");
    const guards = evaluateActivationGuards({
      canonicalTemplateKeys: canonical,
      tasks: [
        { templateKey: "account_created", status: "done" },
        { templateKey: "ccn_registered", status: "done" },
      ],
      // the type requires the field; a caller that casts its way around it must still fail closed
      latestBaa: unjudged as never,
      today: TODAY,
    });
    expect(guards).toMatchObject({ baaExecuted: false, baaExpiryClearsNinetyDays: false });
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

  it("ignores the tasks of a non-canonical catalog step (added by platform ops) when judging completeness and counting", () => {
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
      latestBaa: { baaStatus: "pending", expiresOn: null, documentFiled: true },
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

// BaaRegisterRepository lists `ORDER BY executed_on DESC`, and Postgres sorts NULLs first on DESC, so a pending
// renewal (no executed_on) used to shadow the executed BAA and block activation with BAA_NOT_EXECUTED.
describe("the BAA's term must cover today, not only be filed (CW-AC-14, CW-AC-17)", () => {
  const input = {
    canonicalTemplateKeys: canonical,
    tasks: [
      { templateKey: "account_created", status: "done" },
      { templateKey: "ccn_registered", status: "done" },
    ],
  };
  const baaOn = (over: { effectiveOn?: string | null; expiresOn: string | null }) => ({
    ...executedBaa(over.expiresOn),
    effectiveOn: over.effectiveOn,
  });
  const at = (iso: string) => new Date(`${iso}T15:30:00Z`);

  it("is not executed while the effective date is still ahead, and is executed on that very day", () => {
    const baa = baaOn({ effectiveOn: "2026-10-14", expiresOn: "2028-10-14" });
    expect(
      evaluateActivationGuards({ ...input, latestBaa: baa, today: at("2026-10-13") }),
    ).toMatchObject({ baaExecuted: false, baaExpiryClearsNinetyDays: false });
    expect(
      evaluateActivationGuards({ ...input, latestBaa: baa, today: at("2026-10-14") }),
    ).toMatchObject({ baaExecuted: true, baaExpiryClearsNinetyDays: true });
  });

  it("is not executed once the last day in force has passed (it was counted executed after it before)", () => {
    const baa = baaOn({ effectiveOn: "2025-10-14", expiresOn: "2026-10-14" });
    expect(
      evaluateActivationGuards({ ...input, latestBaa: baa, today: at("2026-10-14") }).baaExecuted,
    ).toBe(true);
    expect(
      evaluateActivationGuards({ ...input, latestBaa: baa, today: at("2026-10-15") }),
    ).toMatchObject({ baaExecuted: false, baaExpiryClearsNinetyDays: false });
  });

  it("does not block a row that records no effective date (a row written before the date was kept)", () => {
    expect(
      evaluateActivationGuards({
        ...input,
        latestBaa: baaOn({ effectiveOn: null, expiresOn: null }),
        today: at("2026-10-13"),
      }),
    ).toMatchObject({ baaExecuted: true });
    expect(
      evaluateActivationGuards({
        ...input,
        latestBaa: executedBaa("2027-12-31"),
        today: at("2026-10-13"),
      }).baaExecuted,
    ).toBe(true);
  });

  it("states the rule as a pure helper", () => {
    expect(
      baaTermCoversToday({ effectiveOn: "2026-01-01", expiresOn: "2026-12-31" }, at("2026-06-01")),
    ).toBe(true);
    expect(baaTermCoversToday({ effectiveOn: null, expiresOn: null }, at("2099-01-01"))).toBe(true);
    expect(baaTermCoversToday({ expiresOn: "2026-12-31" }, at("2027-01-01"))).toBe(false);
  });
});

describe("pickGoverningBaa", () => {
  const row = (baaStatus: string, executedOn: string | null) => ({
    baaStatus,
    executedOn,
    expiresOn: null,
  });

  it("prefers the newest executed BAA over a pending row that sorts first", () => {
    const picked = pickGoverningBaa([
      row("pending", null),
      row("executed", "2025-01-01"),
      row("executed", "2026-01-01"),
    ]);

    expect(picked).toEqual(row("executed", "2026-01-01"));
  });

  it("never governs with a non-executed row when none is executed, so the guard still fails closed", () => {
    const picked = pickGoverningBaa([row("pending", null), row("terminated", "2020-01-01")]);

    expect(picked?.baaStatus).not.toBe("executed");
  });

  it("is undefined for a tenant with no BAA", () => {
    expect(pickGoverningBaa([])).toBeUndefined();
  });
});

// Fail-open cases a review found: a guard that can pass vacuously or past a newer terminated BAA is not a guard.
describe("activation guards fail closed", () => {
  it("is not complete when the tenant has no canonical onboarding templates at all (unseeded catalog)", () => {
    const guards = evaluateActivationGuards({
      canonicalTemplateKeys: [],
      tasks: [],
      latestBaa: { baaStatus: "executed", expiresOn: null, documentFiled: true },
      today: new Date("2026-10-13T00:00:00Z"),
    });

    expect(guards.canonicalTasksComplete).toBe(false);
  });

  it("a BAA terminated after an executed one governs, so activation is refused", () => {
    const picked = pickGoverningBaa([
      { baaStatus: "terminated", executedOn: "2026-06-01", expiresOn: null },
      { baaStatus: "executed", executedOn: "2025-01-01", expiresOn: null },
    ]);

    expect(picked?.baaStatus).toBe("terminated");
  });

  it("a terminated BAA with no executed date still blocks, even beside an executed one", () => {
    const picked = pickGoverningBaa([
      { baaStatus: "executed", executedOn: "2025-01-01", expiresOn: null },
      { baaStatus: "terminated", executedOn: null, expiresOn: null },
    ]);

    expect(picked?.baaStatus).toBe("terminated");
  });
});
