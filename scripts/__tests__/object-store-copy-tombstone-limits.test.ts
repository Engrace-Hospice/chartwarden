// CW-DS-01 — the tombstone-driven destruction is a DRY RUN unless applied explicitly, and one run destroys at most a
// capped number of objects. Offline, against two small in-memory S3 stores (source.test, target.test); the live proof on
// real SeaweedFS + RustFS is apps/backend/__tests__/object-store-resilience.live.test.ts. Synthetic ids and bytes only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { exportText, parseTombstones } from "../lib/object-tombstones";
import {
  type CopySummary,
  DEFAULT_MAX_TOMBSTONE_DELETIONS,
  type TombstonePlan,
  assertNoEqualsForms,
  copyObjectStore,
  describeTombstonePlan,
  resolveTombstoneSettings,
  tombstoneApplyFromArgs,
  tombstonesPendingBody,
} from "../object-store-copy";

const BUCKET = "tenant-00000000-0000-4000-8000-000000000001";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

type Objects = Map<string, Uint8Array>; // one version per key; version id "v1"
type Side = "source.test" | "target.test";

/** Two stores behind one fetch (routed on the host), recording every request that changes something. */
function fakeWorld(
  opts: { readonly failListOnTarget?: boolean; readonly failDeletes?: boolean } = {},
) {
  const stores: Record<Side, Map<string, Objects>> = {
    "source.test": new Map(),
    "target.test": new Map(),
  };
  const calls: string[] = [];
  const xml = (status: number, body: string): Response => new Response(body, { status });
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const host = url.host as Side;
    const store = stores[host];
    const method = init?.method ?? "GET";
    const [bucket, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const key = rest.join("/");
    const q = url.searchParams;
    if (method !== "GET" && method !== "HEAD") calls.push(`${method} ${host}`);
    if (!bucket)
      return xml(
        200,
        `<ListAllMyBucketsResult>${[...store.keys()].map((n) => `<Bucket><Name>${n}</Name></Bucket>`).join("")}</ListAllMyBucketsResult>`,
      );
    if (!key) {
      if (method === "PUT") {
        if (!store.has(bucket)) store.set(bucket, new Map());
        return xml(200, "");
      }
      const listed = store.get(bucket);
      if (!listed) return xml(404, "<Error/>");
      if (method === "HEAD") return xml(200, "");
      if (host === "target.test" && opts.failListOnTarget) return xml(500, "<Error/>");
      if (q.has("versions")) {
        const prefix = q.get("prefix") ?? "";
        const entries = [...listed.keys()].filter((k) => k.startsWith(prefix));
        return xml(
          200,
          `<ListVersionsResult><IsTruncated>false</IsTruncated>${entries.map((k) => `<Version><Key>${k}</Key><VersionId>v1</VersionId></Version>`).join("")}</ListVersionsResult>`,
        );
      }
      return xml(
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated>${[...listed.keys()].map((k) => `<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join("")}</ListBucketResult>`,
      );
    }
    const objects = store.get(bucket);
    if (!objects) return xml(404, "<Error/>");
    if (method === "PUT") {
      objects.set(key, new Uint8Array(init?.body as Uint8Array));
      return new Response(null, { status: 200 });
    }
    if (method === "DELETE") {
      if (opts.failDeletes) return xml(500, "<Error/>");
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const bytes = objects.get(key);
    if (!bytes) return xml(404, "<Error/>");
    return new Response(method === "HEAD" ? null : (bytes as unknown as BodyInit), {
      status: 200,
      headers: {
        "content-length": String(bytes.byteLength),
        "content-type": "application/pdf",
        "x-amz-checksum-sha256": Buffer.from(sha(bytes), "hex").toString("base64"),
        "x-amz-version-id": "v1",
      },
    });
  }) as unknown as typeof fetch;
  const put = (side: Side, key: string): void => {
    const objects = stores[side].get(BUCKET) ?? new Map<string, Uint8Array>();
    stores[side].set(BUCKET, objects);
    objects.set(key, new TextEncoder().encode(`synthetic ${key}`));
  };
  const keys = (side: Side): string[] => [...(stores[side].get(BUCKET)?.keys() ?? [])].sort();
  return { fetchImpl, put, keys, calls };
}

const store = (host: Side) =>
  ({
    endpoint: `http://${host}`,
    accessKeyId: "ak",
    secretAccessKey: "sk",
    forcePathStyle: true,
  }) as const;
const source = store("source.test");
const target = store("target.test");

const docKeys = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `documents/erased-${String(i).padStart(3, "0")}/v1.pdf`);
const tombstonesFor = (keys: readonly string[]) =>
  parseTombstones(exportText(keys.map((objectKey) => ({ bucket: BUCKET, objectKey }))));
const deletes = (calls: readonly string[]): string[] => calls.filter((c) => c.startsWith("DELETE"));

/** The source still holds `dead` and a hand load put it on the target too; `documents/kept` is an ordinary object on both. */
function seeded(dead: readonly string[], opts: { readonly failListOnTarget?: boolean } = {}) {
  const world = fakeWorld(opts);
  for (const key of [...dead, "documents/kept/v1.pdf"]) {
    world.put("source.test", key);
    world.put("target.test", key);
  }
  return world;
}

describe("tombstone destruction: dry run by default", () => {
  it("counts what the target holds and destroys nothing, unless applied", async () => {
    const dead = docKeys(3);
    const world = seeded(dead);
    const plans: TombstonePlan[] = [];
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), onTombstonePlan: (p) => void plans.push(p) },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({
      tombstoneMode: "dry-run",
      tombstonesOnTarget: 3,
      tombstoned: 0,
      skippedTombstoned: 3,
      failed: [],
    });
    expect(plans).toEqual([
      {
        mode: "dry-run",
        listed: 3,
        buckets: 1,
        onTarget: 3,
        limit: DEFAULT_MAX_TOMBSTONE_DELETIONS,
      },
    ]);
    expect(world.keys("target.test")).toHaveLength(4); // all three tombstoned objects and the kept one
    expect(deletes(world.calls)).toEqual([]);
  });

  it("only an explicit apply destroys them, and leaves every other object alone", async () => {
    const dead = docKeys(3);
    const world = seeded(dead);
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({
      tombstoneMode: "apply",
      tombstonesOnTarget: 3,
      tombstoned: 3,
      failed: [],
    });
    expect(world.keys("target.test")).toEqual(["documents/kept/v1.pdf"]);
    expect(world.keys("source.test")).toHaveLength(4); // the tool never touches the source
  });

  it("a dry run leaves the forward copy's own delete-missing (and its guard) as it was", async () => {
    const dead = docKeys(2);
    const world = fakeWorld();
    world.put("source.test", "documents/kept/v1.pdf");
    for (const key of [...dead, "documents/kept/v1.pdf"]) world.put("target.test", key); // the source lost the dead ones
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead) },
      { fetchImpl: world.fetchImpl },
    );
    // the guarded ordinary path removed them, not the list
    expect(summary).toMatchObject({
      tombstoneMode: "dry-run",
      tombstoned: 0,
      deleted: 2,
      failed: [],
    });
  });

  it("a refused plan does not stop the forward copy's own guarded delete of what the source lost", async () => {
    const dead = docKeys(5);
    const world = fakeWorld();
    world.put("source.test", "documents/kept/v1.pdf");
    for (const key of [...dead, "documents/kept/v1.pdf"]) world.put("target.test", key); // the source lost all five
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true, maxTombstoneDeletions: 4 },
      { fetchImpl: world.fetchImpl },
    );
    // nothing was destroyed ON THE LIST'S STRENGTH; the ordinary delete-missing (5 <= max(10, 10%)) still removed them
    expect(summary).toMatchObject({ tombstoneMode: "refused", tombstoned: 0, deleted: 5 });
    expect(summary.failed).toHaveLength(1); // only the refusal itself
  });

  it("a failed ordinary delete of a tombstoned key never reports the key (it names an erased patient)", async () => {
    const dead = docKeys(1);
    const world = fakeWorld({ failDeletes: true });
    world.put("source.test", "documents/kept/v1.pdf");
    for (const key of [...dead, "documents/kept/v1.pdf"]) world.put("target.test", key);
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead) },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.key).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(summary)).not.toContain("erased-000");
  });

  it("a failed destruction on the list's strength never reports the key either", async () => {
    const dead = docKeys(1);
    const world = seeded(dead);
    const failing = fakeWorld({ failDeletes: true });
    for (const key of [...dead, "documents/kept/v1.pdf"]) {
      failing.put("source.test", key);
      failing.put("target.test", key);
    }
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true },
      { fetchImpl: failing.fetchImpl },
    );
    expect(world.keys("target.test")).toHaveLength(2); // (control: an untouched world)
    expect(summary).toMatchObject({ tombstoneMode: "apply", tombstoned: 0 });
    expect(summary.failed[0]?.key).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(JSON.stringify(summary)).not.toContain("erased-000");
  });

  it("a limit that is not a whole number >= 1 is refused before anything is touched", async () => {
    const dead = docKeys(2);
    for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const world = seeded(dead);
      await expect(
        copyObjectStore(
          source,
          target,
          { tombstones: tombstonesFor(dead), applyTombstones: true, maxTombstoneDeletions: bad },
          { fetchImpl: world.fetchImpl },
        ),
      ).rejects.toThrow(/maxTombstoneDeletions must be a whole number >= 1/);
      expect(world.calls).toEqual([]);
    }
  });

  it("without a list there is no plan to report", async () => {
    const world = seeded([]);
    const plans: TombstonePlan[] = [];
    const summary = await copyObjectStore(
      source,
      target,
      { onTombstonePlan: (p) => void plans.push(p) },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({ tombstoneMode: "off", tombstonesOnTarget: 0 });
    expect(plans.map((p) => p.mode)).toEqual(["off"]);
  });
});

