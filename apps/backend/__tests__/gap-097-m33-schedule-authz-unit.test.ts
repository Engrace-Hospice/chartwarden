// GAP-097 — pure authorization helpers for report schedules + the worker's per-recipient view check.
import { describe, expect, it } from "vitest";
import {
  canMutateSchedule,
  canReadSchedule,
  isScheduleAdmin,
  viewVisibleTo,
} from "../src/modules/33-reporting/routes/schedule-authz";

const schedule = { ownerMembershipId: "m-owner", recipientMembershipIds: ["m-recip"] };
const actor = (membershipId: string, roles: string[] = []) => ({ membershipId, roles });

describe("schedule authz helpers", () => {
  it("only org_admin is a schedule admin", () => {
    expect(isScheduleAdmin(["org_admin"])).toBe(true);
    expect(isScheduleAdmin(["supervisor", "compliance_officer"])).toBe(false);
  });
  it("mutation: owner or admin only", () => {
    expect(canMutateSchedule(actor("m-owner"), schedule)).toBe(true);
    expect(canMutateSchedule(actor("m-x", ["org_admin"]), schedule)).toBe(true);
    expect(canMutateSchedule(actor("m-recip"), schedule)).toBe(false);
    expect(canMutateSchedule(actor("m-x"), schedule)).toBe(false);
  });
  it("read: owner, recipient or admin", () => {
    expect(canReadSchedule(actor("m-recip"), schedule)).toBe(true);
    expect(canReadSchedule(actor("m-x"), schedule)).toBe(false);
  });
  it("view visibility ladder: owner / org / shared role / private", () => {
    const base = { ownerMembershipId: "m-owner", shareRoleKeys: [] as string[] };
    expect(viewVisibleTo({ ...base, shareScope: "private" }, actor("m-owner"))).toBe(true);
    expect(viewVisibleTo({ ...base, shareScope: "private" }, actor("m-x"))).toBe(false);
    expect(viewVisibleTo({ ...base, shareScope: "org" }, actor("m-x"))).toBe(true);
    expect(
      viewVisibleTo(
        { ...base, shareScope: "role", shareRoleKeys: ["nurse"] },
        actor("m-x", ["nurse"]),
      ),
    ).toBe(true);
    expect(
      viewVisibleTo(
        { ...base, shareScope: "role", shareRoleKeys: ["nurse"] },
        actor("m-x", ["md"]),
      ),
    ).toBe(false);
  });
});

import {
  snapshotRecipientAllowed,
  snapshotScopeKind,
} from "../src/modules/33-reporting/routes/schedule-authz";

describe("snapshot recipient scope rule (M33 recipient-disclosure follow-up)", () => {
  it("scope is org only when the owner is an org admin", () => {
    expect(snapshotScopeKind(true)).toBe("org");
    expect(snapshotScopeKind(false)).toBe("self");
  });
  const facts = (over: Partial<Parameters<typeof snapshotRecipientAllowed>[0]>) => ({
    scopeKind: "org" as const,
    ownerMembershipId: "m-owner",
    recipientMembershipId: "m-r",
    recipientIsAdmin: false,
    ...over,
  });
  it("org scope: only org_admin recipients", () => {
    expect(snapshotRecipientAllowed(facts({ recipientIsAdmin: true }))).toBe(true);
    expect(snapshotRecipientAllowed(facts({}))).toBe(false);
    expect(snapshotRecipientAllowed(facts({ recipientMembershipId: "m-owner" }))).toBe(false);
  });
  it("self scope: the owner or an org_admin", () => {
    expect(
      snapshotRecipientAllowed(facts({ scopeKind: "self", recipientMembershipId: "m-owner" })),
    ).toBe(true);
    expect(snapshotRecipientAllowed(facts({ scopeKind: "self", recipientIsAdmin: true }))).toBe(
      true,
    );
    expect(snapshotRecipientAllowed(facts({ scopeKind: "self" }))).toBe(false);
  });
});
