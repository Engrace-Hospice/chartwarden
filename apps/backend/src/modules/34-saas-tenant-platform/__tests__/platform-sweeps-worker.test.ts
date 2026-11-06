// GAP-163 — the BAA radar, the support-session close sweep and the onboarding fan-out, over injected ports.
import { describe, expect, it, vi } from "vitest";
import {
  describeM34SweepSchedules,
  runBaaExpiryCron,
  runOnboardingFanOut,
  runOrganizationActivationReconcile,
  runSupportSessionCloseCron,
} from "../jobs/platform-sweeps-worker";

const NOW = new Date("2026-10-10T00:00:00Z");

describe("runBaaExpiryCron", () => {
  it("publishes one expiring event per record inside its tier, routed to that record's org", async () => {
    const publish = vi.fn(async () => undefined);
    const result = await runBaaExpiryCron({
      listRecords: async () =>
        [
          {
            tenantAccountId: "t1",
            organizationId: "o1",
            addendumVersion: "v1",
            baaStatus: "executed",
            expiresOn: "2026-10-15",
          },
          {
            tenantAccountId: "t2",
            organizationId: "o2",
            addendumVersion: "v1",
            baaStatus: "executed",
            expiresOn: "2030-01-01",
          },
        ] as never,
      publish,
      now: () => NOW,
    });
    expect(result.fired).toBe(1);
    expect(publish).toHaveBeenCalledWith(
      "o1",
      expect.objectContaining({ tenantAccountId: "t1", tier: "expiring_7d" }),
    );
  });
});

describe("runSupportSessionCloseCron", () => {
  it("closes an expired open session and routes the outbox event to the session's org", async () => {
    const closeSession = vi.fn(async () => undefined);
    const publish = vi.fn(async (_org: string | undefined, _event: string) => undefined);
    const result = await runSupportSessionCloseCron({
      candidates: [
        {
          sessionId: "s1",
          organizationId: "o1",
          supportConsentGrantId: "g1",
          tenantAccountId: "t1",
          grantorMembershipId: "m1",
          actorMembershipId: "m2",
          expiresAt: new Date("2026-10-09T00:00:00Z"),
        },
      ],
      serviceDeps: (orgBySession) => ({
        now: () => NOW,
        repo: {
          findSessionById: async () => ({ id: "s1", closedAt: null }),
          closeSession,
          appendSessionEvent: async () => undefined,
        } as never,
        audit: { emitCriticalAudit: async () => undefined },
        outbox: {
          publish: async (event, payload) => {
            await publish(orgBySession.get(String(payload.sessionId)), event);
          },
        },
        alerts: { emitAlert: async () => undefined },
      }),
    });
    expect(result.closed).toBe(1);
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith("o1", "m34.support_session.expired");
  });
});

describe("runOnboardingFanOut", () => {
  it("advances every onboarding tenant and counts a failing one without stopping", async () => {
    const warn = vi.fn();
    const result = await runOnboardingFanOut({
      listOnboardingTenants: async () => [
        { tenantAccountId: "t1", orgId: "o1" },
        { tenantAccountId: "t2", orgId: "o2" },
      ],
      advance: async (i) => {
        if (i.tenantAccountId === "t1") throw new Error("boom");
        return {} as never;
      },
      warn,
    });
    expect(result).toEqual({ tenants: 2, failed: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("runOrganizationActivationReconcile", () => {
  const pendingA = {
    organizationId: "o1",
    tenantAccountId: "t1",
    approvedByUserId: "ops-u",
    approvedByMembershipId: "ops-m",
  };
  const pendingB = { ...pendingA, organizationId: "o2", tenantAccountId: "t2" };

  it("opens every organization whose tenant went live but whose organization is still `created`, attributed to the approving operator, and records an audit entry", async () => {
    const activate = vi.fn(async () => undefined);
    const recordReconciled = vi.fn(async () => undefined);

    const result = await runOrganizationActivationReconcile({
      listPending: async () => [pendingA, pendingB],
      activate,
      recordReconciled,
    });

    expect(result).toEqual({ pending: 2, activated: 2, failed: 0 });
    expect(activate).toHaveBeenCalledWith({
      organizationId: "o1",
      operatorUserId: "ops-u",
      operatorMembershipId: "ops-m",
      reason: expect.stringContaining("reconcile"),
    });
    expect(recordReconciled).toHaveBeenCalledTimes(2);
    expect(recordReconciled).toHaveBeenCalledWith(pendingA);
  });

  it("a failing organization is counted and logged, never stops the rest, and is not audited as reconciled", async () => {
    const warn = vi.fn();
    const recordReconciled = vi.fn(async () => undefined);
    const result = await runOrganizationActivationReconcile({
      listPending: async () => [pendingA, pendingB],
      activate: async (input) => {
        if (input.organizationId === "o1") throw new Error("organization update unavailable");
      },
      recordReconciled,
      warn,
    });
    expect(result).toEqual({ pending: 2, activated: 1, failed: 1 });
    expect(recordReconciled).toHaveBeenCalledTimes(1);
    expect(recordReconciled).toHaveBeenCalledWith(pendingB);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does nothing when there is nothing to reconcile", async () => {
    const activate = vi.fn();
    expect(
      await runOrganizationActivationReconcile({
        listPending: async () => [],
        activate,
        recordReconciled: vi.fn(),
      }),
    ).toEqual({ pending: 0, activated: 0, failed: 0 });
    expect(activate).not.toHaveBeenCalled();
  });
});

describe("describeM34SweepSchedules", () => {
  it("names the three scheduled sweeps with their cron patterns", () => {
    const lines = describeM34SweepSchedules();
    expect(lines.map((l) => l.sweep)).toEqual([
      "baa_expiry",
      "support_session_close",
      "onboarding_advance",
    ]);
    expect(lines.find((l) => l.sweep === "onboarding_advance")?.cron).toBe("0 6 * * *");
  });
});
