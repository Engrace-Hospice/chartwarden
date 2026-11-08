/**
 * Review of slice 4, M3 / MEDIUM-2 / LOW-5: the "alerted once per episode" memory of the DoseSpot degradation alerts lives in Valkey, and
 * an announcement (the alert, and the recovery) is a short-lived CLAIM confirmed only after its event has committed, so a crash anywhere
 * in between delays an announcement and never drops one; a recovery needs two consecutive clean ticks. This drives the real tracker
 * against a real Valkey (no database, no vendor):
 *
 *   CHARTWARDEN_TEST_REDIS_URL=redis://localhost:PORT bun run test:m12:episode-store:live
 */
import IORedis from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  EPISODE_KEY_PREFIX,
  createValkeyEpisodeTracker,
} from "../src/modules/12-dosespot/jobs/episode-store";

const REDIS_URL = process.env.CHARTWARDEN_TEST_REDIS_URL;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!REDIS_URL)("M12 episode store — LIVE Valkey", () => {
  const connections: IORedis[] = [];
  const connect = () => {
    const connection = new IORedis(REDIS_URL as string, { maxRetriesPerRequest: 1 });
    connections.push(connection);
    return connection;
  };
  let admin: IORedis;
  beforeAll(() => {
    admin = connect();
  });
  afterAll(async () => {
    await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
  });
  beforeEach(async () => {
    const keys = await admin.keys(`${EPISODE_KEY_PREFIX}*`);
    if (keys.length > 0) await admin.del(...keys);
  });
  const openEpisode = async (
    tracker: ReturnType<typeof createValkeyEpisodeTracker>,
    key: string,
  ) => {
    expect(await tracker.raise(key)).toBe(true);
    await tracker.confirmRaised(key);
  };

  describe("the alert", () => {
    it("the first raise claims the right to publish, a second does not, and once confirmed the episode is open: a report only keeps it open", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      expect(await tracker.raise("queued_orders_stale:org-1")).toBe(true);
      expect(await tracker.raise("queued_orders_stale:org-1")).toBe(false); // claimed: someone is announcing it
      await tracker.confirmRaised("queued_orders_stale:org-1");
      expect(await tracker.raise("queued_orders_stale:org-1")).toBe(false); // open
    });

    it("episodes are per key: another organization or another kind is its own episode", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      await openEpisode(tracker, "queued_orders_stale:org-1");
      expect(await tracker.raise("queued_orders_stale:org-2")).toBe(true);
      expect(await tracker.raise("config_unavailable:org-1")).toBe(true);
    });

    // MEDIUM-2, opening window: SET, then a crash (or a failed publish AND a failed release). The old store kept the key alive by
    // refreshing it on every report, so the alert was never sent.
    it("a claimant that never confirms does not block the alert: other reports do NOT extend the claim, it expires, and the next report claims", async () => {
      const tracker = createValkeyEpisodeTracker(connect(), { claimMs: 600 });
      const claim = `${EPISODE_KEY_PREFIX}pending:k`;
      expect(await tracker.raise("k")).toBe(true); // ... and then the claimant crashes
      const first = await admin.pttl(claim);
      await sleep(250);
      expect(await tracker.raise("k")).toBe(false); // another tick sees a claim in progress
      expect(await admin.pttl(claim)).toBeLessThan(first); // and did not refresh it
      await sleep(450);
      expect(await tracker.raise("k")).toBe(true); // the claim lapsed: the alert is published late, not never
    });

    it("a publish that failed releases the claim at once", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      expect(await tracker.raise("k")).toBe(true);
      await tracker.abortRaise("k");
      expect(await tracker.raise("k")).toBe(true);
    });

    it("an open episode survives a restart, and a second process joins it", async () => {
      const before = connect();
      await openEpisode(createValkeyEpisodeTracker(before), "config_unavailable:org-1");
      await before.quit();
      const after = createValkeyEpisodeTracker(connect());
      expect(await after.raise("config_unavailable:org-1")).toBe(false);
    });

    it("every report of an open episode refreshes its lifetime, and one nobody reports lapses and can be raised again", async () => {
      const tracker = createValkeyEpisodeTracker(connect(), { ttlMs: 600 });
      await openEpisode(tracker, "k");
      await sleep(400);
      expect(await tracker.raise("k")).toBe(false); // refreshed to a full 600 ms
      await sleep(400);
      expect(await tracker.raise("k")).toBe(false); // would have lapsed at 600 ms without the refresh
      await sleep(900);
      expect(await tracker.raise("k")).toBe(true); // unreported for longer than the lifetime
    });
  });

  describe("the recovery", () => {
    it("needs two consecutive clean ticks, and a report of the fault in between starts the count again (replicas that disagree do not flap)", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      await openEpisode(tracker, "k");
      expect(await tracker.clear("k")).toBe(false); // clean tick 1
      expect(await tracker.raise("k")).toBe(false); // another replica still sees the fault
      expect(await tracker.clear("k")).toBe(false); // clean tick 1 again
      expect(await tracker.clear("k")).toBe(true); // clean tick 2: this process announces the recovery
    });

    it("it is announced by whichever process sees it, once: the claim is exclusive and a second claimant does not also publish", async () => {
      const processA = createValkeyEpisodeTracker(connect());
      const processB = createValkeyEpisodeTracker(connect());
      await openEpisode(processA, "config_unavailable:org-1"); // A raised it
      expect(await processB.clear("config_unavailable:org-1")).toBe(false);
      expect(await processB.clear("config_unavailable:org-1")).toBe(true); // B announces the recovery A never will
      expect(await processA.clear("config_unavailable:org-1")).toBe(false); // A's own clean tick finds it claimed
    });

    // MEDIUM-2, closing window: DEL, then a crash before the publish. The old store had already forgotten the episode.
    it("a claimant that crashes before publishing leaves the episode OPEN: the claim lapses and the next clean tick announces the recovery", async () => {
      const tracker = createValkeyEpisodeTracker(connect(), { claimMs: 600 });
      await openEpisode(tracker, "k");
      expect(await tracker.clear("k")).toBe(false);
      expect(await tracker.clear("k")).toBe(true); // ... and then the claimant crashes
      expect(await tracker.clear("k")).toBe(false); // claimed: not announced twice meanwhile
      await sleep(700);
      expect(await tracker.clear("k")).toBe(true); // the episode never closed: the recovery is announced late, not never
    });

    it("a recovery whose publish failed is released at once and retried; confirming it ends the episode, and a later fault is a new one", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      await openEpisode(tracker, "k");
      await tracker.clear("k");
      expect(await tracker.clear("k")).toBe(true);
      await tracker.abortClear("k");
      expect(await tracker.clear("k")).toBe(true); // the clean count survived: no need to wait two more ticks
      await tracker.confirmCleared("k");
      expect(await tracker.clear("k")).toBe(false); // no episode any more
      expect(await tracker.raise("k")).toBe(true); // a later fault is a new episode
    });

    it("a healthy organization costs one read and writes nothing", async () => {
      const tracker = createValkeyEpisodeTracker(connect());
      for (let i = 0; i < 5; i += 1)
        expect(await tracker.clear("config_unavailable:org-9")).toBe(false);
      expect(await admin.keys(`${EPISODE_KEY_PREFIX}*`)).toEqual([]);
    });
  });

  it("the keys are namespaced and always carry a lifetime (an orphaned episode cannot outlive it)", async () => {
    const tracker = createValkeyEpisodeTracker(connect(), { ttlMs: 60_000, claimMs: 30_000 });
    await tracker.raise("config_unavailable:org-1");
    const claim = await admin.pttl(`${EPISODE_KEY_PREFIX}pending:config_unavailable:org-1`);
    expect(claim).toBeGreaterThan(0);
    expect(claim).toBeLessThanOrEqual(30_000);
    await tracker.confirmRaised("config_unavailable:org-1");
    await tracker.clear("config_unavailable:org-1");
    for (const part of ["open", "clean"]) {
      const remaining = await admin.pttl(`${EPISODE_KEY_PREFIX}${part}:config_unavailable:org-1`);
      expect(remaining, part).toBeGreaterThan(0);
      expect(remaining, part).toBeLessThanOrEqual(60_000);
    }
  });

  it("a store that cannot be reached rejects, so the caller decides (it is never read as 'no episode')", async () => {
    const dead = connect();
    await dead.quit();
    const tracker = createValkeyEpisodeTracker(dead);
    await expect(tracker.raise("k")).rejects.toThrow();
    await expect(tracker.clear("k")).rejects.toThrow();
  });
});
