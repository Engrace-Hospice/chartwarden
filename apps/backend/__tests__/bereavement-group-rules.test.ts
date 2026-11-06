// ADR-0109 D10 (PR 3) — the pure support-group rules: the recurring schedule across DST, its validation, the `bereavement_group_scope`
// decision (volunteers run only, behind the 418.78 gates; fail closed) and the program-family rule groups and memorials share.
import { describe, expect, it } from "vitest";
import {
  type BereavementGroupFacilitationFacts,
  decideGroupScope,
} from "../src/modules/16-bereavement/abac-predicates";
import {
  materializeSessions,
  recurrenceProblem,
  wallTimeToUtc,
} from "../src/modules/16-bereavement/groups/recurrence";
import { isProgramFamily } from "../src/modules/16-bereavement/program/program-contacts";

const ORG = "00000000-0000-4000-8000-000000000001";
const STAFF = "00000000-0000-4000-8000-0000000000a1";
const VOLUNTEER = "00000000-0000-4000-8000-0000000000b1";
const OTHER = "00000000-0000-4000-8000-0000000000c1";

describe("recurring sessions keep their local wall time across DST", () => {
  it("a weekly 6pm New York group moves from 22:00Z to 23:00Z when DST ends", () => {
    const sessions = materializeSessions(
      {
        firstDate: "2026-10-27",
        startTime: "18:00",
        durationMinutes: 90,
        intervalWeeks: 1,
        count: 3,
      },
      "America/New_York",
    );
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-10-27T22:00:00.000Z",
      "2026-11-03T23:00:00.000Z",
      "2026-11-10T23:00:00.000Z",
    ]);
    expect(sessions.map((s) => s.sessionNo)).toEqual([1, 2, 3]);
    expect(sessions[0]?.endsAt.toISOString()).toBe("2026-10-27T23:30:00.000Z");
  });

  it("spring-forward: a fortnightly group crosses the March change at the same local hour", () => {
    const sessions = materializeSessions(
      {
        firstDate: "2026-03-01",
        startTime: "10:00",
        durationMinutes: 60,
        intervalWeeks: 2,
        count: 2,
      },
      "America/Chicago",
    );
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      "2026-03-01T16:00:00.000Z",
      "2026-03-15T15:00:00.000Z",
    ]);
  });

  it("a wall time skipped by spring-forward lands after the transition; an ambiguous one on its first occurrence", () => {
    expect(wallTimeToUtc("2026-03-08", "02:30", "America/New_York").toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(wallTimeToUtc("2026-11-01", "01:30", "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("refuses a malformed schedule", () => {
    const ok = {
      firstDate: "2026-12-01",
      startTime: "18:00",
      durationMinutes: 60,
      intervalWeeks: 1,
      count: 8,
    };
    expect(recurrenceProblem(ok, "America/Denver")).toBeNull();
    expect(recurrenceProblem(ok, "Mars/Olympus_Mons")).toMatch(/timezone/);
    expect(recurrenceProblem({ ...ok, firstDate: "2026-02-30" }, "UTC")).toMatch(/calendar/);
    expect(recurrenceProblem({ ...ok, startTime: "24:00" }, "UTC")).toMatch(/startTime/);
    expect(recurrenceProblem({ ...ok, count: 53 }, "UTC")).toMatch(/count/);
    expect(recurrenceProblem({ ...ok, intervalWeeks: 0 }, "UTC")).toMatch(/intervalWeeks/);
    expect(recurrenceProblem({ ...ok, durationMinutes: 10 }, "UTC")).toMatch(/duration/);
  });
});

describe("bereavement_group_scope — who may manage or run a group", () => {
  const staffGroup: BereavementGroupFacilitationFacts = {
    organizationId: ORG,
    groupId: "g1",
    facilitatorKind: "staff",
    facilitatorUserId: STAFF,
    coFacilitatorUserId: null,
  };
  const volunteerGroup: BereavementGroupFacilitationFacts = {
    ...staffGroup,
    facilitatorKind: "volunteer",
    facilitatorUserId: VOLUNTEER,
  };
  const actor = (over: Partial<Parameters<typeof decideGroupScope>[1]> = {}) => ({
    organizationId: ORG,
    membershipId: STAFF,
    hasOversight: false,
    isVolunteer: false,
    volunteerGatesPass: false,
    ...over,
  });

  it("oversight passes both modes, even with no group named (creating one)", () => {
    expect(decideGroupScope(null, actor({ hasOversight: true }), "manage")).toBe(true);
    expect(
      decideGroupScope(staffGroup, actor({ hasOversight: true, membershipId: OTHER }), "run"),
    ).toBe(true);
  });

  it("the staff facilitator manages and runs their group; nobody else does", () => {
    expect(decideGroupScope(staffGroup, actor(), "manage")).toBe(true);
    expect(decideGroupScope(staffGroup, actor(), "run")).toBe(true);
    expect(decideGroupScope(staffGroup, actor({ membershipId: OTHER }), "run")).toBe(false);
    expect(decideGroupScope(null, actor(), "manage")).toBe(false);
  });

  it("a volunteer facilitator runs only, and only while the 418.78 gates pass", () => {
    const v = actor({ membershipId: VOLUNTEER });
    expect(decideGroupScope(volunteerGroup, { ...v, volunteerGatesPass: true }, "run")).toBe(true);
    expect(decideGroupScope(volunteerGroup, { ...v, volunteerGatesPass: false }, "run")).toBe(
      false,
    );
    expect(decideGroupScope(volunteerGroup, { ...v, volunteerGatesPass: true }, "manage")).toBe(
      false,
    );
  });

  it("a volunteer by discipline is held to the volunteer rule even as a co-facilitator", () => {
    const co = { ...staffGroup, coFacilitatorUserId: VOLUNTEER };
    const v = actor({ membershipId: VOLUNTEER, isVolunteer: true });
    expect(decideGroupScope(co, { ...v, volunteerGatesPass: true }, "manage")).toBe(false);
    expect(decideGroupScope(co, { ...v, volunteerGatesPass: true }, "run")).toBe(true);
  });

  it("fails closed on another tenant's group and on a session with no membership", () => {
    expect(decideGroupScope({ ...staffGroup, organizationId: "other" }, actor(), "manage")).toBe(
      false,
    );
    expect(decideGroupScope(staffGroup, actor({ membershipId: null }), "run")).toBe(false);
  });
});

describe("program families only (groups and memorials)", () => {
  it("an active contact on an active plan with no blocking opt-out qualifies", () => {
    expect(
      isProgramFamily({ contactStatus: "active", planStatus: "active", openOptOutKinds: [] }),
    ).toBe(true);
    // stopping mailings or one channel does not take a family out of a group or a memorial
    expect(
      isProgramFamily({
        contactStatus: "active",
        planStatus: "active",
        openOptOutKinds: ["no_mailings", "channel_specific"],
      }),
    ).toBe(true);
  });

  it("a full or paused opt-out, an inactive contact or a closed / paused plan does not", () => {
    for (const k of ["full", "pause_temporarily"]) {
      expect(
        isProgramFamily({ contactStatus: "active", planStatus: "active", openOptOutKinds: [k] }),
      ).toBe(false);
    }
    expect(
      isProgramFamily({ contactStatus: "opted_out", planStatus: "active", openOptOutKinds: [] }),
    ).toBe(false);
    expect(
      isProgramFamily({ contactStatus: "proposed", planStatus: "active", openOptOutKinds: [] }),
    ).toBe(false);
    expect(
      isProgramFamily({
        contactStatus: "active",
        planStatus: "closed_completed",
        openOptOutKinds: [],
      }),
    ).toBe(false);
    expect(
      isProgramFamily({ contactStatus: "active", planStatus: "paused", openOptOutKinds: [] }),
    ).toBe(false);
  });
});