describe("tombstone destruction: the per-run cap", () => {
  it("refuses a plan over the limit whole: nothing destroyed, the run fails, the rest still copies", async () => {
    const dead = docKeys(5);
    const world = seeded(dead);
    world.put("source.test", "documents/new/v1.pdf");
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true, maxTombstoneDeletions: 4 },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({
      tombstoneMode: "refused",
      tombstonesOnTarget: 5,
      tombstoned: 0,
      copied: 1,
    });
    expect(summary.failed).toHaveLength(1); // the CLI exits 1 on any failure
    expect(summary.failed[0]?.reason).toMatch(
      /refused to destroy 5 tombstoned object\(s\) \(limit 4; nothing was destroyed on the list's strength; raise it deliberately with --max-deletions/,
    );
    expect(world.keys("target.test")).toHaveLength(7); // the five dead ones, the kept one, the new one
    expect(deletes(world.calls)).toEqual([]);
  });

  it("allows exactly the limit", async () => {
    const dead = docKeys(5);
    const world = seeded(dead);
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true, maxTombstoneDeletions: 5 },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({ tombstoneMode: "apply", tombstoned: 5, failed: [] });
  });

  it("the default limit is conservative: 100 pass, 101 are refused until the operator raises it", async () => {
    const hundred = docKeys(DEFAULT_MAX_TOMBSTONE_DELETIONS);
    const ok = seeded(hundred);
    expect(
      await copyObjectStore(
        source,
        target,
        { tombstones: tombstonesFor(hundred), applyTombstones: true },
        { fetchImpl: ok.fetchImpl },
      ),
    ).toMatchObject({ tombstoneMode: "apply", tombstoned: 100, failed: [] });

    const more = docKeys(DEFAULT_MAX_TOMBSTONE_DELETIONS + 1);
    const world = seeded(more);
    const stopped = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(more), applyTombstones: true },
      { fetchImpl: world.fetchImpl },
    );
    expect(stopped).toMatchObject({ tombstoneMode: "refused", tombstoned: 0 });
    expect(world.keys("target.test")).toHaveLength(102);

    const raised = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(more), applyTombstones: true, maxTombstoneDeletions: 101 },
      { fetchImpl: world.fetchImpl },
    );
    expect(raised).toMatchObject({ tombstoneMode: "apply", tombstoned: 101, failed: [] });
  });

  it("the limit counts objects the target holds, not the size of the list", async () => {
    const listed = docKeys(50);
    const world = seeded(listed.slice(0, 2)); // the target holds two of the fifty
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(listed), applyTombstones: true, maxTombstoneDeletions: 2 },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary).toMatchObject({
      tombstoneMode: "apply",
      tombstonesOnTarget: 2,
      tombstoned: 2,
      failed: [],
    });
  });

  it("the counts are reported before the first deletion", async () => {
    const dead = docKeys(2);
    const world = seeded(dead);
    const events: string[] = [];
    const watched = ((input: URL | string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") events.push("delete");
      return world.fetchImpl(input, init);
    }) as typeof fetch;
    await copyObjectStore(
      source,
      target,
      {
        tombstones: tombstonesFor(dead),
        applyTombstones: true,
        onTombstonePlan: () => void events.push("plan"),
      },
      { fetchImpl: watched },
    );
    expect(events).toEqual(["plan", "delete", "delete"]);
  });

  it("a bucket the target cannot list is reported and never guessed at", async () => {
    const dead = docKeys(2);
    const world = seeded(dead, { failListOnTarget: true });
    const summary = await copyObjectStore(
      source,
      target,
      { tombstones: tombstonesFor(dead), applyTombstones: true },
      { fetchImpl: world.fetchImpl },
    );
    expect(summary.tombstoned).toBe(0);
    expect(summary.failed.some((f) => /tombstone plan: .*HTTP 500/.test(f.reason))).toBe(true);
    expect(deletes(world.calls)).toEqual([]);
  });
});

