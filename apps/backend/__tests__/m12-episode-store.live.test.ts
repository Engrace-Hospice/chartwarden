/**
 * Review of slice 4, M3: the "alerted once per episode" memory of the DoseSpot degradation alerts lived in one process, so a
 * restart or a second replica alerted again, and a recovery was lost whenever a DIFFERENT process had raised the alert. It now
 * lives in Valkey (SET NX PX / PEXPIRE / DEL). This drives the real tracker against a real Valkey (no database, no vendor):
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

  it("the first raise opens an episode, a repeat does not, and a clear ends it exactly once", async () => {
    const tracker = createValkeyEpisodeTracker(connect());
    expect(await tracker.raise("queued_orders_stale:org-1")).toBe(true);
    expect(await tracker.raise("queued_orders_stale:org-1")).toBe(false);
    expect(await tracker.clear("queued_orders_stale:org-1")).toBe(true);
    expect(await tracker.clear("queued_orders_stale:org-1")).toBe(false);
    expect(await tracker.raise("queued_orders_stale:org-1")).toBe(true);
  });

  it("episodes are per key: another organization or another kind is its own episode", async () => {
    const tracker = createValkeyEpisodeTracker(connect());
    expect(await tracker.raise("queued_orders_stale:org-1")).toBe(true);
    expect(await tracker.raise("queued_orders_stale:org-2")).toBe(true);
    expect(await tracker.raise("config_unavailable:org-1")).toBe(true);
  });

  it("a second process sees the first one's episode, and it is the second process's clear that ends it (the recovery is not lost)", async () => {
    const processA = createValkeyEpisodeTracker(connect());
    const processB = createValkeyEpisodeTracker(connect());
    expect(await processA.raise("config_unavailable:org-1")).toBe(true);
    expect(await processB.raise("config_unavailable:org-1")).toBe(false); // no second alert from another replica
    expect(await processB.clear("config_unavailable:org-1")).toBe(true); // B announces the recovery A never will
    expect(await processA.clear("config_unavailable:org-1")).toBe(false); // and it is announced once
  });

  it("an episode survives a restart: a tracker built on a brand-new connection still sees it open", async () => {
    const before = connect();
    expect(await createValkeyEpisodeTracker(before).raise("config_unavailable:org-1")).toBe(true);
    await before.quit();
    const after = createValkeyEpisodeTracker(connect());
    expect(await after.raise("config_unavailable:org-1")).toBe(false);
    expect(await after.clear("config_unavailable:org-1")).toBe(true);
  });

  it("every report of an open episode refreshes its lifetime, and one nobody reports lapses and can be raised again", async () => {
    const tracker = createValkeyEpisodeTracker(connect(), { ttlMs: 600 });
    expect(await tracker.raise("k")).toBe(true);
    await sleep(400);
    expect(await tracker.raise("k")).toBe(false); // still open: refreshed to a full 600 ms
    await sleep(400);
    expect(await tracker.raise("k")).toBe(false); // would have lapsed at 600 ms without the refresh
    await sleep(900);
    expect(await tracker.raise("k")).toBe(true); // unreported for longer than the lifetime
  });

  it("the key is namespaced and always carries a lifetime (an orphaned episode cannot outlive it)", async () => {
    const tracker = createValkeyEpisodeTracker(connect(), { ttlMs: 60_000 });
    await tracker.raise("config_unavailable:org-1");
    const remaining = await admin.pttl(`${EPISODE_KEY_PREFIX}config_unavailable:org-1`);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it("a store that cannot be reached rejects, so the caller decides (it is never read as 'no episode')", async () => {
    const dead = connect();
    await dead.quit();
    const tracker = createValkeyEpisodeTracker(dead);
    await expect(tracker.raise("k")).rejects.toThrow();
    await expect(tracker.clear("k")).rejects.toThrow();
  });
});
