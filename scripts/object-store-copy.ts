// Object-store copy: mirror every tenant-* / chartwarden-* bucket from one S3 store to another, through the
// M22 adapter. It is the "second copy" job (primary -> RustFS on another host) and, with the two sides
// swapped, the restore. A generic S3 copier (rclone, mc mirror) is NOT a substitute: none of them carries the
// object's stored `x-amz-checksum-sha256`, and the app's verified reads (`inspectObject`) refuse an object
// without it, so a restore made with them leaves every upload unverifiable. Here every object is re-put with
// its SHA-256, and the result is verified by reading the checksum back from the target.
//
// Semantics: a one-way SYNC of current versions. A target object missing from the source is DELETED, so a
// D12 erase on the primary reaches the copy on the next run (the copy must never outlive an erasure). The copy
// is not a point-in-time archive; the off-site Object Lock backup (deploy/production/backup) stays the archive.
// Deletion is bounded: a bucket whose source is empty, or whose run would delete more than
// max(MASS_DELETE_FLOOR, 10%) of the target's keys, is left untouched and reported as failed (a primary that
// lost its data and was re-provisioned with empty buckets must not wipe the copy). ALLOW_MASS_DELETE=<bucket>[,<bucket>] lifts
// it for the named buckets only (e.g. a tenant whose last document was erased).
// A restore (`--restore`) never deletes: objects written to the primary since the last copy run survive it.
// The source's stored checksum is the reference: bytes that do not match it are never written to the target.
// `--adopt-unchecksummed` (the one-time MinIO -> SeaweedFS migration only): a source object stored WITHOUT a
// checksum is copied with the SHA-256 of the bytes read, instead of failing; the target then verifies it.
// Not handled: a bucket dropped on the source keeps its objects on the copy; a created bucket gets no
// versioning or expiry rule (run the provisioner / backfill after a restore).
//
//   SOURCE_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION   the store read from
//   TARGET_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION   the store written to
//   bun run scripts/object-store-copy.ts [--restore] [--adopt-unchecksummed]
//                                       # one run: prints a JSON summary; exit 1 if anything failed
//   bun run scripts/object-store-copy.ts --every <seconds>
//                                       # the scheduled second copy (compose.object-copy.yml): runs forever; each
//                                       # failed run posts to OPS_ALERT_WEBHOOK_URL (https), each clean run touches
//                                       # OBJECT_COPY_HEARTBEAT_FILE (the container healthcheck reads its age). The
//                                       # target must be https (the copy crosses hosts carrying PHI) unless
//                                       # OBJECT_COPY_ALLOW_PLAINTEXT_TARGET=1.
//
// ponytail: whole objects are buffered in memory (MAX_OBJECT_BYTES); stream them if documents outgrow that.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import {
  type S3ObjectStoreConfig,
  createS3ObjectStore,
  createS3SignedFetch,
} from "../apps/backend/src/modules/22-documents/seams/s3-object-store";

const COPIED_BUCKET = /^(tenant-|chartwarden-)/;
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const LIST_PAGE = "1000";
/** Per-request bound: a hung store must fail the run, never stall it (a paused store accepts and never answers). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Deletions up to this count per bucket are always allowed; above it, at most MASS_DELETE_RATIO of the target. */
export const MASS_DELETE_FLOOR = 10;
const MASS_DELETE_RATIO = 0.1;

export interface CopyOptions {
  readonly requestTimeoutMs?: number;
  /** Delete target keys missing from the source (default true; false for a restore). */
  readonly deleteMissing?: boolean;
  /** Buckets the mass-delete guard does not apply to (deliberate, named one by one). */
  readonly allowMassDeleteBuckets?: ReadonlySet<string>;
  /** Copy a source object stored without a checksum with the SHA-256 of its bytes (migration only). */
  readonly adoptUnchecksummed?: boolean;
}

export interface CopyFailure {
  readonly bucket: string;
  readonly key: string;
  readonly reason: string;
}

export interface CopySummary {
  readonly buckets: number;
  readonly copied: number;
  readonly unchanged: number;
  readonly deleted: number;
  readonly failed: readonly CopyFailure[];
}

type SignedFetch = ReturnType<typeof createS3SignedFetch>;
type Store = ReturnType<typeof createS3ObjectStore>;
type Deadline = () => AbortSignal;

interface CopyContext {
  readonly source: Store;
  readonly target: Store;
  readonly sourceFetch: SignedFetch;
  readonly targetFetch: SignedFetch;
  readonly signal: Deadline;
  readonly options: CopyOptions;
}