describe("tombstoneApplyFromArgs", () => {
  const dryDefault = { apply: false, maxDeletions: DEFAULT_MAX_TOMBSTONE_DELETIONS };

  it("defaults to a dry run with the default limit", () => {
    expect(tombstoneApplyFromArgs({}, ["--tombstones", "f"], true)).toEqual(dryDefault);
    expect(tombstoneApplyFromArgs({}, [], false)).toEqual(dryDefault);
  });

  it("applies only on the flag or OBJECT_COPY_TOMBSTONES_APPLY=1|true", () => {
    expect(tombstoneApplyFromArgs({}, ["--apply-tombstones"], true).apply).toBe(true);
    expect(tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "1" }, [], true).apply).toBe(
      true,
    );
    expect(tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "TRUE" }, [], true).apply).toBe(
      true,
    );
    expect(tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "0" }, [], true).apply).toBe(
      false,
    );
    expect(tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "false" }, [], true).apply).toBe(
      false,
    );
    expect(tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "" }, [], true).apply).toBe(
      false,
    );
  });

  it("refuses any other apply value: a typo must not read as a dry run", () => {
    for (const bad of ["yes", "on", "2", "enable", "apply"])
      expect(() => tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: bad }, [], true)).toThrow(
        /OBJECT_COPY_TOMBSTONES_APPLY must be 1 or 0/,
      );
  });

  it("reads the limit from the flag, else the environment; the flag wins", () => {
    const env = { OBJECT_COPY_TOMBSTONES_MAX_DELETIONS: "250" };
    expect(tombstoneApplyFromArgs({}, ["--max-deletions", "7"], true).maxDeletions).toBe(7);
    expect(tombstoneApplyFromArgs(env, [], true).maxDeletions).toBe(250);
    expect(tombstoneApplyFromArgs(env, ["--max-deletions", "9"], true).maxDeletions).toBe(9);
  });

  it("refuses a limit that is not a whole number >= 1, and a missing value", () => {
    for (const bad of ["0", "-3", "1.5", "ten", "1e3", "Infinity", "", " "])
      expect(() => tombstoneApplyFromArgs({}, ["--max-deletions", bad], true)).toThrow(
        /--max-deletions needs a whole number >= 1/,
      );
    expect(() => tombstoneApplyFromArgs({}, ["--max-deletions"], true)).toThrow(
      /needs a whole number/,
    );
    expect(() => tombstoneApplyFromArgs({}, ["--max-deletions", "--restore"], true)).toThrow(
      /--max-deletions needs a whole number/,
    );
    expect(() =>
      tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_MAX_DELETIONS: "lots" }, [], true),
    ).toThrow(/OBJECT_COPY_TOMBSTONES_MAX_DELETIONS needs a whole number/);
  });

  it("refuses either setting without a list (it would be dropped silently)", () => {
    expect(() => tombstoneApplyFromArgs({}, ["--apply-tombstones"], false)).toThrow(
      /need a tombstone list/,
    );
    expect(() => tombstoneApplyFromArgs({}, ["--max-deletions", "5"], false)).toThrow(
      /need a tombstone list/,
    );
    expect(() => tombstoneApplyFromArgs({ OBJECT_COPY_TOMBSTONES_APPLY: "1" }, [], false)).toThrow(
      /need a tombstone list/,
    );
  });
});

