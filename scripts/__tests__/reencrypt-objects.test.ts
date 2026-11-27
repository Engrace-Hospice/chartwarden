// CW-AC-05 — the re-encryption tool, offline against a small in-memory versioned S3 (the live proof on real
// SeaweedFS/RustFS is apps/backend/__tests__/object-store-resilience.live.test.ts). Synthetic ids and bytes only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type JournalEntry,
  parseArgs,
  reencryptObjectStore,
  verifyJournal,
} from "../storage/reencrypt-objects";

interface Version {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly sse: boolean;
  /** Whether the store holds a SHA-256 for it (objects written without one have none). */
  readonly checksummed: boolean;
}

interface FakeOptions {
  readonly versioned?: boolean;
  /** A store that accepts the write and does not encrypt it (nor say so). */
  readonly ignoreSse?: boolean;
}

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const b64 = (hex: string): string => Buffer.from(hex, "hex").toString("base64");

/** A versioned S3 with exactly the calls the tool makes. `methods` records every verb seen (to prove no DELETE). */
function fakeS3(opts: FakeOptions = {}) {
  const buckets = new Map<string, Map<string, Version[]>>();
  const defaults = new Set<string>();
  const methods: string[] = [];
  let counter = 0;
  const seed = (bucket: string, key: string, text: string, sse = false, checksummed = true): void => {
    const keys = buckets.get(bucket) ?? new Map<string, Version[]>();
    buckets.set(bucket, keys);
    keys.set(key, [
      { id: `v${++counter}`, bytes: new TextEncoder().encode(text), mime: "application/pdf", sse, checksummed },
    ]);
  };
  const xml = (status: number, body: string): Response => new Response(body, { status });
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    methods.push(method);
    const [bucket, ...rest] = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const key = rest.join("/");
    const q = url.searchParams;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    if (!bucket)
      return xml(
        200,
        `<ListAllMyBucketsResult>${[...buckets.keys()].map((n) => `<Bucket><Name>${n}</Name></Bucket>`).join("")}</ListAllMyBucketsResult>`,
      );
    const keys = buckets.get(bucket);
    if (!keys) return xml(404, "<Error/>");
    if (q.has("versioning"))
      return xml(
        200,
        `<VersioningConfiguration><Status>${opts.versioned === false ? "Suspended" : "Enabled"}</Status></VersioningConfiguration>`,
      );
    if (q.has("encryption")) {
      if (method === "PUT") {
        defaults.add(bucket);
        return xml(200, "");
      }
      return defaults.has(bucket)
        ? xml(200, "<C><SSEAlgorithm>AES256</SSEAlgorithm></C>")
        : xml(404, "<Error/>");
    }
    if (!key)
      return xml(
        200,
        `<ListBucketResult><IsTruncated>false</IsTruncated>${[...keys.keys()].map((k) => `<Contents><Key>${encodeURIComponent(k)}</Key></Contents>`).join("")}</ListBucketResult>`,
      );
    const versions = keys.get(key);
    const wanted = q.get("versionId");
    const version = wanted ? versions?.find((v) => v.id === wanted) : versions?.at(-1);
    if (method === "PUT") {
      const bytes = new Uint8Array(init?.body as Uint8Array);
      const encrypt =
        !opts.ignoreSse &&
        (headers["x-amz-server-side-encryption"] === "AES256" || defaults.has(bucket));
      const next: Version = {
        id: `v${++counter}`,
        bytes,
        mime: headers["content-type"] ?? "application/octet-stream",
        sse: encrypt,
        checksummed: Boolean(headers["x-amz-checksum-sha256"]),
      };
      // an unversioned bucket replaces the object (the source is gone), a versioned one keeps the old version
      keys.set(key, opts.versioned === false ? [next] : [...(versions ?? []), next]);
      return new Response(null, {
        status: 200,
        headers: encrypt ? { "x-amz-server-side-encryption": "AES256" } : {},
      });
    }
    if (!version) return xml(404, "<Error/>");
    const meta: Record<string, string> = {
      "content-length": String(version.bytes.byteLength),
      "content-type": version.mime,
      ...(version.checksummed ? { "x-amz-checksum-sha256": b64(sha(version.bytes)) } : {}),
      "x-amz-version-id": version.id,
      ...(version.sse ? { "x-amz-server-side-encryption": "AES256" } : {}),
    };
    return new Response(method === "HEAD" ? null : (version.bytes as unknown as BodyInit), {
      status: 200,
      headers: meta,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, seed, buckets, methods, defaults };
}

const config = { endpoint: "http://s3.test", accessKeyId: "ak", secretAccessKey: "sk" } as const;
const BUCKET = "tenant-00000000-0000-4000-8000-000000000001";

describe("reencryptObjectStore", () => {
  it("dry-run (the default) reports what it would rewrite and writes nothing at all", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    s3.seed(BUCKET, "documents/b.pdf", "synthetic-b", true);
    const summary = await reencryptObjectStore(config, {}, { fetchImpl: s3.fetchImpl });
    expect(summary).toMatchObject({
      mode: "dry-run",
      objects: 2,
      alreadyEncrypted: 1,
      pending: 1,
      reencrypted: 0,
      failed: [],
    });
    expect(summary.pendingBytes).toBe("synthetic-a".length);
    expect(s3.methods.filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
    expect(s3.buckets.get(BUCKET)?.get("documents/a.pdf")).toHaveLength(1);
    expect(s3.defaults.size).toBe(0); // not even the bucket's default is touched
  });

  it("apply rewrites each plaintext object as a new encrypted version and keeps the plaintext one", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    s3.seed(BUCKET, "documents/b.pdf", "synthetic-b", true);
    const journal: JournalEntry[] = [];
    const summary = await reencryptObjectStore(
      config,
      { apply: true, journal: (e) => void journal.push(e) },
      { fetchImpl: s3.fetchImpl },
    );
    expect(summary).toMatchObject({
      mode: "apply",
      reencrypted: 1,
      alreadyEncrypted: 1,
      pending: 0,
      failed: [],
    });
    const versions = s3.buckets.get(BUCKET)!.get("documents/a.pdf")!;
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ sse: false }); // the source, untouched
    expect(versions[1]).toMatchObject({ sse: true });
    expect(sha(versions[1]!.bytes)).toBe(sha(versions[0]!.bytes));
    const done = journal.filter((e) => e.status === "reencrypted");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      status: "reencrypted",
      key: "documents/a.pdf",
      sha256Hex: sha(versions[0]!.bytes),
      supersededVersionId: versions[0]!.id,
      newVersionId: versions[1]!.id,
    });
    expect(s3.defaults.has(BUCKET)).toBe(true); // new writes encrypt too
  });

  it("journals the intent BEFORE the rewrite, so the purge list survives a kill after the write", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const journal: JournalEntry[] = [];
    await reencryptObjectStore(config, { apply: true, journal: (e) => void journal.push(e) }, { fetchImpl: s3.fetchImpl });
    expect(journal.map((e) => e.status)).toEqual(["intent", "reencrypted"]);
    const versions = s3.buckets.get(BUCKET)!.get("documents/a.pdf")!;
    expect(journal[0]).toMatchObject({ supersededVersionId: versions[0]!.id });

    // a write the store then refuses leaves the intent and a failure, and the source untouched
    const bad = fakeS3({ ignoreSse: true });
    bad.seed(BUCKET, "documents/b.pdf", "synthetic-b");
    const badJournal: JournalEntry[] = [];
    await reencryptObjectStore(config, { apply: true, journal: (e) => void badJournal.push(e) }, { fetchImpl: bad.fetchImpl });
    expect(badJournal.map((e) => e.status)).toEqual(["intent", "failed"]);
  });

  it("an object stored without a checksum is refused, unless --adopt-unchecksummed re-checks it against the bytes read", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/render.pdf", "synthetic-render", false, false);
    const refused = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(refused.failed[0]?.reason).toContain("no stored SHA-256");
    expect(s3.buckets.get(BUCKET)!.get("documents/render.pdf")).toHaveLength(1);

    const adopted = await reencryptObjectStore(config, { apply: true, adoptUnchecksummed: true }, { fetchImpl: s3.fetchImpl });
    expect(adopted).toMatchObject({ reencrypted: 1, failed: [] });
    const versions = s3.buckets.get(BUCKET)!.get("documents/render.pdf")!;
    expect(versions).toHaveLength(2);
    expect(versions[1]).toMatchObject({ sse: true, checksummed: true });
    expect(sha(versions[1]!.bytes)).toBe(sha(versions[0]!.bytes));
  });

  it("a failure AFTER the write still records the plaintext version it left, so the purge list is complete", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const real = s3.fetchImpl;
    let wrote = false;
    const flaky = (async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && String(input).endsWith("documents/a.pdf")) wrote = true;
      // after the rewrite, the read-back returns bytes that are not the source's
      if (wrote && method === "GET" && String(input).endsWith("documents/a.pdf"))
        return new Response(new TextEncoder().encode("garbled"), { status: 200 });
      return real(input as never, init);
    }) as unknown as typeof fetch;
    const journal: JournalEntry[] = [];
    const summary = await reencryptObjectStore(config, { apply: true, journal: (e) => void journal.push(e) }, { fetchImpl: flaky });
    expect(summary.failed[0]?.reason).toContain("does not read back");
    const versions = s3.buckets.get(BUCKET)!.get("documents/a.pdf")!;
    expect(journal.at(-1)).toMatchObject({ status: "failed", supersededVersionId: versions[0]!.id });
    // and a re-run, which now sees AES256, does not pretend there is nothing on record
    expect(journal.some((e) => e.status === "intent" && e.supersededVersionId === versions[0]!.id)).toBe(true);
  });

  it("a failure BEFORE the write names no superseded version (it would be the object's only plaintext copy)", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/render.pdf", "synthetic-render", false, false); // no stored SHA-256, so it is refused before any write
    const journal: JournalEntry[] = [];
    await reencryptObjectStore(config, { apply: true, journal: (e) => void journal.push(e) }, { fetchImpl: s3.fetchImpl });
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ status: "failed" });
    expect(journal[0]).not.toHaveProperty("supersededVersionId");
  });

  it("stops the whole run when the journal cannot be written (the purge list is the point)", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    s3.seed(BUCKET, "documents/b.pdf", "synthetic-b");
    await expect(
      reencryptObjectStore(config, { apply: true, journal: () => { throw new Error("EACCES"); } }, { fetchImpl: s3.fetchImpl }),
    ).rejects.toThrow(/journal write failed: EACCES/);
    // the first object was never rewritten: the intent is written before the write
    expect(s3.buckets.get(BUCKET)!.get("documents/a.pdf")).toHaveLength(1);
    expect(s3.buckets.get(BUCKET)!.get("documents/b.pdf")).toHaveLength(1);
  });

  it("reports an object over --max-bytes instead of reading it into memory (also in a dry run)", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/big.pdf", "x".repeat(100));
    const dry = await reencryptObjectStore(config, { maxBytes: 50 }, { fetchImpl: s3.fetchImpl });
    expect(dry.failed[0]?.reason).toContain("over --max-bytes 50");
    const applied = await reencryptObjectStore(config, { apply: true, maxBytes: 50 }, { fetchImpl: s3.fetchImpl });
    expect(applied.reencrypted).toBe(0);
    expect(s3.buckets.get(BUCKET)!.get("documents/big.pdf")).toHaveLength(1);
  });

  it("an unversioned bucket holding only encrypted objects needs no rewrite and is not a failure", async () => {
    const s3 = fakeS3({ versioned: false });
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a", true);
    const summary = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(summary).toMatchObject({ alreadyEncrypted: 1, pending: 0, failed: [] });
  });

  it("never issues a DELETE", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(s3.methods).not.toContain("DELETE");
  });

  it("is resumable: a limited run stops, the next continues, and a finished store is a no-op", async () => {
    const s3 = fakeS3();
    for (const k of ["documents/1.pdf", "documents/2.pdf", "documents/3.pdf"])
      s3.seed(BUCKET, k, `synthetic-${k}`);
    const first = await reencryptObjectStore(
      config,
      { apply: true, limit: 2 },
      { fetchImpl: s3.fetchImpl },
    );
    expect(first).toMatchObject({ reencrypted: 2, pending: 1 });
    const second = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(second).toMatchObject({ reencrypted: 1, alreadyEncrypted: 2, pending: 0 });
    const third = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(third).toMatchObject({ reencrypted: 0, alreadyEncrypted: 3, pending: 0, failed: [] });
    for (const versions of s3.buckets.get(BUCKET)!.values()) expect(versions).toHaveLength(2);
  });

  it("refuses an unversioned bucket: the rewrite would destroy the source", async () => {
    const s3 = fakeS3({ versioned: false });
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const summary = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(summary.failed).toEqual([
      {
        bucket: BUCKET,
        key: "documents/a.pdf",
        reason: expect.stringContaining("versioning is not enabled"),
      },
    ]);
    expect(s3.buckets.get(BUCKET)!.get("documents/a.pdf")![0]).toMatchObject({ sse: false });
  });

  it("writes nothing for an object whose bytes do not match its stored checksum", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    // HEAD reports the recorded checksum, GET returns other bytes
    const real = s3.fetchImpl;
    const corrupt = (async (input: unknown, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" && String(input).endsWith("documents/a.pdf")
        ? new Response(new TextEncoder().encode("tampered"), { status: 200 })
        : real(input as never, init)) as unknown as typeof fetch;
    const journal: JournalEntry[] = [];
    const summary = await reencryptObjectStore(
      config,
      { apply: true, journal: (e) => void journal.push(e) },
      { fetchImpl: corrupt },
    );
    expect(summary.failed[0]?.reason).toContain("do not match the stored SHA-256");
    expect(s3.buckets.get(BUCKET)!.get("documents/a.pdf")).toHaveLength(1); // no new version written
    expect(journal[0]).toMatchObject({ status: "failed", key: "documents/a.pdf" });
  });

  it("fails an object when the store does not confirm encryption (no silent plaintext rewrite)", async () => {
    const s3 = fakeS3({ ignoreSse: true });
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const summary = await reencryptObjectStore(config, { apply: true }, { fetchImpl: s3.fetchImpl });
    expect(summary).toMatchObject({ reencrypted: 0 });
    expect(summary.failed[0]?.reason).toMatch(/without server-side encryption|did not keep/);
  });

  it("only touches the named buckets", async () => {
    const s3 = fakeS3();
    const other = "tenant-00000000-0000-4000-8000-000000000002";
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    s3.seed(other, "documents/z.pdf", "synthetic-z");
    const summary = await reencryptObjectStore(
      config,
      { apply: true, buckets: new Set([BUCKET]) },
      { fetchImpl: s3.fetchImpl },
    );
    expect(summary).toMatchObject({ buckets: 1, reencrypted: 1 });
    expect(s3.buckets.get(other)!.get("documents/z.pdf")).toHaveLength(1);
  });
});

