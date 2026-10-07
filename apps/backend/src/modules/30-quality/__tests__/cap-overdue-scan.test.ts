// GAP-155 — the CAP-overdue producer: a CAP action item past `dueAt` with no `completedAt` raises the §4.9
// `cap_overdue` alert (every 2 days until completed) and publishes `m30.incident.cap_overdue`.
import { describe, expect, it, vi } from "vitest";
import {
  type CapIncidentRow,
  collectOverdueCapActions,
  runCapOverdueScan,
} from "../jobs/cap-overdue-scan";

const ORG = "11111111-1111-4111-8111-111111111111";
const INC = "22222222-2222-4222-8222-222222222222";
const OWNER_M = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-10-10T09:00:00Z");

const row = (actions: CapIncidentRow["capPlan"]["actions"]): CapIncidentRow => ({
  incidentId: INC,
  capPlan: { actions },
});

describe("collectOverdueCapActions", () => {
  it("returns only incomplete actions whose dueAt has passed, with their index", () => {
    const out = collectOverdueCapActions(
      [
        row([
          {
            action: "a",
            ownerMembershipId: OWNER_M,
            dueAt: "2026-10-01T00:00:00Z",
            completedAt: null,
          },
          {
            action: "b",
            ownerMembershipId: OWNER_M,
            dueAt: "2026-10-01T00:00:00Z",
            completedAt: "2026-10-02T00:00:00Z",
          },
          {
            action: "c",
            ownerMembershipId: OWNER_M,
            dueAt: "2026-11-01T00:00:00Z",
            completedAt: null,
          },
        ]),
      ],
      NOW,
    );
    expect(out).toEqual([
      {
        incidentId: INC,
        actionIndex: 0,
        dueAt: "2026-10-01T00:00:00Z",
        ownerMembershipId: OWNER_M,
      },
    ]);
  });

  it("ignores an unparseable dueAt rather than alerting on garbage", () => {
    expect(
      collectOverdueCapActions(
        [row([{ action: "a", ownerMembershipId: OWNER_M, dueAt: "nope", completedAt: null }])],
        NOW,
      ),
    ).toEqual([]);
  });
});

describe("runCapOverdueScan", () => {
  it("publishes the event and emits one alert per overdue action, deduped per 2-day bucket", async () => {
    const publish = vi.fn(async () => undefined);
    const emit = vi.fn(async () => ({}));
    const result = await runCapOverdueScan({
      listActiveOrgs: async () => [{ organizationId: ORG }],
      scanOrg: async () => [
        { incidentId: INC, actionIndex: 1, dueAt: "2026-10-01T00:00:00Z", ownerUserId: "u1" },
      ],
      publish,
      emit,
      now: () => NOW,
    });
    expect(result).toEqual({ orgs: 1, raised: 1, failedOrgs: 0 });
    expect(publish).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ incidentId: INC, actionIndex: 1, ownerUserId: "u1", orgId: ORG }),
    );
    const [, input] = emit.mock.calls[0] as unknown as [
      string,
      { eventType: string; correlationId: string },
    ];
    expect(input.eventType).toBe("m30.incident.cap_overdue");
    expect(input.correlationId).toMatch(/^m30:cap_overdue:.+:1:\d+$/);
  });

  it("counts a failing org and continues", async () => {
    const warn = vi.fn();
    const result = await runCapOverdueScan({
      listActiveOrgs: async () => [{ organizationId: ORG }, { organizationId: "o2" }],
      scanOrg: async (org) => {
        if (org === ORG) throw new Error("db");
        return [];
      },
      publish: vi.fn(),
      emit: vi.fn(),
      now: () => NOW,
      warn,
    });
    expect(result).toEqual({ orgs: 2, raised: 0, failedOrgs: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
