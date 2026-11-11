// The once-per-window alert for an org with commercial work waiting and no live clearinghouse (CH-4): the quiet window starts only
// after a dispatch that went out, because this alert is the one signal that the org's submissions and acknowledgments are held.
import { ChartWardenError } from "@chartwarden/types";
import { beforeEach, describe, expect, it } from "vitest";
import {
  M41_UNBOUND_WITH_WORK_ALERT,
  type UnboundAlertPort,
  __resetUnboundAlertMemoryForTest,
  reportUnboundWithWork,
} from "./unbound-alert";

const ORG = "11111111-1111-4111-8111-111111111111";
const WINDOW_MS = 6 * 60 * 60_000;
const START = Date.parse("2026-11-09T10:00:00Z");

const input = (now: number) => ({
  organizationId: ORG,
  queue: "m41.submission.drain",
  waiting: 3,
  now: () => now,
});

describe("reportUnboundWithWork", () => {
  beforeEach(() => __resetUnboundAlertMemoryForTest());

  it("alerts once per window after a dispatch that went out", async () => {
    const sent: unknown[] = [];
    const alerts: UnboundAlertPort = { dispatch: async (a) => void sent.push(a) };

    await reportUnboundWithWork({ alerts }, input(START));
    await reportUnboundWithWork({ alerts }, input(START + 60_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ alertCode: M41_UNBOUND_WITH_WORK_ALERT, organizationId: ORG });

    await reportUnboundWithWork({ alerts }, input(START + WINDOW_MS + 1));
    expect(sent).toHaveLength(2);
  });

  it("does NOT start the quiet window when the dispatch throws: the next tick tries again, and never fails the tick", async () => {
    let calls = 0;
    const logs: { event: string; code?: string }[] = [];
    const flaky: UnboundAlertPort = {
      dispatch: async () => {
        calls += 1;
        if (calls === 1) throw new ChartWardenError("ALERT_ROUTER_DOWN", "router down", 503);
      },
    };
    const deps = { alerts: flaky, log: (e: { event: string; code?: string }) => void logs.push(e) };

    await expect(reportUnboundWithWork(deps, input(START))).resolves.toBeUndefined();
    expect(logs).toContainEqual({
      event: "clearinghouse.unbound_alert_failed",
      code: "ALERT_ROUTER_DOWN",
    });

    await reportUnboundWithWork(deps, input(START + 60_000)); // the very next tick, inside the window
    expect(calls).toBe(2);

    await reportUnboundWithWork(deps, input(START + 120_000)); // now the window is running
    expect(calls).toBe(2);
  });
});