describe("verifyJournal (what is safe to purge)", () => {
  const applyAndJournal = async (s3: ReturnType<typeof fakeS3>): Promise<string> => {
    const journal: JournalEntry[] = [];
    await reencryptObjectStore(config, { apply: true, journal: (e) => void journal.push(e) }, { fetchImpl: s3.fetchImpl });
    return journal.map((e) => JSON.stringify(e)).join("\n");
  };

  it("lists a superseded version as purgeable only once the current one is encrypted and reads back as the journaled bytes", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const text = await applyAndJournal(s3);
    const versions = s3.buckets.get(BUCKET)!.get("documents/a.pdf")!;

    const before = s3.methods.length;
    const result = await verifyJournal(config, text, {}, { fetchImpl: s3.fetchImpl });

    expect(result.held).toEqual([]);
    expect(result.purgeable).toEqual([
      { status: "purgeable", bucket: BUCKET, key: "documents/a.pdf", supersededVersionId: versions[0]!.id },
    ]);
    // it only reads: nothing but GET and HEAD after the apply
    expect(s3.methods.slice(before).filter((m) => m !== "GET" && m !== "HEAD")).toEqual([]);
  });

  it("holds an object whose current version does not read back as the journaled bytes", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const text = await applyAndJournal(s3);
    const real = s3.fetchImpl;
    const garbled = (async (input: unknown, init?: RequestInit) =>
      (init?.method ?? "GET") === "GET" && String(input).endsWith("documents/a.pdf")
        ? new Response(new TextEncoder().encode("garbled"), { status: 200 })
        : real(input as never, init)) as unknown as typeof fetch;

    const result = await verifyJournal(config, text, {}, { fetchImpl: garbled });

    expect(result.purgeable).toEqual([]);
    expect(result.held[0]).toMatchObject({ status: "hold", reason: expect.stringContaining("does not read back") });
  });

  it("holds an object the journal says failed, and an object whose current version is still the plaintext one (a cut-short rewrite that never wrote)", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/failed.pdf", "synthetic-f");
    s3.seed(BUCKET, "documents/untouched.pdf", "synthetic-u");
    const vf = s3.buckets.get(BUCKET)!.get("documents/failed.pdf")![0]!;
    const vu = s3.buckets.get(BUCKET)!.get("documents/untouched.pdf")![0]!;
    const entry = (key: string, id: string, status: string) =>
      JSON.stringify({ at: "2026-11-26T00:00:00Z", status, bucket: BUCKET, key, sha256Hex: sha(vf.bytes), byteSize: 1, supersededVersionId: id, reason: "x" });
    const text = [
      entry("documents/failed.pdf", vf.id, "intent"),
      entry("documents/failed.pdf", vf.id, "failed"),
      entry("documents/untouched.pdf", vu.id, "intent"), // the process died before its write
    ].join("\n");

    const result = await verifyJournal(config, text, {}, { fetchImpl: s3.fetchImpl });

    expect(result.purgeable).toEqual([]);
    expect(result.held.map((h) => h.reason)).toEqual([
      expect.stringContaining("failed"),
      expect.stringContaining("not reported as encrypted"),
    ]);
  });

  it("needs nothing for a superseded version that is already gone, and refuses a journal it cannot read", async () => {
    const s3 = fakeS3();
    s3.seed(BUCKET, "documents/a.pdf", "synthetic-a");
    const text = await applyAndJournal(s3);
    s3.buckets.get(BUCKET)!.get("documents/a.pdf")!.shift(); // the operator already purged it
    const result = await verifyJournal(config, text, {}, { fetchImpl: s3.fetchImpl });
    expect(result).toMatchObject({ purgeable: [], held: [], alreadyPurged: 1 });
    await expect(verifyJournal(config, "not json", {}, { fetchImpl: s3.fetchImpl })).rejects.toThrow(/line 1 is not JSON/);
  });
});

