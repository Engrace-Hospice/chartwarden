// #767: the daily DDE aging alert. Fakes only; the live suite proves the store under RLS.
import { describe, expect, it, vi } from "vitest";
import {
  DDE_AGING_ALERT_CODE,
  runDdeAgingAlert,
} from "../src/modules/23-billing-medicare/jobs/dde-aging-alert";

const NOW = new Date("2026-10-19T13:00:00Z"); // Monday
const item = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  state: "queued" as const,
  deadlineAt: null,
  openedOn: "2026-10-19",
  assigneeMembershipId: null,
  ...over,
});

function setup(itemsByOrg: Record<string, ReturnType<typeof item>[]>) {
  const dispatch = vi.fn(
    async (_input: {
      alertCode: string;
      severity: string;
      organizationId: string;
      payload: Record<string, unknown>;
    }) => undefined,
  );
  const deps = {
    store: { listOpen: async (org: string) => itemsByOrg[org] ?? [] },
    alerts: { dispatch },
    activeOrgs: {
      listActiveOrgs: async () =>
        Object.keys(itemsByOrg).map((organizationId) => ({ organizationId })),
    },
    now: () => NOW,
  };
  return { deps, dispatch };
}

describe("runDdeAgingAlert", () => {
  it("raises one warn alert per org with counts and ids only", async () => {
    const { deps, dispatch } = setup({
      "org-a": [item("a", { openedOn: "2026-10-05" }), item("b", { openedOn: "2026-10-14" })],
    });
    await runDdeAgingAlert(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({
      alertCode: DDE_AGING_ALERT_CODE,
      severity: "warn",
      organizationId: "org-a",
      payload: {
        asOf: "2026-10-19",
        overdueCount: 1,
        unassignedCount: 2,
        overdueItemIds: ["a"],
        unassignedItemIds: ["a", "b"],
      },
    });
  });

  it("raises nothing for an org whose queue is healthy, and keeps orgs separate", async () => {
    const { deps, dispatch } = setup({
      "org-a": [item("fresh")],
      "org-b": [
        item("old", { openedOn: "2026-10-05", assigneeMembershipId: "m1", state: "assigned" }),
      ],
    });
    await runDdeAgingAlert(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ organizationId: "org-b" });
  });

  it("caps the ids in the payload but not the counts", async () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`i${i}`, { openedOn: "2026-10-05" }));
    const { deps, dispatch } = setup({ "org-a": many });
    await runDdeAgingAlert(deps);
    const payload = dispatch.mock.calls[0]?.[0].payload;
    expect(payload?.overdueCount).toBe(30);
    expect(payload?.overdueItemIds).toHaveLength(20);
  });

  it("finishes the other orgs when one fails, then throws", async () => {
    const { deps, dispatch } = setup({
      "org-a": [item("x", { openedOn: "2026-10-05" })],
      "org-b": [item("y", { openedOn: "2026-10-05" })],
    });
    const failing = {
      ...deps,
      store: {
        listOpen: async (org: string) => {
          if (org === "org-a") throw new Error("boom");
          return [item("y", { openedOn: "2026-10-05" })];
        },
      },
    };
    await expect(runDdeAgingAlert(failing)).rejects.toThrow(/org-a/);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