const xmlText = (block: string, tag: string): string[] =>
  [...block.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((m) => m[1] ?? "");
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
/** Continuation tokens are XML-escaped (SeaweedFS's token is the raw last key); keys are URL-encoded instead. */
export const xmlUnescape = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (entity, name: string) =>
    name.startsWith("#")
      ? String.fromCodePoint(
          name[1]?.toLowerCase() === "x"
            ? Number.parseInt(name.slice(2), 16)
            : Number(name.slice(1)),
        )
      : (XML_ENTITIES[name] ?? entity),
  );
const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function listBuckets(fetchS3: SignedFetch, signal: Deadline): Promise<string[]> {
  // ListBuckets is the service root: an empty bucket and no key sign to the canonical URI "/".
  const res = await fetchS3({
    method: "GET",
    bucket: "",
    objectKey: null,
    query: [],
    payload: null,
    signal: signal(),
  });
  if (!res.ok) throw new Error(`ListBuckets answered HTTP ${res.status}`);
  return xmlText(await res.text(), "Name").filter((name) => COPIED_BUCKET.test(name));
}

/** Every current key in the bucket, or null when the bucket does not exist. */
export async function listKeys(
  fetchS3: SignedFetch,
  bucket: string,
  signal: Deadline,
): Promise<Set<string> | null> {
  const keys = new Set<string>();
  let token: string | null = null;
  do {
    const query: (readonly [string, string])[] = [
      ["encoding-type", "url"], // keys come back URL-encoded: no XML-entity decoding to get wrong
      ["list-type", "2"],
      ["max-keys", LIST_PAGE],
      ...(token ? [["continuation-token", token] as const] : []),
    ];
    const res = await fetchS3({
      method: "GET",
      bucket,
      objectKey: null,
      query,
      payload: null,
      signal: signal(),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ListObjectsV2 ${bucket} answered HTTP ${res.status}`);
    const xml = await res.text();
    for (const block of xmlText(xml, "Contents")) {
      const [raw] = xmlText(block, "Key");
      if (raw !== undefined) keys.add(decodeURIComponent(raw.replace(/\+/g, "%20")));
    }
    if (xmlText(xml, "IsTruncated")[0] !== "true") return keys;
    const next = xmlText(xml, "NextContinuationToken")[0];
    // a partial listing would read as "deleted on the source"
    if (!next) throw new Error(`ListObjectsV2 ${bucket} is truncated without a continuation token`);
    token = xmlUnescape(next);
  } while (token);
  return keys;
}

async function ensureBucket(fetchS3: SignedFetch, bucket: string, signal: Deadline): Promise<void> {
  const head = await fetchS3({
    method: "HEAD",
    bucket,
    objectKey: null,
    query: [],
    payload: null,
    signal: signal(),
  });
  if (head.ok) return;
  const put = await fetchS3({
    method: "PUT",
    bucket,
    objectKey: null,
    query: [],
    payload: new Uint8Array(),
    signal: signal(),
  });
  if (!put.ok && put.status !== 409)
    throw new Error(`CreateBucket ${bucket} answered HTTP ${put.status}`);
}

const INCOMPLETE_METADATA = /incomplete verified metadata/;

/**
 * The source object's reference: its stored checksum, size and type. With `adoptUnchecksummed`, an object stored
 * without a checksum yields `sha256Hex: null` (size and type from a plain HEAD) instead of failing.
 */
async function sourceReference(
  ctx: CopyContext,
  bucket: string,
  key: string,
): Promise<{ sha256Hex: string | null; byteSize: number; mimeType: string }> {
  try {
    const stored = await ctx.source.inspectObject({ bucket, objectKey: key, signal: ctx.signal() });
    if (!stored) throw new Error("vanished from the source during the copy");
    return stored;
  } catch (error) {
    if (!ctx.options.adoptUnchecksummed || !INCOMPLETE_METADATA.test(reasonOf(error))) throw error;
  }
  const head = await ctx.sourceFetch({
    method: "HEAD",
    bucket,
    objectKey: key,
    query: [],
    payload: null,
    signal: ctx.signal(),
  });
  if (!head.ok) throw new Error(`HEAD answered HTTP ${head.status}`);
  return {
    sha256Hex: null,
    byteSize: Number(head.headers.get("content-length") ?? 0),
    mimeType:
      head.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
  };
}

/**
 * Copy one object unless the target already holds it (same stored SHA-256 and size; no download then). The
 * source's stored checksum is the reference: an object without one, or whose bytes do not match it, fails and
 * the target keeps whatever it had.
 */
async function copyObject(
  ctx: CopyContext,
  bucket: string,
  key: string,
): Promise<"copied" | "unchanged"> {
  const { source, target, signal } = ctx;
  const stored = await sourceReference(ctx, bucket, key);
  const { byteSize, mimeType } = stored;
  const existing = await target
    .inspectObject({ bucket, objectKey: key, signal: signal() })
    .catch(() => null);
  if (
    stored.sha256Hex &&
    existing?.sha256Hex === stored.sha256Hex &&
    existing.byteSize === byteSize
  )
    return "unchanged";
  const bytes = await source.getObject({
    bucket,
    objectKey: key,
    maxBytes: MAX_OBJECT_BYTES,
    signal: signal(),
  });
  if (!bytes) throw new Error("vanished from the source during the copy");
  const actual = createHash("sha256").update(bytes).digest("hex");
  // adopting: the bytes read ARE the reference (the target's read-back still verifies the write)
  const sha256Hex = stored.sha256Hex ?? actual;
  if (actual !== sha256Hex)
    throw new Error(
      "source bytes do not match the source's stored checksum; target left untouched",
    );
  // adopted object already copied (no source checksum to compare without the download): skip the rewrite
  if (existing?.sha256Hex === sha256Hex && existing.byteSize === byteSize) return "unchanged";
  await target.putObject({ bucket, objectKey: key, bytes, mimeType, signal: signal() });
  const written = await target.inspectObject({ bucket, objectKey: key, signal: signal() });
  if (written?.sha256Hex !== sha256Hex || written.byteSize !== byteSize)
    throw new Error("target does not hold the source bytes after the copy");
  return "copied";
}

/** Why the guard refuses this bucket's deletions, or null when they may proceed. */
export function massDeleteRefusal(
  sourceCount: number,
  targetCount: number,
  deleteCount: number,
): string | null {
  if (deleteCount === 0) return null;
  if (sourceCount === 0)
    return `refused to delete all ${deleteCount} objects: the source bucket is empty (ALLOW_MASS_DELETE=<bucket> to force)`;
  const limit = Math.max(MASS_DELETE_FLOOR, Math.floor(targetCount * MASS_DELETE_RATIO));
  return deleteCount > limit
    ? `refused to delete ${deleteCount} of ${targetCount} objects (limit ${limit}; ALLOW_MASS_DELETE=<bucket> to force)`
    : null;
}

interface BucketTally {
  copied: number;
  unchanged: number;
  deleted: number;
}

async function syncBucket(
  bucket: string,
  ctx: CopyContext,
  failed: CopyFailure[],
): Promise<BucketTally> {
  const { target, sourceFetch, targetFetch, signal, options } = ctx;
  const tally: BucketTally = { copied: 0, unchanged: 0, deleted: 0 };
  // listed a moment ago but gone now: skip it, deleting on the strength of a 404 is not safe
  const sourceKeys = await listKeys(sourceFetch, bucket, signal);
  if (!sourceKeys) return tally;
  await ensureBucket(targetFetch, bucket, signal);
  for (const key of sourceKeys) {
    try {
      tally[await copyObject(ctx, bucket, key)]++;
    } catch (error) {
      failed.push({ bucket, key, reason: reasonOf(error) });
    }
  }
  if (options.deleteMissing === false) return tally;
  const targetKeys = (await listKeys(targetFetch, bucket, signal)) ?? new Set<string>();
  const doomed = [...targetKeys].filter((key) => !sourceKeys.has(key));
  const refusal = options.allowMassDeleteBuckets?.has(bucket)
    ? null
    : massDeleteRefusal(sourceKeys.size, targetKeys.size, doomed.length);
  if (refusal) {
    failed.push({ bucket, key: "", reason: refusal });
    return tally;
  }
  for (const key of doomed) {
    try {
      await target.destroyAllVersions({
        bucket,
        objectKey: key,
        organizationId: "",
        signal: signal(),
      });
      tally.deleted++;
    } catch (error) {
      failed.push({ bucket, key, reason: `delete: ${reasonOf(error)}` });
    }
  }
  return tally;
}

/**
 * One-way sync of every copied bucket's current objects; see the file header. A failed object, or a failed
 * bucket-level call (list, create), is reported in `failed` and the run moves on to the next bucket; a bucket
 * whose listing failed deletes nothing. Only a failed ListBuckets rejects the run.
 */
export async function copyObjectStore(
  sourceConfig: S3ObjectStoreConfig,
  targetConfig: S3ObjectStoreConfig,
  options: CopyOptions = {},
): Promise<CopySummary> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal: Deadline = () => AbortSignal.timeout(timeoutMs);
  const ctx: CopyContext = {
    source: createS3ObjectStore(sourceConfig),
    target: createS3ObjectStore(targetConfig),
    sourceFetch: createS3SignedFetch(sourceConfig, {}, "object-store-copy:source"),
    targetFetch: createS3SignedFetch(targetConfig, {}, "object-store-copy:target"),
    signal,
    options,
  };
  const failed: CopyFailure[] = [];
  const total: BucketTally = { copied: 0, unchanged: 0, deleted: 0 };
  const buckets = await listBuckets(ctx.sourceFetch, signal);
  for (const bucket of buckets) {
    try {
      const tally = await syncBucket(bucket, ctx, failed);
      total.copied += tally.copied;
      total.unchanged += tally.unchanged;
      total.deleted += tally.deleted;
    } catch (error) {
      failed.push({ bucket, key: "", reason: reasonOf(error) });
    }
  }
  return { buckets: buckets.length, ...total, failed };
}

/** `<PREFIX>_S3_*` -> adapter config; throws naming the missing variable. */
export function storeConfigFromEnv(
  prefix: "SOURCE" | "TARGET",
  env: Record<string, string | undefined>,
): S3ObjectStoreConfig {
  const read = (name: string): string => {
    const value = env[`${prefix}_S3_${name}`]?.trim();
    if (!value) throw new Error(`${prefix}_S3_${name} is required`);
    return value;
  };
  return {
    endpoint: read("ENDPOINT"),
    accessKeyId: read("ACCESS_KEY"),
    secretAccessKey: read("SECRET_KEY"),
    region: env[`${prefix}_S3_REGION`]?.trim() || "us-east-1",
    forcePathStyle: true,
  };
}

const DEFAULT_HEARTBEAT_FILE = "/tmp/object-copy-last-success";
/** Failures listed in an alert: enough to start triage, bounded so one bad run cannot flood the pager. */
const ALERT_FAILURE_SAMPLE = 20;
const ALERT_TIMEOUT_MS = 10_000;
const MIN_INTERVAL_SECONDS = 60;

type Env = Record<string, string | undefined>;

/** The scheduled copy's preconditions: it never runs silently, and never ships PHI across hosts in plaintext. */
export function assertScheduleEnv(env: Env): void {
  if (!env.OPS_ALERT_WEBHOOK_URL?.startsWith("https://"))
    throw new Error(
      "OPS_ALERT_WEBHOOK_URL must be an https:// URL (a failing second copy must page someone)",
    );
  const target = env.TARGET_S3_ENDPOINT?.trim() ?? "";
  if (!target.startsWith("https://") && env.OBJECT_COPY_ALLOW_PLAINTEXT_TARGET !== "1")
    throw new Error(
      "TARGET_S3_ENDPOINT must be https:// (the copy crosses hosts); OBJECT_COPY_ALLOW_PLAINTEXT_TARGET=1 overrides",
    );
}

/** The alert body (cw-backup.sh's shape): counts and bucket/key ids only, never object content. */
export function alertBody(summary: CopySummary | null, error: unknown, now: Date): string {
  return JSON.stringify({
    kind: "object_copy.failed",
    summary: summary
      ? `second copy: ${summary.failed.length} failure(s) over ${summary.buckets} bucket(s)`
      : `second copy run aborted: ${reasonOf(error)}`,
    details: summary
      ? { ...summary, failed: summary.failed.slice(0, ALERT_FAILURE_SAMPLE) }
      : { error: reasonOf(error) },
    occurredAt: now.toISOString(),
  });
}

function runOnce(env: Env, argv: readonly string[]): Promise<CopySummary> {
  return copyObjectStore(storeConfigFromEnv("SOURCE", env), storeConfigFromEnv("TARGET", env), {
    deleteMissing: !argv.includes("--restore"),
    adoptUnchecksummed: argv.includes("--adopt-unchecksummed"),
    allowMassDeleteBuckets: new Set(
      (env.ALLOW_MASS_DELETE ?? "")
        .split(",")
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  });
}

/** The second copy: one forward sync every `intervalSeconds`, forever; a failed run pages, a clean run beats. */
async function schedule(env: Env, intervalSeconds: number): Promise<never> {
  assertScheduleEnv(env);
  const heartbeat = env.OBJECT_COPY_HEARTBEAT_FILE?.trim() || DEFAULT_HEARTBEAT_FILE;
  for (;;) {
    let summary: CopySummary | null = null;
    let error: unknown = null;
    try {
      summary = await runOnce(env, []);
    } catch (e) {
      error = e;
    }
    process.stdout.write(`${JSON.stringify(summary ?? { error: reasonOf(error) })}\n`);
    if (summary !== null && summary.failed.length === 0) {
      await writeFile(heartbeat, new Date().toISOString());
    } else {
      await fetch(env.OPS_ALERT_WEBHOOK_URL ?? "", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: alertBody(summary, error, new Date()),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      }).catch((e) => process.stderr.write(`alert webhook delivery failed: ${reasonOf(e)}\n`));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

if (import.meta.main) {
  const everyAt = process.argv.indexOf("--every");
  if (everyAt >= 0) {
    const seconds = Number(process.argv[everyAt + 1]);
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS)
      throw new Error(`--every needs whole seconds >= ${MIN_INTERVAL_SECONDS}`);
    await schedule(process.env, seconds);
  }
  const summary = await runOnce(process.env, process.argv);
  // Keys are PHI-free by construction (D11 opaque ids); the summary carries no object content.
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(summary.failed.length === 0 ? 0 : 1);
}