describe("parseArgs", () => {
  it("defaults to a dry run with the default journal", () => {
    expect(parseArgs([])).toMatchObject({
      apply: false,
      journal: "./object-store-reencrypt.ndjson",
      limit: undefined,
    });
  });
  it("reads --apply, --journal, repeated --bucket and --limit", () => {
    const a = parseArgs([
      "--apply",
      "--journal",
      "/tmp/j.ndjson",
      "--bucket",
      "b1",
      "--bucket",
      "b2",
      "--limit",
      "5",
    ]);
    expect(a).toMatchObject({ apply: true, journal: "/tmp/j.ndjson", limit: 5 });
    expect([...a.buckets]).toEqual(["b1", "b2"]);
  });
  it("reads --adopt-unchecksummed", () => {
    expect(parseArgs(["--adopt-unchecksummed"]).adoptUnchecksummed).toBe(true);
    expect(parseArgs([]).adoptUnchecksummed).toBe(false);
  });
  it("reads --max-bytes", () => {
    expect(parseArgs(["--max-bytes", "1000"]).maxBytes).toBe(1000);
    expect(() => parseArgs(["--max-bytes", "0"])).toThrow(/whole number of bytes/);
  });
  it("rejects unknown flags and a bad limit", () => {
    expect(() => parseArgs(["--delete"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--limit", "0"])).toThrow(/whole number/);
  });
});
