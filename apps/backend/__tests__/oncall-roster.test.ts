// apps/backend/__tests__/oncall-roster.test.ts — M19-T04 (§2.2.2 shift machine, §4.5 roster sync, D3, D7,
// §2.7 D-C).
//
// The pure M19 on-call roster — no DB, no clock: every fact is injected. The one seam-touching helper
// (`readOnCallRoster`) IS exercised against the M1 registry, because the degraded-vs-empty distinction it
// preserves is the whole point of §2.7's class D-C and cannot be shown any other way.
import type { OnCallRosterEntry, OncallShiftStatus, VisitAssignmentReader } from "@wardenx/types";
import { afterEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { readOnCallRoster } from "../src/modules/19-oncall/consumers/trigger-context";
import {
  type ExistingOnCallShift,
  type OnCallRosterSyncFacts,
  type OnCallShiftFacts,
  ON_CALL_SHIFT_EDGES,
  ROSTER_SYNC_CANCELLATION_REASON,
  activateShift,
  availableShiftCommands,
  cancelShift,
  completeShift,
  isShiftDueToClose,
  isShiftDueToOpen,
  reconcileOnCallRoster,
  requireRosterDiscipline,
  resolveShiftEdge,
  rosterDiscipline,
  shiftCoversInstant,
} from "../src/modules/19-oncall/roster/index";

const PE = "0a000000-0000-4000-8000-000000000001";
const PE_OTHER = "0a000000-0000-4000-8000-0000000000ff";
const NURSE = "0b000000-0000-4000-8000-000000000002";
const NURSE_2 = "0b000000-0000-4000-8000-000000000003";
const SHIFT = "0c000000-0000-4000-8000-000000000004";
const SHIFT_2 = "0c000000-0000-4000-8000-000000000005";
const VENDOR = "0d000000-0000-4000-8000-000000000006";
const ORG = "0e000000-0000-4000-8000-000000000007";

const POLICY = { escalationTiers: { tier_1_rn_supervisor: ["clin_supv"] }, version: 3 };

const NIGHT_START = "2026-08-01T23:00:00.000Z";
const NIGHT_END = "2026-08-02T07:00:00.000Z";

function shift(over: Partial<OnCallShiftFacts> = {}): OnCallShiftFacts {
  return {
    status: "scheduled",
    version: 1,
    shiftStartsAt: NIGHT_START,
    shiftEndsAt: NIGHT_END,
    discipline: "clinical_rn",
    primaryOnCallMembershipId: NURSE,
    externalActorId: null,
    openedAt: null,
    closedAt: null,
    ...over,
  };
}

function existing(over: Partial<ExistingOnCallShift> = {}): ExistingOnCallShift {
  return { ...shift(), shiftId: SHIFT, providerEntityId: PE, ...over };
}

function syncFacts(over: Partial<OnCallRosterSyncFacts> = {}): OnCallRosterSyncFacts {
  return {
    providerEntityId: PE,
    model: "direct",
    rosterRead: { kind: "roster", entries: [] },
    existingShifts: [],
    policySnapshot: POLICY,
    ...over,
  };
}

function entry(over: Partial<OnCallRosterEntry> = {}): OnCallRosterEntry {
  return {
    membershipId: NURSE,
    discipline: "clinical_rn",
    fromIso: NIGHT_START,
    toIso: NIGHT_END,
    ...over,
  };
}

describe("M19 §2.2.2 — the on-call shift machine", () => {
  it("admits exactly the three §2.2.2 edges", () => {
    expect(ON_CALL_SHIFT_EDGES.map((e) => `${e.from}->${e.command}->${e.to}`)).toEqual([
      "scheduled->activateShift->active",
      "active->completeShift->completed",
      "scheduled->cancelShift->cancelled",
    ]);
  });

  it("refuses every command out of a terminal status", () => {
    for (const status of ["completed", "cancelled"] as const) {
      expect(availableShiftCommands(status)).toEqual([]);
      try {
        resolveShiftEdge(status, "completeShift");
        expect.unreachable("terminal status accepted a command");
      } catch (error) {
        expect((error as { code: string }).code).toBe("SHIFT_TERMINAL");
      }
    }
  });

  it("cancels ONLY from scheduled — an active shift ends as completed, never cancelled", () => {
    // An active shift was real coverage for the hours it ran; §3.3's `m19_on_call_shift_opened_at` CHECK
    // exempts `cancelled` from carrying an `opened_at` precisely because it is the never-opened terminal.
    expect(availableShiftCommands("scheduled").sort()).toEqual(["activateShift", "cancelShift"]);
    expect(availableShiftCommands("active")).toEqual(["completeShift"]);
    try {
      cancelShift({ shift: shift({ status: "active", openedAt: NIGHT_START }), reason: "sick" });
      expect.unreachable("cancelled an active shift");
    } catch (error) {
      expect((error as { code: string }).code).toBe("SHIFT_INVALID_STATE_TRANSITION");
    }
  });

  it("activateShift pins the D7 policy snapshot, stamps opened_at and emits the single canonical topic", () => {
    const t = activateShift({ shift: shift(), policySnapshot: POLICY, at: NIGHT_START });
    expect(t.to).toBe("active");
    expect(t.effects).toEqual([
      { kind: "audit" },
      { kind: "pin_policy_snapshot", snapshot: POLICY },
      { kind: "set_timestamp", field: "opened_at", at: NIGHT_START },
      { kind: "outbox", event: "m19.oncall_shift.activated" },
    ]);
  });

  it("refuses to activate before shift_starts_at — a coverage claim for hours nobody agreed to cover", () => {
    try {
      activateShift({ shift: shift(), policySnapshot: POLICY, at: "2026-08-01T18:00:00.000Z" });
      expect.unreachable("activated early");
    } catch (error) {
      expect((error as { code: string }).code).toBe("SHIFT_NOT_YET_STARTED");
    }
  });

  it("refuses to activate with no policy to pin (D7 survey evidence)", () => {
    try {
      activateShift({ shift: shift(), policySnapshot: null, at: NIGHT_START });
      expect.unreachable("activated with no snapshot");
    } catch (error) {
      expect((error as { code: string }).code).toBe("SHIFT_POLICY_SNAPSHOT_REQUIRED");
    }
  });

  it("ALLOWS an early completeShift — the asymmetry that makes an early-ended night visible as a gap", () => {
    const early = "2026-08-02T03:00:00.000Z";
    const t = completeShift({ shift: shift({ status: "active", openedAt: NIGHT_START }), at: early });
    expect(t.to).toBe("completed");
    expect(t.effects).toEqual([
      { kind: "audit" },
      { kind: "set_timestamp", field: "closed_at", at: early },
      { kind: "outbox", event: "m19.oncall_shift.completed" },
    ]);
  });

  it("cancelShift emits NO outbox event — M36 was never asked to add a member that never activated", () => {
    const t = cancelShift({ shift: shift(), reason: "night covered by the vendor instead" });
    expect(t.to).toBe("cancelled");
    expect(t.effects).toEqual([{ kind: "audit" }]);
  });

  it("cancelShift demands a reason", () => {
    try {
      cancelShift({ shift: shift(), reason: "   " });
      expect.unreachable("cancelled with no reason");
    } catch (error) {
      expect((error as { code: string }).code).toBe("SHIFT_CANCEL_REASON_REQUIRED");
    }
  });

  it("every transition carries the §2.4 M4 audit effect first", () => {
    const transitions = [
      activateShift({ shift: shift(), policySnapshot: POLICY, at: NIGHT_START }),
      completeShift({ shift: shift({ status: "active" }), at: NIGHT_END }),
      cancelShift({ shift: shift(), reason: "r" }),
    ];
    for (const t of transitions) expect(t.effects[0]).toEqual({ kind: "audit" });
  });

  it("the §4.8 cron predicates read shift_starts_at / shift_ends_at against now()", () => {
    expect(isShiftDueToOpen(shift(), NIGHT_START)).toBe(true);
    expect(isShiftDueToOpen(shift(), "2026-08-01T22:59:00.000Z")).toBe(false);
    expect(isShiftDueToOpen(shift({ status: "active" }), NIGHT_START)).toBe(false);
    expect(isShiftDueToClose(shift({ status: "active" }), NIGHT_END)).toBe(true);
    expect(isShiftDueToClose(shift({ status: "active" }), "2026-08-02T06:00:00.000Z")).toBe(false);
    expect(isShiftDueToClose(shift(), NIGHT_END)).toBe(false);
  });

  it("shiftCoversInstant admits `scheduled` — the five-minute cron window is not a coverage gap", () => {
    const at = "2026-08-01T23:02:00.000Z";
    expect(shiftCoversInstant(shift({ status: "scheduled" }), at)).toBe(true);
    expect(shiftCoversInstant(shift({ status: "active" }), at)).toBe(true);
    // A shift closed early has stopped covering, even inside its scheduled window.
    expect(shiftCoversInstant(shift({ status: "completed" }), at)).toBe(false);
    expect(shiftCoversInstant(shift({ status: "cancelled" }), at)).toBe(false);
    // Half-open: the end instant belongs to the next window.
    expect(shiftCoversInstant(shift(), NIGHT_END)).toBe(false);
    expect(shiftCoversInstant(shift(), NIGHT_START)).toBe(true);
  });
});

describe("M19 §4.5 — the M17 discipline vocabulary mapping", () => {
  it("maps both the enum spellings and M17's short clinical forms", () => {
    expect(rosterDiscipline("clinical_rn")).toBe("clinical_rn");
    expect(rosterDiscipline("RN")).toBe("clinical_rn");
    expect(rosterDiscipline(" lpn ")).toBe("clinical_lpn");
    expect(rosterDiscipline("msw")).toBe("msw");
    expect(rosterDiscipline("chaplain")).toBe("chaplain");
    expect(rosterDiscipline("medical_director")).toBe("medical_director");
  });

  it("NEVER maps to `external` — a Direct shift with a vendor actor violates the §3.3 actor CHECK", () => {
    expect(rosterDiscipline("external")).toBeNull();
    expect(rosterDiscipline("vendor")).toBeNull();
  });

  it("returns null rather than defaulting an unknown discipline to clinical_rn", () => {
    // Defaulting would manufacture RN coverage the agency does not have — the exact claim a surveyor
    // checks under CoP 418.100(c)(2).
    expect(rosterDiscipline("home_health_aide")).toBeNull();
    try {
      requireRosterDiscipline("home_health_aide");
      expect.unreachable("unmapped discipline accepted");
    } catch (error) {
      expect((error as { code: string }).code).toBe("ROSTER_DISCIPLINE_UNMAPPED");
    }
  });
});

describe("M19 §4.5 path 1 — reconciling M17's roster into on_call_shift rows", () => {
  it("creates a scheduled shift per roster entry, anchored to the ProviderEntity being synced", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({ rosterRead: { kind: "roster", entries: [entry()] } }),
    );
    expect(plan.degraded).toBe(false);
    expect(plan.creates).toEqual([
      {
        providerEntityId: PE,
        discipline: "clinical_rn",
        primaryOnCallMembershipId: NURSE,
        shiftStartsAt: NIGHT_START,
        shiftEndsAt: NIGHT_END,
        policySnapshot: POLICY,
      },
    ]);
    expect(plan.cancels).toEqual([]);
  });

  it("one roster entry becomes one shift PER ProviderEntity — a nurse covering two CCNs is two facts", () => {
    // M17's roster is org-scoped and names no provider entity; `on_call_shift.provider_entity_id` is NOT
    // NULL because CoP 418.100(c)(2) is a per-CCN obligation.
    const roster = { kind: "roster", entries: [entry()] } as const;
    const a = reconcileOnCallRoster(syncFacts({ providerEntityId: PE, rosterRead: roster }));
    const b = reconcileOnCallRoster(syncFacts({ providerEntityId: PE_OTHER, rosterRead: roster }));
    expect(a.creates[0]?.providerEntityId).toBe(PE);
    expect(b.creates[0]?.providerEntityId).toBe(PE_OTHER);
    expect(a.creates[0]?.primaryOnCallMembershipId).toBe(b.creates[0]?.primaryOnCallMembershipId);
  });

  it("is idempotent (§2.6) — a second pass over an unchanged roster creates and cancels nothing", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        rosterRead: { kind: "roster", entries: [entry()] },
        existingShifts: [existing()],
      }),
    );
    expect(plan.creates).toEqual([]);
    expect(plan.cancels).toEqual([]);
    expect(plan.unchanged).toEqual([SHIFT]);
  });

  it("cancels a scheduled shift the roster no longer names, with a frozen reason token", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        rosterRead: { kind: "roster", entries: [entry({ membershipId: NURSE_2 })] },
        existingShifts: [existing()],
      }),
    );
    expect(plan.cancels).toEqual([{ shiftId: SHIFT, reason: ROSTER_SYNC_CANCELLATION_REASON }]);
    expect(plan.creates.map((c) => c.primaryOnCallMembershipId)).toEqual([NURSE_2]);
  });

  it("NEVER touches an active or completed shift — the sync does not rewrite a night that happened", () => {
    for (const status of ["active", "completed"] as const satisfies readonly OncallShiftStatus[]) {
      const plan = reconcileOnCallRoster(
        syncFacts({
          rosterRead: { kind: "roster", entries: [] },
          existingShifts: [existing({ status, openedAt: NIGHT_START })],
        }),
      );
      expect(plan.cancels).toEqual([]);
      expect(plan.preserved).toContain(SHIFT);
    }
  });

  it("preserves a hybrid tenant's scheduled EXTERNAL shift — M17's roster can never name it", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        model: "hybrid",
        rosterRead: { kind: "roster", entries: [entry()] },
        existingShifts: [
          existing({
            shiftId: SHIFT_2,
            discipline: "external",
            primaryOnCallMembershipId: null,
            externalActorId: VENDOR,
          }),
        ],
      }),
    );
    expect(plan.cancels).toEqual([]);
    expect(plan.preserved).toContain(SHIFT_2);
    expect(plan.creates).toHaveLength(1);
  });

  it("is a no-op for the `centralized` model — the Direct pull would page a nurse never on call", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        model: "centralized",
        rosterRead: { kind: "roster", entries: [entry()] },
        existingShifts: [existing()],
      }),
    );
    expect(plan.creates).toEqual([]);
    expect(plan.cancels).toEqual([]);
    expect(plan.degraded).toBe(false);
    expect(plan.preserved).toEqual([SHIFT]);
  });

  it("§2.7 D-C — an UNREADABLE roster cancels nothing; an EMPTY one does", () => {
    // This pair is the whole reason `OnCallRosterRead` is a union. Collapsed to a bare array, an M17
    // outage would arrive as `[]` and turn an upstream blip into a real coverage gap.
    const unavailable = reconcileOnCallRoster(
      syncFacts({
        rosterRead: { kind: "unavailable", reason: "seam timeout" },
        existingShifts: [existing()],
      }),
    );
    expect(unavailable.degraded).toBe(true);
    expect(unavailable.degradedReason).toBe("seam timeout");
    expect(unavailable.cancels).toEqual([]);
    expect(unavailable.preserved).toEqual([SHIFT]);

    const empty = reconcileOnCallRoster(
      syncFacts({ rosterRead: { kind: "roster", entries: [] }, existingShifts: [existing()] }),
    );
    expect(empty.degraded).toBe(false);
    expect(empty.cancels).toEqual([{ shiftId: SHIFT, reason: ROSTER_SYNC_CANCELLATION_REASON }]);
  });

  it("skips and REPORTS an unmappable discipline or an empty window, never silently dropping it", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        rosterRead: {
          kind: "roster",
          entries: [
            entry({ discipline: "home_health_aide" }),
            entry({ membershipId: NURSE_2, fromIso: NIGHT_END, toIso: NIGHT_END }),
          ],
        },
      }),
    );
    expect(plan.creates).toEqual([]);
    expect(plan.skipped).toEqual([
      { membershipId: NURSE, discipline: "home_health_aide", reason: "discipline_unmapped" },
      { membershipId: NURSE_2, discipline: "clinical_rn", reason: "empty_window" },
    ]);
  });

  it("a same-person, different-window roster entry is a NEW shift, not a mutation of the old one", () => {
    const plan = reconcileOnCallRoster(
      syncFacts({
        rosterRead: {
          kind: "roster",
          entries: [entry({ fromIso: "2026-08-02T23:00:00.000Z", toIso: "2026-08-03T07:00:00.000Z" })],
        },
        existingShifts: [existing()],
      }),
    );
    expect(plan.creates).toHaveLength(1);
    expect(plan.cancels).toEqual([{ shiftId: SHIFT, reason: ROSTER_SYNC_CANCELLATION_REASON }]);
  });
});

