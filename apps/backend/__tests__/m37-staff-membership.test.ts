// GAP-169 — m37.ipu.staff_member: the allow / deny rule (pure; the DB shell is covered live).
import { describe, expect, it } from "vitest";
import {
  type RosterEntry,
  STAFF_HANDOVER_GRACE_MS,
  STAFF_ROSTER_WINDOW_MS,
  decideIpuStaffMembership,
  hasIpuOrgWideRole,
} from "../src/modules/37-ipu/routes/staff-membership";

const NOW = new Date("2026-10-06T12:00:00Z");
const H = 3_600_000;
const ME = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

const shift = (membershipId: string, startOffsetH: number, lengthH = 8): RosterEntry => ({
  membershipId,
  shiftStartAt: new Date(NOW.getTime() + startOffsetH * H),
  shiftEndAt: new Date(NOW.getTime() + (startOffsetH + lengthH) * H),
});

const decide = (roles: string[], membershipId: string | null, roster: RosterEntry[]) =>
  decideIpuStaffMembership({ roles, membershipId, roster, now: NOW });

describe("m37.ipu.staff_member (GAP-169)", () => {
  it("allows an org-wide authority role without any roster entry", () => {
    expect(decide(["medical_director"], null, [shift(OTHER, -1)])).toEqual({
      allowed: true,
      basis: "org_wide_role",
    });
    expect(hasIpuOrgWideRole(["org_admin"])).toBe(true);
    expect(hasIpuOrgWideRole(["clinical_rn"])).toBe(false);
  });

  it("allows a clinician whose shift covers now", () => {
    expect(decide([], ME, [shift(ME, -2), shift(OTHER, -2)])).toEqual({
      allowed: true,
      basis: "on_shift",
    });
  });

  it("allows the outgoing and incoming nurse inside the handover grace", () => {
    const ended = shift(ME, -8 - 10); // ended 10h ago, within the 12h grace
    const upcoming = shift(ME, 10); // starts in 10h
    expect(decide([], ME, [ended, shift(OTHER, -1)]).basis).toBe("on_shift");
    expect(decide([], ME, [upcoming, shift(OTHER, -1)]).basis).toBe("on_shift");
    expect(STAFF_HANDOVER_GRACE_MS).toBe(12 * H);
  });

  it("allows active unit staff outside any live shift (roster window), not only on shift", () => {
    const lastWeek = shift(ME, -7 * 24);
    const decision = decide([], ME, [lastWeek, shift(OTHER, -1)]);
    expect(decision).toEqual({ allowed: true, basis: "unit_roster" });
    expect(STAFF_ROSTER_WINDOW_MS).toBe(30 * 24 * H);
  });

  it("denies an off-unit clinician when the unit has a built roster", () => {
    expect(decide(["clinical_rn"], ME, [shift(OTHER, -1)])).toEqual({
      allowed: false,
      basis: "denied",
    });
  });

  it("denies a read actor with no membership id when the roster is built", () => {
    expect(decide([], null, [shift(OTHER, -1)]).allowed).toBe(false);
  });

  it("does not lock every clinician out of a unit whose roster was never built", () => {
    expect(decide(["clinical_rn"], ME, [])).toEqual({ allowed: true, basis: "roster_unbuilt" });
  });
});
