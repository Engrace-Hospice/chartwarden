/**
 * Review of slice 4, M3. `arch:outbox-bindings` proves a consumer exists in a builder file, not that the composition root calls the
 * builder, and a unit test of the tracker proves nothing about which tracker production gets. Both facts about the root are pinned here,
 * so a refactor that drops the M36 binding (the events go back to paging nobody) or swaps the shared episode memory for the in-memory one
 * (a restart or a second replica alerts again, and a recovery is lost) fails a test and not just a review.
 */
import { describe, expect, it } from "vitest";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/events-by-m12";
import { M36_DOSESPOT_ALERT_EVENT_TYPES } from "../src/modules/36-messaging/outbox-consumers/dosespot-alerts";
import { COMPOSITION_ROOT, callArgument } from "./_composition-root";

describe("M12 degradation alerting is wired in the composition root", () => {
  it("binds M36's dosespot-alerts consumer to the real AlertEmitter", () => {
    expect(COMPOSITION_ROOT).toMatch(
      /buildM36DosespotAlertConsumer\(\s*getSeam\("AlertEmitter"\) as AlertEmitter\s*\)/,
    );
  });

  it("gives the M12 crons the Valkey-backed episode memory, never the in-memory one", () => {
    const call = callArgument(COMPOSITION_ROOT, "registerM12CronWorkers");
    expect(call).toMatch(/\bepisodes:\s*createValkeyEpisodeTracker\(\s*m12EpisodeRedis\s*\)/);
    expect(call).not.toMatch(/createEpisodeTracker\(/);
  });

  it("builds that connection fail-fast, so a tick never waits on an unreachable store", () => {
    const start = COMPOSITION_ROOT.indexOf("const m12EpisodeRedis = new Redis(");
    expect(start).toBeGreaterThan(0);
    const construction = COMPOSITION_ROOT.slice(start, start + 400);
    expect(construction).toMatch(/maxRetriesPerRequest:\s*1\b/);
    expect(construction).toMatch(/connectTimeout:/);
  });

  it("the catalog declares M36 as the consumer of exactly the events the consumer handles", () => {
    for (const eventName of M36_DOSESPOT_ALERT_EVENT_TYPES) {
      const entry = M12_OUTBOX_EVENTS.find((e) => String(e.eventName) === eventName);
      expect(entry?.declaredConsumers).toContain("m36");
    }
  });
});
