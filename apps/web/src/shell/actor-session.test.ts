// apps/web/src/shell — actor-session mapping + nav gating tests (FB-T15). Pure functions, so
// they run in the node test env without React/DOM. Proves the shell reflects (never invents)
// the server-resolved roles/permissions: role-scoped tiles, fail-open when the set is unknown.
import { describe, expect, it } from "vitest";
import {
  type ActorContextResponse,
  canSeeScreen,
  guardChromedRoute,
  needsOrgSelection,
  toSession,
} from "./actor-session";
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

describe("needsOrgSelection — shell pre-org guard", () => {
  it("is true for a resolved session with no bound org (post-login, pre-select)", () => {
    const preOrg = toSession({
      userId: "u_2",
      organizationId: null,
      organizationName: null,
      membershipId: null,
      displayName: null,
      roles: [],
      isAdmin: false,
      permissions: [],
    });
    expect(needsOrgSelection(preOrg)).toBe(true);
  });

  it("is false for a bound session (has an organizationId)", () => {
    expect(needsOrgSelection(toSession(ORG_BOUND))).toBe(false);
  });

  it("is false while loading or signed out (null) — no redirect, no flicker", () => {
    expect(needsOrgSelection(null)).toBe(false);
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

  it("when the permission set is unknown (no session yet) gated screens FAIL CLOSED — hidden (audit #6)", () => {
    expect(canSeeScreen({ requiredPermission: "audit.read" }, null)).toBe(false);
    const noPerms: Session = { userId: "u", organizationId: "org_a" };
    expect(canSeeScreen({ requiredPermission: "audit.read" }, noPerms)).toBe(false);
  });

  it("the 'Platform' navGroup stays hidden from an org-scoped actor even holding the RBAC key (live-browser audit #2)", () => {
    // Mirrors a real org Administrator: RBAC grants tenant.list_platform at their own org, but
    // the underlying route also enforces the platform_ops-only ABAC predicate — the nav must not
    // advertise a section that 403s for every non-platform-ops actor.
    expect(
      canSeeScreen({ navGroup: "Platform", requiredPermission: "tenant.list_platform" }, session),
    ).toBe(false);
  });

  it("the 'Platform' navGroup shows once the actor holds the platform_ops role AND the permission key", () => {
    const platformOps: Session = toSession({
      ...ORG_BOUND,
      roles: ["platform_ops"],
      permissions: ["tenant.list_platform"],
    });
    expect(
      canSeeScreen(
        { navGroup: "Platform", requiredPermission: "tenant.list_platform" },
        platformOps,
      ),
    ).toBe(true);
  });

  it("holding platform_ops alone doesn't bypass a missing permission key", () => {
    const platformOpsNoPerm: Session = toSession({ ...ORG_BOUND, roles: ["platform_ops"] });
    expect(
      canSeeScreen(
        { navGroup: "Platform", requiredPermission: "tenant.list_platform" },
        platformOpsNoPerm,
      ),
    ).toBe(false);
  });
});

describe("guardChromedRoute — chromed-route session guard (audit #6)", () => {
  it("shows a spinner while the session is loading (no chrome flash, no premature redirect)", () => {
    expect(guardChromedRoute("loading")).toBe("loading");
  });

  it("redirects an anonymous actor to sign-in", () => {
    expect(guardChromedRoute("anonymous")).toBe("redirect");
  });

  it("allows an authenticated actor into the app frame", () => {
    expect(guardChromedRoute("authenticated")).toBe("allow");
  });

  it("shows the offline page for an outage — never forces a sign-out (TASK-033 / FLOW-004)", () => {
    expect(guardChromedRoute("outage")).toBe("outage");
  });
});
