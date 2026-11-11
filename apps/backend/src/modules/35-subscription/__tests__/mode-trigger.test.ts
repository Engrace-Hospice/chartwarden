// Who a system-made billing mode change is attributed to: the actor that triggered it (an id, never a name) and the request it came in on.
import { describe, expect, it } from "vitest";
import { SYSTEM_TRIGGER, modeTriggerOf } from "../pricing/mode-trigger";

const TENANT_ORG = "11111111-1111-4111-8111-111111111111";
const PLATFORM_ORG = "22222222-2222-4222-8222-222222222222";

describe("modeTriggerOf", () => {
  it("is the tenant when a signed-in request in the target organisation set it off, with its membership and correlation id", () => {
    expect(
      modeTriggerOf(
        {
          organizationId: TENANT_ORG,
          userId: "user-1",
          correlationId: "corr-1",
          attributes: { membershipId: "member-1" },
        },
        TENANT_ORG,
      ),
    ).toEqual({
      kind: "tenant",
      userId: "user-1",
      membershipId: "member-1",
      correlationId: "corr-1",
    });
  });

  it("is the platform when an operator in another organisation (the platform's own) set it off for the tenant", () => {
    expect(
      modeTriggerOf(
        {
          organizationId: PLATFORM_ORG,
          userId: "op-1",
          correlationId: "corr-2",
          attributes: { membershipId: "op-member" },
        },
        TENANT_ORG,
      ),
    ).toMatchObject({
      kind: "platform",
      userId: "op-1",
      membershipId: "op-member",
      correlationId: "corr-2",
    });
  });

  it("is the system outside a request (a sweep), and for a request with no signed-in user, with no person named", () => {
    expect(modeTriggerOf(undefined, TENANT_ORG)).toEqual(SYSTEM_TRIGGER);
    expect(
      modeTriggerOf({ organizationId: "", userId: "", correlationId: "corr-3" }, TENANT_ORG),
    ).toEqual({ kind: "system", userId: null, membershipId: null, correlationId: "corr-3" });
  });

  it("names no membership when the request carries none (never an empty or non-string value)", () => {
    expect(
      modeTriggerOf(
        { organizationId: TENANT_ORG, userId: "user-1", attributes: { membershipId: 7 } },
        TENANT_ORG,
      ).membershipId,
    ).toBeNull();
  });
});
