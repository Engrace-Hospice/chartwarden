// apps/web/src/shell — actor-session mapping + nav gating tests (FB-T15). Pure functions, so
// they run in the node test env without React/DOM. Proves the shell reflects (never invents)
// the server-resolved roles/permissions: role-scoped tiles, fail-open when the set is unknown.
import { describe, expect, it } from "vitest";
import { type ActorContextResponse, canSeeScreen, toSession } from "./actor-session";
import type { Session } from "./session";

const ORG_BOUND: ActorContextResponse = {
  userId: "u_1",
  organizationId: "org_a",
  organizationName: "Engrace",
  membershipId: "m_1",
  displayName: "Robin Nightingale",
  roles: ["clinical_rn"],
  isAdmin: false,
  permissions: ["patient.read", "messaging.read"],
};

describe("FB-T15 toSession — maps the live actor context into the shell Session", () => {
  it("carries roles, membership, org name and the effective permission set", () => {
    const s = toSession(ORG_BOUND);
    expect(s).toMatchObject({
      userId: "u_1",
      organizationId: "org_a",
      organizationName: "Engrace",
      membershipId: "m_1",
      displayName: "Robin Nightingale",
      roles: ["clinical_rn"],
      permissions: ["patient.read", "messaging.read"],
      isAdmin: false,
    });
  });

  it("a pre-org context (no org/membership/roles) maps to an empty org id and no membership", () => {
    const s = toSession({
      userId: "u_2",
      organizationId: null,
      organizationName: null,
      membershipId: null,
      displayName: null,
      roles: [],
      isAdmin: false,
      permissions: [],
    });
    expect(s.organizationId).toBe("");
    expect(s.membershipId).toBeUndefined();
    expect(s.displayName).toBeUndefined();
    expect(s.roles).toEqual([]);
  });
});

describe("FB-T15 canSeeScreen — role-scoped nav/tile gating", () => {
  const session: Session = toSession(ORG_BOUND);

  it("an ungated screen is always visible", () => {
    expect(canSeeScreen({}, session)).toBe(true);
    expect(canSeeScreen({}, null)).toBe(true);
  });

  it("a gated screen shows only when the actor holds the key", () => {
    expect(canSeeScreen({ requiredPermission: "patient.read" }, session)).toBe(true);
    expect(canSeeScreen({ requiredPermission: "audit.read" }, session)).toBe(false);
  });

  it("when the permission set is unknown (no session yet) gated screens stay visible — the shell adds no authz", () => {
    expect(canSeeScreen({ requiredPermission: "audit.read" }, null)).toBe(true);
    const noPerms: Session = { userId: "u", organizationId: "org_a" };
    expect(canSeeScreen({ requiredPermission: "audit.read" }, noPerms)).toBe(true);
  });
});
