// GAP-163 — the BAA radar, the support-session close sweep and the onboarding fan-out, over injected ports.
import { describe, expect, it, vi } from "vitest";
import {
  buildActivateTenantPort,
  runBaaExpiryCron,
  runOnboardingFanOut,
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

// The onboarding worker publishes `onboarding_completed` and then hands off to `activateTenant`. That hand-off used to
// log "activation left to platform ops" and do nothing, so every tenant stayed in `onboarding`. It now delegates to the
// lifecycle service — but an unmet guard (e.g. the BAA is not executed yet) is a normal "not yet", and a failure must
// never throw into the org transaction that just wrote the completion event and alert.
describe("buildActivateTenantPort", () => {
  const input = {
    tenantAccountId: "t1",
    orgId: "o1",
    tasksCompleted: 9,
    tasksSkipped: 2,
  };

  it("activates through the lifecycle service and stays quiet on success", async () => {
    const activate = vi.fn(async () => ({ activated: true as const }));
    const warn = vi.fn();

    await expect(buildActivateTenantPort(activate, warn)(input)).resolves.toBe("activated");

    expect(activate).toHaveBeenCalledWith({ tenantAccountId: "t1", orgId: "o1" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns with the unmet guard and does not throw, so the sweep simply tries again tomorrow", async () => {
    const activate = vi.fn(async () => ({ activated: false as const, reason: "BAA_NOT_EXECUTED" }));
    const warn = vi.fn();

    await expect(buildActivateTenantPort(activate, warn)(input)).resolves.toBe("pending");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BAA_NOT_EXECUTED"), {
      tenantAccountId: "t1",
      orgId: "o1",
    });
  });

  it("swallows an unexpected failure into a warning rather than rolling back the completion event", async () => {
    const activate = vi.fn(async () => {
      throw new Error("db down");
    });
    const warn = vi.fn();

    await expect(buildActivateTenantPort(activate, warn)(input)).resolves.toBe("pending");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"), {
      tenantAccountId: "t1",
      orgId: "o1",
    });
  });

  it("with no activation bound it says so loudly instead of silently doing nothing", async () => {
    const warn = vi.fn();

    await expect(buildActivateTenantPort(undefined, warn)(input)).resolves.toBe("unbound");

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no activation"), {
      tenantAccountId: "t1",
      orgId: "o1",
    });
  });
});