describe("assertNoEqualsForms", () => {
  it("refuses --flag=value: it is not understood and would be dropped silently", () => {
    for (const arg of ["--tombstones=f.ndjson", "--apply-tombstones=1", "--max-deletions=5"])
      expect(() => assertNoEqualsForms(["--restore", arg])).toThrow(/is not understood/);
    expect(() =>
      assertNoEqualsForms(["--restore", "--tombstones", "f", "--max-deletions", "5"]),
    ).not.toThrow();
  });
});

describe("tombstonesPendingBody", () => {
  it("is a distinct alert with counts only", () => {
    const summary: CopySummary = {
      buckets: 2,
      copied: 0,
      unchanged: 9,
      deleted: 1,
      tombstoned: 0,
      skippedTombstoned: 0,
      tombstoneMode: "dry-run",
      tombstonesOnTarget: 7,
      failed: [],
    };
    const body = JSON.parse(tombstonesPendingBody(summary, new Date("2026-11-26T00:00:00Z")));
    expect(body.kind).toBe("object_copy.tombstones_pending");
    expect(body.summary).toMatch(/names 7 object\(s\).*OBJECT_COPY_TOMBSTONES_APPLY is not 1/);
    expect(body.details).toEqual({
      tombstoneMode: "dry-run",
      tombstonesOnTarget: 7,
      deleted: 1,
      skippedTombstoned: 0,
    });
    expect(body.occurredAt).toBe("2026-11-26T00:00:00.000Z");
  });
});

