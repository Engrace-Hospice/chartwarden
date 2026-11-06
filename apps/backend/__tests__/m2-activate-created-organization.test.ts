// The go-live approval activates the organization (M34 -> M2): only a `created` org is activated; anything else is left alone.
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  type OrganizationLifecycleStatus,
  activateCreatedOrganization,
} from "../src/modules/02-identity/organization-lifecycle";

const ORG = "33333333-3333-4333-8333-333333333333";
const CTX = { reason: "go-live approved", actorUserId: "ops-u", actorMembershipId: "ops-m" };

const writer = (
  status: OrganizationLifecycleStatus | null,
  transition = vi.fn(async () => ({
    status: "active" as const,
    sessionsRevoked: 0,
  })),
) => ({ getStatus: vi.fn(async () => status), transition });

describe("activateCreatedOrganization", () => {
  it("activates a created organization with the operator as the actor", async () => {
    const w = writer("created");
    expect(await activateCreatedOrganization(w, ORG, CTX)).toBe("activated");
    expect(w.transition).toHaveBeenCalledWith(ORG, "activate", CTX);
  });

  it("leaves an already-active, suspended, closed or unknown organization alone", async () => {
    for (const status of ["active", "suspended", "closed", null] as const) {
      const w = writer(status);
      expect(await activateCreatedOrganization(w, ORG, CTX), String(status)).toBe("unchanged");
      expect(w.transition).not.toHaveBeenCalled();
    }
  });

  it("treats a concurrent activation that landed first as success", async () => {
    const w = writer(
      "created",
      vi.fn(async () => {
        throw new ChartWardenError("ILLEGAL_ORGANIZATION_TRANSITION", "already active", 409);
      }),
    );
    expect(await activateCreatedOrganization(w, ORG, CTX)).toBe("unchanged");
  });

  it("propagates any other failure so the approval does not report a live organization that is not", async () => {
    const w = writer(
      "created",
      vi.fn(async () => {
        throw new Error("database unavailable");
      }),
    );
    await expect(activateCreatedOrganization(w, ORG, CTX)).rejects.toThrow(/database unavailable/);
  });
});
