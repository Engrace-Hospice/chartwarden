// The advance worker effects the machine's emits and nothing more: it settles `auto`/`either` steps from facts, leaves
// `attestation` steps to a human, blocks an unmet `auto` step, and NEVER activates a tenant (going live is the
// two-party approval).
import { describe, expect, it, vi } from "vitest";
import type { OnboardingContext } from "../src/onboarding/context";
import type { OnboardingRepository } from "../src/repositories/onboarding";
import {
  type OnboardingAdvancePorts,
  runOnboardingAdvance,
} from "../src/services/onboarding-advance-worker";

const NOW = new Date("2026-10-13T06:00:00Z");

const template = (
  key: string,
  canonicalOrder: number,
  completionMode: string,
  preconditionDsl: string | null,
) => ({
  key,
  preconditionDsl,
  isCanonical: true,
  canonicalOrder,
  completionMode,
  isOptional: false,
});

const task = (templateKey: string, status: string) => ({
  id: `task-${templateKey}`,
  templateKey,
  status,
  dueAt: null,
  blockerReason: null,
  createdAt: NOW,
});

function ports(statuses: Record<string, string>) {
  const publishOutbox = vi.fn(async () => undefined);
  const routeAlert = vi.fn(async () => undefined);
  const updateTaskStatus = vi.fn(async () => undefined);
  const repo = {
    listTemplates: async () => [
      template("attested", 1, "attestation", null),
      template("baa", 2, "auto", "context.baaExecuted == true"),
      template("provisioned", 3, "auto", null),
    ],
    listTasksByTenant: async () =>
      Object.entries(statuses).map(([key, status]) => task(key, status)),
    updateTaskStatus,
  } as unknown as OnboardingRepository;
  const all = {
    repo,
    now: () => NOW,
    gatherContext: async () => ({ baaExecuted: true }) as OnboardingContext,
    publishOutbox,
    routeAlert,
  } satisfies OnboardingAdvancePorts;
  return { all, publishOutbox, routeAlert, updateTaskStatus };
}

const input = { tenantAccountId: "t1", orgId: "o1" };

describe("runOnboardingAdvance", () => {
  it("settles the auto steps behind a finished attestation step, in one pass", async () => {
    const p = ports({ attested: "done", baa: "pending", provisioned: "pending" });

    const report = await runOnboardingAdvance(input, p.all);

    expect(report.completed).toEqual(["baa", "provisioned"]);
    expect(p.updateTaskStatus).toHaveBeenCalledTimes(2);
    expect(p.updateTaskStatus).toHaveBeenCalledWith(
      "task-baa",
      expect.objectContaining({ status: "done", completedAt: NOW }),
    );
  });

  it("leaves an attestation step to a human and settles nothing behind it", async () => {
    const p = ports({ attested: "pending", baa: "pending", provisioned: "pending" });

    const report = await runOnboardingAdvance(input, p.all);

    expect(report.completed).toEqual([]);
    expect(p.updateTaskStatus).not.toHaveBeenCalled();
    expect(report.nextStep).toBe("attested");
  });

  it("completes a fully settled tenant without announcing or activating anything", async () => {
    const p = ports({ attested: "done", baa: "done", provisioned: "done" });

    const report = await runOnboardingAdvance(input, p.all);

    expect(report.nextStep).toBe("__done__");
    expect(p.publishOutbox).not.toHaveBeenCalled();
    expect(p.routeAlert).not.toHaveBeenCalled();
    expect(p.updateTaskStatus).not.toHaveBeenCalled();
  });

  it("blocks an unmet auto step once, publishing the blocked event and alert", async () => {
    const p = ports({ attested: "done", baa: "pending", provisioned: "pending" });
    p.all.gatherContext = async () => ({ baaExecuted: false }) as OnboardingContext;

    const report = await runOnboardingAdvance(input, p.all);

    expect(report.blocked).toEqual(["baa"]);
    expect(p.updateTaskStatus).toHaveBeenCalledWith(
      "task-baa",
      expect.objectContaining({ status: "blocked" }),
    );
    expect(p.publishOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ event: "m34.tenant.onboarding_step_blocked" }),
    );
    expect(p.routeAlert).toHaveBeenCalledWith(
      expect.objectContaining({ alertKey: "tenant.onboarding_step_blocked" }),
    );
  });
});
