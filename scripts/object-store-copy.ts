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
// `--adopt-unchecksummed` (a one-off for a source whose objects were never written with a checksum; the MinIO ->
// SeaweedFS migration that needed it has run and is gone): a source object stored WITHOUT a checksum is copied with
// the SHA-256 of the bytes read, instead of failing; the target then verifies it.
// CW-DS-01, destruction tombstones (`--tombstones <file>` / OBJECT_COPY_TOMBSTONES_FILE, NDJSON from
// scripts/storage/object-tombstones.ts). The list is the authority on what a certificate destroyed, and it is applied on
// BOTH directions: an object it names is never copied to the target, and one already on the target is destroyed there
// (all versions), outside the mass-delete guard and also in a `--restore`. So a D12 erase reaches the copy on the next run
// even when its size would have tripped the guard, and a restore from a copy (or a hand load) cannot resurrect a destroyed
// document. The file is re-read on every run of the scheduled copy, so a cron that refreshes it keeps the copy current. A
// file that cannot be read stops the run before any object is touched. The destruction itself is a DRY RUN unless
// `--apply-tombstones` (OBJECT_COPY_TOMBSTONES_APPLY=1 for the schedule) says otherwise, and one run destroys at most
// `--max-deletions N` objects (OBJECT_COPY_TOMBSTONES_MAX_DELETIONS, default DEFAULT_MAX_TOMBSTONE_DELETIONS): a plan above
// the limit is refused whole (nothing destroyed, the run fails and pages) until the operator raises it on purpose. The counts
// are printed to stderr before anything is destroyed. (The forward copy's own delete-missing, bounded by the mass-delete
// guard above, is a separate path and is unchanged.)
// Not handled: a bucket dropped on the source keeps its objects on the copy; a created bucket gets no
// versioning or expiry rule (run the provisioner / backfill after a restore).
//
//   SOURCE_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION   the store read from
//   TARGET_S3_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION   the store written to
//   bun run scripts/object-store-copy.ts [--restore] [--adopt-unchecksummed] [--tombstones <file>
//                                        [--apply-tombstones] [--max-deletions <n>]]
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
import { readFile, writeFile } from "node:fs/promises";
import {
  type S3ObjectStoreConfig,
  type S3ObjectStoreDeps,
  SSE_ALGORITHM,
  createS3ObjectStore,
  createS3SignedFetch,
  ensureBucketDefaultEncryption,
} from "../apps/backend/src/modules/22-documents/seams/s3-object-store";
import {
  NO_TOMBSTONES,
  type TombstoneIndex,
  parseTombstones,
  tombstoneCount,
} from "./lib/object-tombstones";

const COPIED_BUCKET = /^(tenant-|chartwarden-)/;
export const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const LIST_PAGE = "1000";
/** Per-request bound: a hung store must fail the run, never stall it (a paused store accepts and never answers). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Deletions up to this count per bucket are always allowed; above it, at most MASS_DELETE_RATIO of the target. */
export const MASS_DELETE_FLOOR = 10;
const MASS_DELETE_RATIO = 0.1;
/** CW-DS-01 — most objects one run may destroy on the strength of the tombstone list (a bigger plan is refused whole). */
export const DEFAULT_MAX_TOMBSTONE_DELETIONS = 100;

/** CW-DS-01 — what the run did with the list: `dry-run` counts and reports, `apply` destroys, `refused` is `apply` over the limit. */
export type TombstoneMode = "off" | "dry-run" | "apply" | "refused";

/** The plan made before anything is destroyed. Counts only: the keys name erased patients. */
export interface TombstonePlan {
  readonly mode: TombstoneMode;
  /** Objects the list names (on any store). */
  readonly listed: number;
  readonly buckets: number;
  /** Listed objects the target holds: what an apply destroys. */
  readonly onTarget: number;
  readonly limit: number;
}

