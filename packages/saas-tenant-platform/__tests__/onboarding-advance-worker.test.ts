// "Completed" is announced once the tenant is active (or when ops must activate by hand), never while a guard refuses:
// otherwise every daily pass re-publishes the event and alert for a tenant that stays in `onboarding`.
import { describe, expect, it, vi } from "vitest";
import type { OnboardingContext } from "../src/onboarding/context";
import type { OnboardingRepository } from "../src/repositories/onboarding";
import {
  type ActivationOutcome,
  type OnboardingAdvancePorts,
  runOnboardingAdvance,
} from "../src/services/onboarding-advance-worker";

const NOW = new Date("2026-10-13T06:00:00Z");

function ports(outcome: ActivationOutcome) {
  const publishOutbox = vi.fn(async () => undefined);
  const routeAlert = vi.fn(async () => undefined);
  const activateTenant = vi.fn(async () => outcome);
  const repo = {
    listTemplates: async () => [
      { key: "account_created", preconditionDsl: null, isCanonical: true, canonicalOrder: 1 },
    ],
    listTasksByTenant: async () => [
      {
        id: "k1",
        templateKey: "account_created",
        status: "done",
        dueAt: null,
        blockerReason: null,
        createdAt: NOW,
      },
    ],
    updateTaskStatus: async () => undefined,
  } as unknown as OnboardingRepository;
  const all = {
    repo,
    now: () => NOW,
    gatherContext: async () => ({}) as OnboardingContext,
    publishOutbox,
    routeAlert,
    activateTenant,
  } satisfies OnboardingAdvancePorts;
  return { all, publishOutbox, routeAlert, activateTenant };
}

const input = { tenantAccountId: "t1", orgId: "o1" };

describe("runOnboardingAdvance completion", () => {
  it("publishes the event but not a second alert once the lifecycle service activated the tenant", async () => {
    const p = ports("activated");

    await runOnboardingAdvance(input, p.all);

    expect(p.publishOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ event: "m34.tenant.onboarding_completed" }),
    );
    expect(p.routeAlert).not.toHaveBeenCalled();
  });

  it("announces nothing while activation is refused, so tomorrow's pass is not a repeat", async () => {
    const p = ports("pending");

    await runOnboardingAdvance(input, p.all);

    expect(p.publishOutbox).not.toHaveBeenCalled();
    expect(p.routeAlert).not.toHaveBeenCalled();
  });

  it("raises the alert itself when no automatic activation is bound, so ops knows to activate", async () => {
    const p = ports("unbound");

    await runOnboardingAdvance(input, p.all);

    expect(p.publishOutbox).toHaveBeenCalled();
    expect(p.routeAlert).toHaveBeenCalledWith({
      alertKey: "tenant.onboarding_completed",
      tenantAccountId: "t1",
    });
  });
});
