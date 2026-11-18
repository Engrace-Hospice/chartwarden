// ADR-0113 — the per-tenant closure policy: the absent-row default, the server-side enforce_from on a move to block, the
// slice-1 kind + threshold validation, and the 5s per-org cache the request-time gate reads. DB behaviour (RLS, the CHECK, the
// upsert against a real row) is the live suite's; this proves the rules in the service.
import { ValidationError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  CLOSURE_POLICY_CACHE_TTL_MS,
  type ClosurePolicy,
  DEFAULT_CLOSURE_POLICY,
  createClosurePolicyCache,
  nextEnforceFrom,
  putClosurePolicy,
  readClosurePolicy,
} from "../src/modules/08-encounters/closure/policy-service";
import { fakeTx } from "./_closure-fake-tx";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const ACTOR_USER = "00000000-0000-4000-8000-0000000000c1";
const NOW = new Date("2026-11-17T12:00:00.000Z");
const EARLIER = new Date("2026-11-10T08:00:00.000Z");

const row = (mode: string, thresholdHours: number, enforceFrom: Date | null) => ({
  mode,
  thresholdHours,
  enforceFrom,
});

describe("readClosurePolicy", () => {
  it("an organization with no policy row is warn / 24 hours with no grace instant", async () => {
    const { tx } = fakeTx([[]]);
    expect(await readClosurePolicy(tx, ORG, "visit_note")).toEqual({
      mode: "warn",
      thresholdHours: 24,
      enforceFrom: null,
    });
    expect(DEFAULT_CLOSURE_POLICY.mode).toBe("warn");
  });

  it("returns the stored mode, threshold and enforce_from", async () => {
    const { tx } = fakeTx([[row("block", 12, EARLIER)]]);
    expect(await readClosurePolicy(tx, ORG, "visit_note")).toEqual({
      mode: "block",
      thresholdHours: 12,
      enforceFrom: EARLIER,
    });
  });
});

describe("nextEnforceFrom (the grace window a move to block opens)", () => {
  const warn: ClosurePolicy = { mode: "warn", thresholdHours: 24, enforceFrom: null };
  const block: ClosurePolicy = { mode: "block", thresholdHours: 24, enforceFrom: EARLIER };

  it("stamps now when the mode moves to block", () => {
    expect(nextEnforceFrom(warn, "block", NOW)).toEqual(NOW);
    expect(nextEnforceFrom({ ...warn, mode: "off" }, "block", NOW)).toEqual(NOW);
    expect(nextEnforceFrom(DEFAULT_CLOSURE_POLICY, "block", NOW)).toEqual(NOW);
  });

  it("keeps the original instant while the mode stays block (a repeated PUT is idempotent)", () => {
    expect(nextEnforceFrom(block, "block", NOW)).toEqual(EARLIER);
  });

  it("clears the instant once the mode leaves block", () => {
    expect(nextEnforceFrom(block, "warn", NOW)).toBeNull();
    expect(nextEnforceFrom(block, "off", NOW)).toBeNull();
  });

  it("stays null for warn and off", () => {
    expect(nextEnforceFrom(warn, "warn", NOW)).toBeNull();
    expect(nextEnforceFrom(warn, "off", NOW)).toBeNull();
  });
});

