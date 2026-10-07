// GAP-118 — the daily amendment SLA scan: overdue and due-soon requests are claimed once each (marker stamped by
// the claiming UPDATE), the matching event is published in the same transaction, and one org's failure does not
// stop the others.
import { describe, expect, it, vi } from "vitest";

let currentOrg = "";
const claims: Record<string, Array<Array<{ id: string; patientId: string; slaDueAt: Date }>>> = {};
const sets: Array<Record<string, unknown>> = [];

vi.mock("@wardenx/tenancy", () => ({
  registerPlatformJob: () => {},
  systemOrgContext: (organizationId: string) => ({ organizationId, userId: "" }),
  withOrgContext: async (
    _db: unknown,
    ctx: { organizationId: string },
    fn: (tx: unknown) => Promise<unknown>,
  ) => {
    currentOrg = ctx.organizationId;
    if (currentOrg === "org-bad") throw new Error("boom");
    const queue = [...(claims[currentOrg] ?? [])];
    const tx = {
      update: () => ({
        set: (v: Record<string, unknown>) => {
          sets.push(v);
          return { where: () => ({ returning: async () => queue.shift() ?? [] }) };
        },
      }),
    };
    return fn(tx);
  },
}));

import {
  type AmendmentSlaDeps,
  runAmendmentSlaScan,
} from "../src/modules/05-patient/jobs/amendment-sla-scan";

const due = new Date("2026-10-10T00:00:00.000Z");
const published: Array<{ eventName: string; payload: Record<string, unknown> }> = [];
const deps = (orgs: string[]): AmendmentSlaDeps => ({
  db: {} as never,
  outbox: {
    async publish(_tx, e) {
      published.push({ eventName: e.eventName, payload: e.payload });
    },
  },
  activeOrgs: { listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })) },
  now: () => new Date("2026-10-06T07:00:00.000Z"),
});

describe("m5.amendment_sla_scan", () => {
  it("publishes overdue and due-soon once each and stamps the markers", async () => {
    claims["org-a"] = [
      [{ id: "amd-late", patientId: "p-1", slaDueAt: new Date("2026-10-01T00:00:00.000Z") }],
      [{ id: "amd-soon", patientId: "p-2", slaDueAt: due }],
    ];
    published.length = 0;
    sets.length = 0;
    const counts = await runAmendmentSlaScan(deps(["org-a"]));
    expect(counts).toEqual({ dueSoon: 1, overdue: 1 });
    expect(published.map((p) => [p.eventName, p.payload.amendmentId])).toEqual([
      ["m5.patient.amendment_sla_overdue", "amd-late"],
      ["m5.patient.amendment_sla_due_soon", "amd-soon"],
    ]);
    expect(sets[0]).toHaveProperty("slaOverdueNotifiedAt");
    expect(sets[1]).toHaveProperty("slaDueSoonNotifiedAt");
  });

  it("an already-notified request is not claimed again (empty claim -> no event)", async () => {
    claims["org-a"] = [[], []];
    published.length = 0;
    expect(await runAmendmentSlaScan(deps(["org-a"]))).toEqual({ dueSoon: 0, overdue: 0 });
    expect(published).toEqual([]);
  });

  it("continues past a failing org, then rejects so BullMQ retries", async () => {
    claims["org-a"] = [[{ id: "x", patientId: "p", slaDueAt: due }], []];
    published.length = 0;
    await expect(runAmendmentSlaScan(deps(["org-bad", "org-a"]))).rejects.toThrow(/org-bad: boom/);
    expect(published).toHaveLength(1);
  });
});
