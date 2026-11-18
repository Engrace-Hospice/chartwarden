// ADR-0113 — the single evaluator the gate, closure-status and the supervisor board share. SQL only finds the member's clocked open
// notes (oldest first); the pure clock decides. The partial-index query itself and RLS are the live suite's.
import { describe, expect, it } from "vitest";
import {
  evaluateMemberClosure,
  evaluateOpenNotes,
} from "../src/modules/08-encounters/closure/closure-reader";
import type { ClosurePolicy } from "../src/modules/08-encounters/closure/policy-service";
import { fakeTx } from "./_closure-fake-tx";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MEMBER = "00000000-0000-4000-8000-0000000000b1";
const NOTE_OLD = "00000000-0000-4000-8000-0000000000e1";
const NOTE_NEW = "00000000-0000-4000-8000-0000000000e2";
const PATIENT = "00000000-0000-4000-8000-0000000000c1";
const OVERRIDE_ID = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const HOUR_MS = 3_600_000;

const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * HOUR_MS);
const note = (id: string, ageHours: number | null, status = "draft") => ({
  id,
  patientId: PATIENT,
  status,
  clockStartedAt: ageHours === null ? null : hoursAgo(ageHours),
});
const policy = (mode: ClosurePolicy["mode"], over: Partial<ClosurePolicy> = {}): ClosurePolicy => ({
  mode,
  thresholdHours: 24,
  enforceFrom: null,
  ...over,
});
const activeOverride = {
  id: OVERRIDE_ID,
  subjectMembershipId: MEMBER,
  grantedByMembershipId: "00000000-0000-4000-8000-0000000000b2",
  obligationKind: "visit_note",
  grantedAt: hoursAgo(1),
  expiresAt: new Date(NOW.getTime() + 3 * HOUR_MS),
  revokedAt: null,
};
const input = (p: ClosurePolicy) => ({
  organizationId: ORG,
  membershipId: MEMBER,
  now: NOW,
  policy: p,
});

describe("evaluateOpenNotes (the pure half)", () => {
  it("decides on the oldest note and counts every note past its deadline", () => {
    const out = evaluateOpenNotes(
      [note(NOTE_OLD, 40), note(NOTE_NEW, 26), note("c", 10)],
      policy("warn"),
      NOW,
    );
    expect(out.encounterId).toBe(NOTE_OLD);
    expect(out.decision.stage).toBe("escalated");
    expect(out.overdueCount).toBe(2);
  });

  it("carries the oldest note's patient and status, and both are null when no note is clocked", () => {
    const withNote = evaluateOpenNotes(
      [note(NOTE_OLD, 40, "finalized"), note(NOTE_NEW, 26)],
      policy("warn"),
      NOW,
    );
    expect(withNote).toMatchObject({ patientId: PATIENT, encounterStatus: "finalized" });

    const none = evaluateOpenNotes([note("legacy", null)], policy("warn"), NOW);
    expect(none).toMatchObject({ encounterId: null, patientId: null, encounterStatus: null });
  });

  it("an un-clocked row (legacy) never counts and never decides", () => {
    const out = evaluateOpenNotes([note("legacy", null)], policy("block"), NOW);
    expect(out.encounterId).toBeNull();
    expect(out.decision).toEqual({
      stage: "ok",
      deadlineAt: null,
      hoursOverdue: 0,
      blockFrom: null,
    });
    expect(out.overdueCount).toBe(0);
  });
});

describe("evaluateMemberClosure", () => {
  it("mode off short-circuits: no note query, clear", async () => {
    const fake = fakeTx([]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("off")));
    expect(out).toMatchObject({
      mode: "off",
      verdict: "clear",
      encounterId: null,
      patientId: null,
      encounterStatus: null,
      overdueCount: 0,
    });
    expect(fake.queriesRun()).toBe(0);
  });

  it("reads the policy itself when the caller did not pass one", async () => {
    const fake = fakeTx([[{ mode: "off", thresholdHours: 12, enforceFrom: null }]]);
    const out = await evaluateMemberClosure(fake.tx, {
      organizationId: ORG,
      membershipId: MEMBER,
      now: NOW,
    });
    expect(out).toMatchObject({ mode: "off", thresholdHours: 12, verdict: "clear" });
    expect(fake.queriesRun()).toBe(1);
  });

  it("no clocked open notes is clear and never looks for an override", async () => {
    const fake = fakeTx([[]]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
    expect(out).toMatchObject({
      verdict: "clear",
      encounterId: null,
      patientId: null,
      encounterStatus: null,
      overdueCount: 0,
    });
    expect(fake.queriesRun()).toBe(1);
  });

  it("17.99h is clear; 18h is at_risk and still clear; neither looks for an override", async () => {
    for (const [age, stage] of [
      [17.99, "ok"],
      [18, "at_risk"],
    ] as const) {
      const fake = fakeTx([[note(NOTE_OLD, age)]]);
      const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
      expect(out.decision.stage).toBe(stage);
      expect(out.verdict).toBe("clear");
      expect(out.encounterId).toBe(NOTE_OLD);
      expect(fake.queriesRun()).toBe(1);
    }
  });

  it("warn mode warns once overdue and never consults overrides", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 24)]]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("warn")));
    expect(out.verdict).toBe("warn");
    expect(out.overdueCount).toBe(1);
    expect(fake.queriesRun()).toBe(1);
  });

  it("block mode blocks at 24h when no override exists (override looked up because overdue)", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 24)], []]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
    expect(out.verdict).toBe("blocked");
    expect(out.encounterId).toBe(NOTE_OLD);
    expect(out.patientId).toBe(PATIENT);
    expect(out.encounterStatus).toBe("draft");
    expect(out.overrideExpiresAt).toBeNull();
    expect(fake.queriesRun()).toBe(2);
  });

  it("block mode blocks an escalated note (36h)", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 36), note(NOTE_NEW, 2)], []]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
    expect(out.verdict).toBe("blocked");
    expect(out.decision.stage).toBe("escalated");
    expect(out.overdueCount).toBe(1);
  });

  it("an active supervisor override lifts the block to a warning and reports its expiry", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 30)], [activeOverride]]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
    expect(out.verdict).toBe("warn");
    expect(out.decision.stage).toBe("overdue");
    expect(out.overrideExpiresAt).toEqual(activeOverride.expiresAt);
  });

  it("an expired override does not lift the block", async () => {
    const expired = { ...activeOverride, expiresAt: new Date(NOW.getTime() - 1) };
    const fake = fakeTx([[note(NOTE_OLD, 30)], [expired]]);
    const out = await evaluateMemberClosure(fake.tx, input(policy("block")));
    expect(out.verdict).toBe("blocked");
  });

  it("the enforce_from grace window delays the block but not the warning", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 30)], []]);
    const out = await evaluateMemberClosure(
      fake.tx,
      input(policy("block", { enforceFrom: hoursAgo(1) })),
    );
    expect(out.decision.stage).toBe("overdue");
    expect(out.verdict).toBe("warn");
  });

  it("blocks once the grace window itself has run a full threshold", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 60)], []]);
    const out = await evaluateMemberClosure(
      fake.tx,
      input(policy("block", { enforceFrom: hoursAgo(24) })),
    );
    expect(out.verdict).toBe("blocked");
  });

  it("honours the tenant threshold (12h)", async () => {
    const fake = fakeTx([[note(NOTE_OLD, 12)], []]);
    const out = await evaluateMemberClosure(
      fake.tx,
      input(policy("block", { thresholdHours: 12 })),
    );
    expect(out).toMatchObject({ verdict: "blocked", thresholdHours: 12 });
  });
});