describe("describeTombstonePlan", () => {
  const plan = { mode: "dry-run", listed: 12, buckets: 2, onTarget: 4, limit: 100 } as const;
  it("states the counts and the mode in words, and never a key", () => {
    const dry = describeTombstonePlan(plan);
    expect(dry).toContain("names 12 object(s) in 2 bucket(s)");
    expect(dry).toContain("holds 4 of them");
    expect(dry).toMatch(/DRY RUN.*--apply-tombstones/);
    expect(describeTombstonePlan({ ...plan, mode: "apply" })).toMatch(
      /APPLYING: destroying 4 object\(s\)/,
    );
    expect(describeTombstonePlan({ ...plan, mode: "refused", onTarget: 150 })).toMatch(
      /REFUSED: 150 is over the limit 100; nothing is destroyed/,
    );
    expect(dry).not.toMatch(/documents\//);
  });
});

describe("resolveTombstoneSettings (scheduled copy vs one-off run)", () => {
  const inherited = {
    OBJECT_COPY_TOMBSTONES_FILE: "/tombstones/list.ndjson",
    OBJECT_COPY_TOMBSTONES_APPLY: "1",
    OBJECT_COPY_TOMBSTONES_MAX_DELETIONS: "500",
  };

  it("a one-off run ignores an apply and limit inherited from the environment: still a dry run, default limit", () => {
    expect(resolveTombstoneSettings(inherited, [], false)).toEqual({
      apply: false,
      maxDeletions: DEFAULT_MAX_TOMBSTONE_DELETIONS,
    });
  });

  it("a one-off run applies only on its own flags", () => {
    expect(
      resolveTombstoneSettings(inherited, ["--apply-tombstones", "--max-deletions", "7"], false),
    ).toEqual({ apply: true, maxDeletions: 7 });
  });

  it("the scheduled copy reads both from the environment", () => {
    expect(resolveTombstoneSettings(inherited, [], true)).toEqual({
      apply: true,
      maxDeletions: 500,
    });
    expect(
      resolveTombstoneSettings({ OBJECT_COPY_TOMBSTONES_FILE: "/t/list.ndjson" }, [], true),
    ).toEqual({ apply: false, maxDeletions: DEFAULT_MAX_TOMBSTONE_DELETIONS });
  });

  it("refuses an apply or limit when no list is named, scheduled or not", () => {
    expect(() => resolveTombstoneSettings({ OBJECT_COPY_TOMBSTONES_APPLY: "1" }, [], true)).toThrow(
      /need a tombstone list/,
    );
    expect(() => resolveTombstoneSettings({}, ["--apply-tombstones"], false)).toThrow(
      /need a tombstone list/,
    );
  });
});