describe("M19 §2.7 D-C — readOnCallRoster keeps 'unreadable' apart from 'empty'", () => {
  afterEach(() => {
    __resetSeamsForTest();
  });

  it("returns a roster when M17 answers, even with no entries", async () => {
    registerSeam("VisitAssignmentReader", {
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [],
      currentVisitForClinician: async () => null,
    } satisfies VisitAssignmentReader);
    expect(await readOnCallRoster(ORG, NIGHT_START)).toEqual({ kind: "roster", entries: [] });
  });

  it("returns `unavailable` when the seam throws — including the M1 deny-stub before M17 registers", async () => {
    registerSeam("VisitAssignmentReader", {
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => {
        throw new Error("VisitAssignmentReader is not implemented");
      },
      currentVisitForClinician: async () => null,
    } satisfies VisitAssignmentReader);
    const read = await readOnCallRoster(ORG, NIGHT_START);
    expect(read.kind).toBe("unavailable");
    expect(read.kind === "unavailable" && read.reason).toContain("not implemented");
  });

  it("closes M17's deny-stub: a real roster reaches the reconciler as shift drafts", async () => {
    registerSeam("VisitAssignmentReader", {
      activeVisitsForMembershipOnDate: async () => [],
      tonightsOnCallRoster: async () => [entry()],
      currentVisitForClinician: async () => null,
    } satisfies VisitAssignmentReader);
    const rosterRead = await readOnCallRoster(ORG, NIGHT_START);
    const plan = reconcileOnCallRoster(syncFacts({ rosterRead }));
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]?.primaryOnCallMembershipId).toBe(NURSE);
  });
});
