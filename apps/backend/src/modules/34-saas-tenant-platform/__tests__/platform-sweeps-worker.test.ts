// GAP-163 — the BAA radar, the support-session close sweep and the onboarding fan-out, over injected ports.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  createOnboardingAdvancer,
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
  const candidate = {
    sessionId: "s1",
    organizationId: "o1",
    supportConsentGrantId: "g1",
    tenantAccountId: "t1",
    grantorMembershipId: "m1",
    actorMembershipId: "m2",
    expiresAt: new Date("2026-10-09T00:00:00Z"),
  };
  const serviceDeps = (opts: { closeSessionIfOpen: () => Promise<unknown> }) => {
    const published: { org: string; event: string; payload: Record<string, unknown> }[] = [];
    const events: { organizationId: string; eventKind: string }[] = [];
    return {
      published,
      events,
      deps: {
        now: () => NOW,
        repo: {
          closeSessionIfOpen: opts.closeSessionIfOpen,
          appendSessionEvent: async (e: { organizationId: string; eventKind: string }) => {
            events.push(e);
          },
        } as never,
        members: { userIdOf: async () => null },
        patients: { allBelongToOrganization: async () => false },
        audit: { emitCriticalAudit: async () => undefined },
        outbox: {
          publish: async (event: string, payload: Record<string, unknown>, org: string) => {
            published.push({ org, event, payload });
          },
        },
        alerts: { emitAlert: async () => undefined },
      },
    };
  };

  it("closes an expired open session and routes the outbox event and the ledger row to the grant's organization", async () => {
    const closeSessionIfOpen = vi.fn(async () => ({ id: "s1" }));
    const h = serviceDeps({ closeSessionIfOpen });
    const result = await runSupportSessionCloseCron({
      candidates: [candidate],
      serviceDeps: () => h.deps as never,
    });
    expect(result.closed).toBe(1);
    expect(closeSessionIfOpen).toHaveBeenCalledWith("s1", {
      closedAt: NOW,
      closeReason: "expired",
    });
    expect(h.published).toEqual([
      expect.objectContaining({ org: "o1", event: "m34.support_session.expired" }),
    ]);
    expect(h.published[0]?.payload.closeReason).toBe("expired");
    expect(h.events).toEqual([
      {
        organizationId: "o1",
        eventKind: "session.close",
        occurredAt: NOW,
        actorIp: null,
        supportSessionId: "s1",
        context: { closeReason: "expired" },
      },
    ]);
  });

  it("skips a session a manual close or a revoke already ended", async () => {
    const h = serviceDeps({ closeSessionIfOpen: async () => null });
    const result = await runSupportSessionCloseCron({
      candidates: [candidate],
      serviceDeps: () => h.deps as never,
    });
    expect(result.closed).toBe(0);
    expect(h.published).toEqual([]);
    expect(h.events).toEqual([]);
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

describe("createOnboardingAdvancer", () => {
  it("takes the shared onboarding lock before it reads the tenant's status", async () => {
    const dialect = new PgDialect();
    const steps: string[] = [];
    const chain = { from: () => chain, where: () => chain, limit: async () => [] };
    const tx = {
      execute: async (q: SQL) => {
        steps.push(dialect.sqlToQuery(q).sql);
      },
      select: () => {
        steps.push("select status");
        return chain;
      },
    };
    const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
    const advance = createOnboardingAdvancer({
      db: db as never,
      outbox: { publish: vi.fn() } as never,
      alerts: { emit: vi.fn() } as never,
    });
    await advance({ tenantAccountId: "t1", orgId: "o1" });
    const lock = steps.findIndex((s) => s.includes("pg_advisory_xact_lock_shared"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(steps.indexOf("select status"));
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