export interface CopyOptions {
  readonly requestTimeoutMs?: number;
  /** Delete target keys missing from the source (default true; false for a restore). */
  readonly deleteMissing?: boolean;
  /** Buckets the mass-delete guard does not apply to (deliberate, named one by one). */
  readonly allowMassDeleteBuckets?: ReadonlySet<string>;
  /** Copy a source object stored without a checksum with the SHA-256 of its bytes (migration only). */
  readonly adoptUnchecksummed?: boolean;
  /** CW-DS-01 — objects a destruction certificate destroyed: never copied, and destroyed on the target (also in a restore, outside the guard). */
  readonly tombstones?: TombstoneIndex;
  /** CW-DS-01 — destroy what the list names on the target. Anything but `true` is a dry run: counted, reported, not destroyed. */
  readonly applyTombstones?: boolean;
  /** CW-DS-01 — a plan that would destroy more than this many objects is refused whole (default DEFAULT_MAX_TOMBSTONE_DELETIONS). */
  readonly maxTombstoneDeletions?: number;
  /** Called once with the plan, after the target was counted and before anything is destroyed. */
  readonly onTombstonePlan?: (plan: TombstonePlan) => void;
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
  /** Tombstoned objects found on the target and destroyed there (counted apart from `deleted`, which the guard bounds). */
  readonly tombstoned: number;
  /** Tombstoned objects the source still held: left out of the copy. */
  readonly skippedTombstoned: number;
  /** CW-DS-01 — what the run did with the tombstone list, and how many listed objects the target held (what an apply destroys). */
  readonly tombstoneMode: TombstoneMode;
  readonly tombstonesOnTarget: number;
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
  /** CW-AC-05 — the target must hold every object encrypted (TARGET_S3_REQUIRE_SSE): default on its buckets, SSE on each put. */
  readonly encryptTarget: boolean;
  /** CW-DS-01 — per bucket, the listed keys this run destroys on the target: empty unless the plan is an accepted apply. */
  readonly destroyOnTarget: ReadonlyMap<string, ReadonlySet<string>>;
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

async function ensureBucket(
  fetchS3: SignedFetch,
  bucket: string,
  signal: Deadline,
  encrypt: boolean,
): Promise<void> {
  const head = await fetchS3({
    method: "HEAD",
    bucket,
    objectKey: null,
    query: [],
    payload: null,
    signal: signal(),
  });
  if (!head.ok) {
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
  // CW-AC-05 — a copy target that must encrypt gets the default on every bucket it holds, new or old.
  if (encrypt) await ensureBucketDefaultEncryption(fetchS3, bucket, signal);
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
  // A copy already on the target in the clear is not "unchanged" when the target must encrypt: it is rewritten.
  const encryptedEnough = !ctx.encryptTarget || existing?.serverSideEncryption === SSE_ALGORITHM;
  if (
    stored.sha256Hex &&
    existing?.sha256Hex === stored.sha256Hex &&
    existing.byteSize === byteSize &&
    encryptedEnough
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
  if (existing?.sha256Hex === sha256Hex && existing.byteSize === byteSize && encryptedEnough)
    return "unchanged";
  await target.putObject({ bucket, objectKey: key, bytes, mimeType, signal: signal() });
  const written = await target.inspectObject({ bucket, objectKey: key, signal: signal() });
  if (written?.sha256Hex !== sha256Hex || written.byteSize !== byteSize)
    throw new Error("target does not hold the source bytes after the copy");
  if (ctx.encryptTarget && written.serverSideEncryption !== SSE_ALGORITHM)
    throw new Error("target holds the copy but does not report it encrypted");
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
  tombstoned: number;
  skippedTombstoned: number;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * A tombstoned key names an ERASED patient (documents/<patientId>/...) and a failure entry reaches stdout and the alert webhook:
 * a stable hash prefix identifies it to whoever holds the list, without sending the id out.
 */
const keyLabel = (key: string): string =>
  `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
/** The adapter's error text names the key too. */
const withoutKey = (text: string, key: string): string => text.split(key).join("<key>");

/** CW-DS-01 — destroy (all versions) the planned tombstoned keys. Outside the mass-delete guard (a certificate says so), inside the run's cap. */
async function destroyTombstoned(
  bucket: string,
  planned: ReadonlySet<string>,
  ctx: CopyContext,
  tally: BucketTally,
  failed: CopyFailure[],
): Promise<void> {
  for (const key of planned) {
    try {
      await ctx.target.destroyAllVersions({
        bucket,
        objectKey: key,
        organizationId: "",
        signal: ctx.signal(),
      });
      tally.tombstoned++;
    } catch (error) {
      // The key names an ERASED patient (documents/<patientId>/...) and this entry reaches stdout and the alert webhook: a stable
      // hash prefix identifies it to whoever holds the list, without sending the id out.
      failed.push({
        bucket,
        key: keyLabel(key),
        reason: `tombstone: ${withoutKey(reasonOf(error), key)}`,
      });
    }
  }
}

/**
 * CW-DS-01 — count what the list would destroy on the target, then decide: dry run (the default) destroys nothing; an apply
 * within the limit destroys exactly the counted keys; an apply above it is refused whole (a failure, so the run exits 1 and the
 * schedule pages). A bucket whose listing fails is reported and left out of the plan, never guessed.
 */
async function planTombstones(
  ctx: Omit<CopyContext, "destroyOnTarget">,
  failed: CopyFailure[],
): Promise<{ report: TombstonePlan; destroy: ReadonlyMap<string, ReadonlySet<string>> }> {
  const { tombstones, applyTombstones, maxTombstoneDeletions } = ctx.options;
  const limit = maxTombstoneDeletions ?? DEFAULT_MAX_TOMBSTONE_DELETIONS;
  // NaN would make `onTarget > limit` false and lift the cap without a word: the CLI parser is not the only way in
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new Error(`maxTombstoneDeletions must be a whole number >= 1 (got ${limit})`);
  const index = tombstones ?? NO_TOMBSTONES;
  const found = new Map<string, ReadonlySet<string>>();
  let onTarget = 0;
  for (const [bucket, dead] of index) {
    try {
      const held = await listKeys(ctx.targetFetch, bucket, ctx.signal);
      const keys = held ? new Set([...dead].filter((key) => held.has(key))) : NO_KEYS;
      if (keys.size > 0) found.set(bucket, keys);
      onTarget += keys.size;
    } catch (error) {
      failed.push({ bucket, key: "", reason: `tombstone plan: ${reasonOf(error)}` });
    }
  }
  const listed = tombstoneCount(index);
  const mode: TombstoneMode =
    listed === 0
      ? "off"
      : applyTombstones !== true
        ? "dry-run"
        : onTarget > limit
          ? "refused"
          : "apply";
  if (mode === "refused")
    failed.push({
      bucket: "",
      key: "",
      reason: `refused to destroy ${onTarget} tombstoned object(s) (limit ${limit}; nothing was destroyed on the list's strength; raise it deliberately with --max-deletions or OBJECT_COPY_TOMBSTONES_MAX_DELETIONS)`,
    });
  return {
    report: { mode, listed, buckets: index.size, onTarget, limit },
    destroy: mode === "apply" ? found : new Map(),
  };
}

async function syncBucket(
  bucket: string,
  ctx: CopyContext,
  failed: CopyFailure[],
): Promise<BucketTally> {
  const { target, sourceFetch, targetFetch, signal, options } = ctx;
  const tally: BucketTally = {
    copied: 0,
    unchanged: 0,
    deleted: 0,
    tombstoned: 0,
    skippedTombstoned: 0,
  };
  const dead = options.tombstones?.get(bucket) ?? NO_KEYS;
  const planned = ctx.destroyOnTarget.get(bucket) ?? NO_KEYS;
  // listed a moment ago but gone now: skip it, deleting on the strength of a 404 is not safe
  const sourceKeys = await listKeys(sourceFetch, bucket, signal);
  if (!sourceKeys) {
    // A bucket the source no longer has still has its tombstoned objects destroyed on the target (a dropped bucket is
    // otherwise never removed there); nothing else is touched.
    await destroyTombstoned(bucket, planned, ctx, tally, failed);
    return tally;
  }
  await ensureBucket(targetFetch, bucket, signal, ctx.encryptTarget);
  for (const key of sourceKeys) {
    if (dead.has(key)) {
      tally.skippedTombstoned++; // destroyed by a certificate: never copied, whatever the source still holds
      continue;
    }
    try {
      tally[await copyObject(ctx, bucket, key)]++;
    } catch (error) {
      failed.push({ bucket, key, reason: reasonOf(error) });
    }
  }
  await destroyTombstoned(bucket, planned, ctx, tally, failed);
  if (options.deleteMissing === false) return tally;
  // the keys destroyed above are not part of what the guard counts; in a dry run or a refused plan nothing was, so the forward
  // copy treats a tombstoned key like any other (deleted under the guard when the source lost it)
  const targetKeys = (await listKeys(targetFetch, bucket, signal)) ?? new Set<string>();
  const liveSourceCount = sourceKeys.size - tally.skippedTombstoned;
  const liveTargetKeys = new Set([...targetKeys].filter((key) => !planned.has(key)));
  const doomed = [...liveTargetKeys].filter((key) => !sourceKeys.has(key));
  const refusal = options.allowMassDeleteBuckets?.has(bucket)
    ? null
    : massDeleteRefusal(liveSourceCount, liveTargetKeys.size, doomed.length);
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
      // A tombstoned key names an erased patient: it never reaches stdout or the alert webhook, even here (a dry run or a refused
      // plan leaves a listed key to this path when the source lost it).
      failed.push(
        dead.has(key)
          ? { bucket, key: keyLabel(key), reason: `delete: ${withoutKey(reasonOf(error), key)}` }
          : { bucket, key, reason: `delete: ${reasonOf(error)}` },
      );
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
  deps: S3ObjectStoreDeps = {},
): Promise<CopySummary> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const signal: Deadline = () => AbortSignal.timeout(timeoutMs);
  const base: Omit<CopyContext, "destroyOnTarget"> = {
    source: createS3ObjectStore(sourceConfig, deps),
    target: createS3ObjectStore(targetConfig, deps),
    sourceFetch: createS3SignedFetch(sourceConfig, deps, "object-store-copy:source"),
    targetFetch: createS3SignedFetch(targetConfig, deps, "object-store-copy:target"),
    signal,
    options,
    encryptTarget: targetConfig.requireServerSideEncryption === true,
  };
  const failed: CopyFailure[] = [];
  // Counted before anything is copied or destroyed: a refused plan fails the run up front, a dry run only reports.
  const plan = await planTombstones(base, failed);
  options.onTombstonePlan?.(plan.report);
  const ctx: CopyContext = { ...base, destroyOnTarget: plan.destroy };
  const total: BucketTally = {
    copied: 0,
    unchanged: 0,
    deleted: 0,
    tombstoned: 0,
    skippedTombstoned: 0,
  };
  // A bucket only the tombstone list names (dropped on the source) is still visited, so its destroyed objects go from the target.
  const buckets = [
    ...new Set([
      ...(await listBuckets(ctx.sourceFetch, signal)),
      ...(options.tombstones?.keys() ?? []),
    ]),
  ];
  for (const bucket of buckets) {
    try {
      const tally = await syncBucket(bucket, ctx, failed);
      total.copied += tally.copied;
      total.unchanged += tally.unchanged;
      total.deleted += tally.deleted;
      total.tombstoned += tally.tombstoned;
      total.skippedTombstoned += tally.skippedTombstoned;
    } catch (error) {
      failed.push({ bucket, key: "", reason: reasonOf(error) });
    }
  }
  return {
    buckets: buckets.length,
    ...total,
    tombstoneMode: plan.report.mode,
    tombstonesOnTarget: plan.report.onTarget,
    failed,
  };
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
    // CW-AC-05 — TARGET_S3_REQUIRE_SSE=1: the second copy holds every object encrypted or fails the object.
    requireServerSideEncryption: /^(1|true)$/i.test(env[`${prefix}_S3_REQUIRE_SSE`]?.trim() ?? ""),
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

/**
 * CW-DS-01 — a CLEAN scheduled run whose list still named objects the replica held and was not applied: nothing failed, so no
 * `object_copy.failed`, but the copy holds destroyed documents until OBJECT_COPY_TOMBSTONES_APPLY=1. Counts only. (The count is
 * taken at the start of the run: the forward copy's own delete-missing may already have removed some of them by its end.)
 */
export function tombstonesPendingBody(summary: CopySummary, now: Date): string {
  return JSON.stringify({
    kind: "object_copy.tombstones_pending",
    summary: `second copy: the tombstone list names ${summary.tombstonesOnTarget} object(s) the replica held at the start of the run and OBJECT_COPY_TOMBSTONES_APPLY is not 1, so nothing was destroyed on the list's strength`,
    details: {
      tombstoneMode: summary.tombstoneMode,
      tombstonesOnTarget: summary.tombstonesOnTarget,
      deleted: summary.deleted,
      skippedTombstoned: summary.skippedTombstoned,
    },
    occurredAt: now.toISOString(),
  });
}

/**
 * CW-DS-01 — the tombstone list named by `--tombstones <file>` or OBJECT_COPY_TOMBSTONES_FILE, read fresh on every run. A file
 * that is named but cannot be read or parsed throws, so the run stops before touching an object (and the schedule pages).
 */
export async function loadTombstones(env: Env, argv: readonly string[]): Promise<TombstoneIndex> {
  const at = argv.indexOf("--tombstones");
  const path = (at >= 0 ? argv[at + 1] : env.OBJECT_COPY_TOMBSTONES_FILE)?.trim();
  if (at >= 0 && !path) throw new Error("--tombstones needs a file path");
  if (!path) return NO_TOMBSTONES;
  return parseTombstones(await readFile(path, "utf8"));
}

const WHOLE_NUMBER = /^[1-9]\d*$/;
const TOMBSTONE_FLAGS = ["--tombstones", "--apply-tombstones", "--max-deletions"] as const;

/** `--flag=value` is not understood and would be dropped silently (a restore that loads no list resurrects destroyed documents). */
export function assertNoEqualsForms(argv: readonly string[]): void {
  for (const arg of argv)
    for (const flag of TOMBSTONE_FLAGS)
      if (arg.startsWith(`${flag}=`))
        throw new Error(
          `${flag}= is not understood: pass the flag and its value as separate arguments`,
        );
}

/**
 * CW-DS-01 — how a run applies the list: a dry run unless `--apply-tombstones` / OBJECT_COPY_TOMBSTONES_APPLY=1, and at most
 * `--max-deletions <n>` / OBJECT_COPY_TOMBSTONES_MAX_DELETIONS objects per run (the flag wins). Throws on an apply value that is
 * not 1/0/true/false (a typo must not read as a dry run), on a limit that is not a whole number >= 1, and on either setting
 * without a list (it would be dropped silently). A one-off run passes `{}` as `env`: only the scheduled copy reads them there.
 */
export function tombstoneApplyFromArgs(
  env: Env,
  argv: readonly string[],
  listNamed: boolean,
): { readonly apply: boolean; readonly maxDeletions: number } {
  const applyText = env.OBJECT_COPY_TOMBSTONES_APPLY?.trim().toLowerCase() ?? "";
  if (!["", "0", "1", "true", "false"].includes(applyText))
    throw new Error(
      "OBJECT_COPY_TOMBSTONES_APPLY must be 1 or 0 (anything else is refused, not read as a dry run)",
    );
  const apply = argv.includes("--apply-tombstones") || applyText === "1" || applyText === "true";
  const at = argv.indexOf("--max-deletions");
  const limitText = (at >= 0 ? argv[at + 1] : env.OBJECT_COPY_TOMBSTONES_MAX_DELETIONS)?.trim();
  if (!listNamed && (apply || at >= 0 || limitText))
    throw new Error(
      "--apply-tombstones, --max-deletions, OBJECT_COPY_TOMBSTONES_APPLY and OBJECT_COPY_TOMBSTONES_MAX_DELETIONS need a tombstone list (--tombstones <file> or OBJECT_COPY_TOMBSTONES_FILE)",
    );
  if (at >= 0 && !limitText) throw new Error("--max-deletions needs a whole number >= 1");
  if (!limitText) return { apply, maxDeletions: DEFAULT_MAX_TOMBSTONE_DELETIONS };
  if (!WHOLE_NUMBER.test(limitText))
    throw new Error(
      `${at >= 0 ? "--max-deletions" : "OBJECT_COPY_TOMBSTONES_MAX_DELETIONS"} needs a whole number >= 1 (got "${limitText}")`,
    );
  return { apply, maxDeletions: Number(limitText) };
}

/** The line printed (stderr) after the target was counted and before anything is destroyed. Counts only, never a key. */
export function describeTombstonePlan(plan: TombstonePlan): string {
  const head = `tombstones: the list names ${plan.listed} object(s) in ${plan.buckets} bucket(s); the target holds ${plan.onTarget} of them (limit ${plan.limit} per run).`;
  switch (plan.mode) {
    case "off":
      return `${head} Nothing to do.`;
    case "dry-run":
      return `${head} DRY RUN: nothing is destroyed on the strength of the list; re-run with --apply-tombstones (OBJECT_COPY_TOMBSTONES_APPLY=1) to destroy them.`;
    case "apply":
      return `${head} APPLYING: destroying ${plan.onTarget} object(s), every version.`;
    case "refused":
      return `${head} REFUSED: ${plan.onTarget} is over the limit ${plan.limit}; nothing is destroyed. Raise it deliberately with --max-deletions <n> (OBJECT_COPY_TOMBSTONES_MAX_DELETIONS) once you have checked the list.`;
  }
}

/**
 * CW-DS-01 — the apply/limit settings of one run. The scheduled copy takes them from the environment only; a one-off run takes
 * them from its flags only, so an OBJECT_COPY_TOMBSTONES_APPLY=1 a container inherited from .env.production can never turn the
 * dry run an operator typed into a destruction.
 */
export function resolveTombstoneSettings(
  env: Env,
  argv: readonly string[],
  scheduled: boolean,
): { readonly apply: boolean; readonly maxDeletions: number } {
  const named = argv.includes("--tombstones") || Boolean(env.OBJECT_COPY_TOMBSTONES_FILE?.trim());
  return tombstoneApplyFromArgs(scheduled ? env : {}, argv, named);
}

async function runOnce(env: Env, argv: readonly string[], scheduled = false): Promise<CopySummary> {
  assertNoEqualsForms(argv);
  const tombstones = await loadTombstones(env, argv);
  if (
    !scheduled &&
    (env.OBJECT_COPY_TOMBSTONES_APPLY?.trim() || env.OBJECT_COPY_TOMBSTONES_MAX_DELETIONS?.trim())
  )
    process.stderr.write(
      "note: OBJECT_COPY_TOMBSTONES_APPLY and OBJECT_COPY_TOMBSTONES_MAX_DELETIONS are for the scheduled copy only; this run takes --apply-tombstones and --max-deletions from its flags (default: dry run, limit 100)\n",
    );
  if (argv.includes("--restore") && tombstoneCount(tombstones) === 0)
    process.stderr.write(
      "warning: --restore without a tombstone list: objects destroyed since this copy was taken come back. Pass --tombstones <file> (docs/runbooks/object-destruction-copies.md)\n",
    );
  const { apply, maxDeletions } = resolveTombstoneSettings(env, argv, scheduled);
  return copyObjectStore(storeConfigFromEnv("SOURCE", env), storeConfigFromEnv("TARGET", env), {
    deleteMissing: !argv.includes("--restore"),
    adoptUnchecksummed: argv.includes("--adopt-unchecksummed"),
    tombstones,
    applyTombstones: apply,
    maxTombstoneDeletions: maxDeletions,
    onTombstonePlan: (plan) => {
      if (plan.mode !== "off") process.stderr.write(`${describeTombstonePlan(plan)}\n`);
    },
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
      summary = await runOnce(env, [], true);
    } catch (e) {
      error = e;
    }
    process.stdout.write(`${JSON.stringify(summary ?? { error: reasonOf(error) })}\n`);
    if (summary !== null && summary.failed.length === 0) {
      await writeFile(heartbeat, new Date().toISOString());
      // a clean copy is not a copy without destroyed documents: say so while the list is not being applied
      if (summary.tombstoneMode === "dry-run" && summary.tombstonesOnTarget > 0)
        await postAlert(env, tombstonesPendingBody(summary, new Date()));
    } else {
      await postAlert(env, alertBody(summary, error, new Date()));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalSeconds * 1000));
  }
}

async function postAlert(env: Env, body: string): Promise<void> {
  await fetch(env.OPS_ALERT_WEBHOOK_URL ?? "", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
  }).catch((e) => process.stderr.write(`alert webhook delivery failed: ${reasonOf(e)}\n`));
}

if (import.meta.main) {
  const everyAt = process.argv.indexOf("--every");
  if (everyAt >= 0) {
    const seconds = Number(process.argv[everyAt + 1]);
    if (!Number.isInteger(seconds) || seconds < MIN_INTERVAL_SECONDS)
      throw new Error(`--every needs whole seconds >= ${MIN_INTERVAL_SECONDS}`);
    // The schedule reads its list from OBJECT_COPY_TOMBSTONES_FILE (re-read each run): a flag here would be dropped silently.
    assertNoEqualsForms(process.argv);
    for (const flag of TOMBSTONE_FLAGS)
      if (process.argv.includes(flag))
        throw new Error(
          `--every does not take ${flag}: the schedule reads OBJECT_COPY_TOMBSTONES_FILE, OBJECT_COPY_TOMBSTONES_APPLY and OBJECT_COPY_TOMBSTONES_MAX_DELETIONS from its environment`,
        );
    await schedule(process.env, seconds);
  }
  const summary = await runOnce(process.env, process.argv);
  // Keys are PHI-free by construction (D11 opaque ids); the summary carries no object content.
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(summary.failed.length === 0 ? 0 : 1);
}