describe("putClosurePolicy", () => {
  const base = {
    organizationId: ORG,
    obligationKind: "visit_note" as const,
    actorUserId: ACTOR_USER,
    now: NOW,
  };

  it("sets enforce_from = now server-side when warn moves to block, and upserts under the actor", async () => {
    const fake = fakeTx([[row("warn", 24, null)], []]);
    const result = await putClosurePolicy(fake.tx, { ...base, mode: "block", thresholdHours: 24 });
    expect(result).toEqual({ mode: "block", thresholdHours: 24, enforceFrom: NOW });
    expect(fake.insertedValues()[0]).toMatchObject({
      organizationId: ORG,
      obligationKind: "visit_note",
      mode: "block",
      thresholdHours: 24,
      enforceFrom: NOW,
      configuredByUserId: ACTOR_USER,
    });
  });

  it("treats an absent row as warn, so the first PUT to block also opens the grace window", async () => {
    const fake = fakeTx([[], []]);
    const result = await putClosurePolicy(fake.tx, { ...base, mode: "block", thresholdHours: 36 });
    expect(result.enforceFrom).toEqual(NOW);
    expect(result.thresholdHours).toBe(36);
  });

  it("keeps the original enforce_from when only the threshold changes under block", async () => {
    const fake = fakeTx([[row("block", 24, EARLIER)], []]);
    const result = await putClosurePolicy(fake.tx, { ...base, mode: "block", thresholdHours: 48 });
    expect(result.enforceFrom).toEqual(EARLIER);
  });

  it("clears enforce_from when the mode leaves block", async () => {
    const fake = fakeTx([[row("block", 24, EARLIER)], []]);
    const result = await putClosurePolicy(fake.tx, { ...base, mode: "warn", thresholdHours: 24 });
    expect(result.enforceFrom).toBeNull();
    expect(fake.insertedValues()[0]).toMatchObject({ mode: "warn", enforceFrom: null });
  });

  it.each(["hope_window", "cti", "face_to_face"] as const)(
    "refuses the reserved kind %s in slice 1 and writes nothing",
    async (kind) => {
      const fake = fakeTx([]);
      await expect(
        putClosurePolicy(fake.tx, {
          ...base,
          obligationKind: kind,
          mode: "warn",
          thresholdHours: 24,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fake.queriesRun()).toBe(0);
    },
  );

  it.each([0, -1, 169, 24.5, Number.NaN])(
    "refuses threshold_hours %s (the CHECK is 1..168) before touching the database",
    async (thresholdHours) => {
      const fake = fakeTx([]);
      await expect(
        putClosurePolicy(fake.tx, { ...base, mode: "warn", thresholdHours }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(fake.queriesRun()).toBe(0);
    },
  );

  it.each([1, 24, 168])("accepts the boundary threshold %s", async (thresholdHours) => {
    const fake = fakeTx([[], []]);
    const result = await putClosurePolicy(fake.tx, { ...base, mode: "warn", thresholdHours });
    expect(result.thresholdHours).toBe(thresholdHours);
  });

  it("refuses an unknown mode", async () => {
    const fake = fakeTx([]);
    await expect(
      putClosurePolicy(fake.tx, { ...base, mode: "strict" as never, thresholdHours: 24 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("createClosurePolicyCache (the gate's 5s per-org cache)", () => {
  const WARN: ClosurePolicy = { mode: "warn", thresholdHours: 24, enforceFrom: null };
  const BLOCK: ClosurePolicy = { mode: "block", thresholdHours: 24, enforceFrom: NOW };

  function setup(loader: (orgId: string) => Promise<ClosurePolicy>) {
    let clock = 1_000_000;
    const load = vi.fn(async (orgId: string) => loader(orgId));
    const cache = createClosurePolicyCache({ load, now: () => clock });
    return {
      cache,
      load,
      advance: (ms: number) => {
        clock += ms;
      },
    };
  }

  it("loads once and serves the cached policy inside the TTL", async () => {
    const { cache, load, advance } = setup(async () => WARN);
    await cache.get(ORG, "visit_note");
    advance(CLOSURE_POLICY_CACHE_TTL_MS - 1);
    expect(await cache.get(ORG, "visit_note")).toEqual(WARN);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("reloads after the TTL", async () => {
    const { cache, load, advance } = setup(async () => WARN);
    await cache.get(ORG, "visit_note");
    advance(CLOSURE_POLICY_CACHE_TTL_MS);
    await cache.get(ORG, "visit_note");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidate(orgId) makes the next read see the new policy immediately", async () => {
    let current = WARN;
    const { cache, load } = setup(async () => current);
    expect((await cache.get(ORG, "visit_note")).mode).toBe("warn");
    current = BLOCK;
    cache.invalidate(ORG);
    expect((await cache.get(ORG, "visit_note")).mode).toBe("block");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidates only the named organization", async () => {
    const otherOrg = "00000000-0000-4000-8000-0000000000a2";
    const { cache, load } = setup(async () => WARN);
    await cache.get(ORG, "visit_note");
    await cache.get(otherOrg, "visit_note");
    cache.invalidate(ORG);
    await cache.get(otherOrg, "visit_note");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent readers", async () => {
    const { cache, load } = setup(async () => WARN);
    await Promise.all([cache.get(ORG, "visit_note"), cache.get(ORG, "visit_note")]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("never caches a failure: the next read retries the load", async () => {
    let fail = true;
    const { cache, load } = setup(async () => {
      if (fail) throw new Error("db down");
      return WARN;
    });
    await expect(cache.get(ORG, "visit_note")).rejects.toThrow("db down");
    fail = false;
    expect(await cache.get(ORG, "visit_note")).toEqual(WARN);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
