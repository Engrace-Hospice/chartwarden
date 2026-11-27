// CW-AC-05 — re-encrypt the objects that were stored in the clear before server-side encryption (SSE-S3) was on.
//
// WHAT IT DOES. For every current object in every `tenant-*` / `chartwarden-*` bucket whose store does not report
// `x-amz-server-side-encryption: AES256`, it reads the bytes, checks them against the object's stored SHA-256, writes
// the same bytes back (the store encrypts the new version), and then proves the new version is encrypted, has the
// same SHA-256 and size, and that the ORIGINAL version still exists. It stops at the proof: it deletes nothing, ever.
//
// WHY THE SOURCE SURVIVES. The bucket must be versioned; the rewrite is a new version and the plaintext one becomes
// non-current. That plaintext version is still on the volume, so the cutover is not finished until the operator
// purges the versions this tool lists (`supersededVersionId` in the journal) with the commands in
// docs/runbooks/object-store-sse-cutover.md. An unversioned bucket is refused: rewriting in place would destroy the
// source, which this tool must not do. (The old MinIO volume is a separate copy; it is removed by hand, same runbook.)
//
// SAFE TO RUN AND RE-RUN. DRY-RUN BY DEFAULT: it lists what it would rewrite and writes nothing (no bucket change
// either). `--apply` rewrites. It is resumable because "needs work" is read from the store each time: an object that
// already reports AES256 is skipped, so an interrupted run continues where it stopped. `--journal <file>` (default
// ./object-store-reencrypt.ndjson, created 0600) appends an `intent` line BEFORE it rewrites an object and a `reencrypted`
// (or `failed`) line after; it is the operator's record and the purge list, never an input that could make the tool skip an
// object the store says is still plaintext. Object keys carry the patient's opaque id (`documents/<patientId>/...`): the journal
// is PHI-adjacent, keep it on the operator's host and delete it once the purge is done.
// A failed object is reported and the run moves on; exit 1 when anything failed. Pause tenant erasure and patient
// destruction while it runs: its read and its write are not one atomic step, so a destroy of the same key between them
// would be undone by the write.
//
//   OBJECT_STORE_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _REGION    an identity that can list, read, write and read
//                                                                  bucket versioning (the operator's admin key)
//   bun run scripts/storage/reencrypt-objects.ts [--apply] [--journal <file>] [--bucket <name>]... [--limit <n>]
//                                                [--adopt-unchecksummed] [--max-bytes <n>]
//   bun run scripts/storage/reencrypt-objects.ts --verify <journal>
//        READ-ONLY. Prints one NDJSON line per plaintext version the journal left: `purgeable` (the object's current version is
//        encrypted and reads back as the journaled bytes: safe to delete) or `hold` (not yet, with the reason). Exit 1 while
//        any is held. The operator deletes exactly the purgeable ones (the runbook); this tool never does.
//
// ponytail: sequential, whole objects in memory (MAX_OBJECT_BYTES, like the copy tool); parallelise or stream when a
// store outgrows an overnight run.
import { appendFile } from "node:fs/promises";
import {
  type S3ObjectStoreConfig,
  SSE_ALGORITHM,
  createS3ObjectStore,
  createS3SignedFetch,
  ensureBucketDefaultEncryption,
  sigV4Sha256Hex,
} from "../../apps/backend/src/modules/22-documents/seams/s3-object-store";
import { MAX_OBJECT_BYTES, listKeys } from "../object-store-copy";

const REENCRYPTED_BUCKET = /^(tenant-|chartwarden-)/;
const LIST_BUCKETS_KEY_RE = /<Name>([^<]*)<\/Name>/g;
export const DEFAULT_JOURNAL = "./object-store-reencrypt.ndjson";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/**
 * Objects are read whole (and a second copy is made while assembling them), so the default stays well under the memory of the
 * one-shot container the runbook uses; a larger object is reported, never skipped silently (raise --max-bytes and the memory).
 */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/** The journal could not be written: the run stops (the purge list is the point of the journal), it does not move on. */
export class JournalError extends Error {}

export interface ReencryptOptions {
  /** Write. Default false: report only, change nothing (not even a bucket's encryption default). */
  readonly apply?: boolean;
  /** Stop after rewriting this many objects (a staged run). */
  readonly limit?: number;
  /** Only these buckets (default: every tenant-* / chartwarden-* bucket). */
  readonly buckets?: ReadonlySet<string>;
  readonly requestTimeoutMs?: number;
  /** One call per rewritten or failed object (the CLI appends it to the journal file). */
  readonly journal?: (entry: JournalEntry) => Promise<void> | void;
  readonly now?: () => Date;
  /**
   * An object stored without a SHA-256 (the store has none to verify the source against): rewrite it anyway, using the
   * SHA-256 of the bytes read as the reference for the new version. The source's own integrity is then unproven; the
   * runbook asks for this only after a dry run names those objects.
   */
  readonly adoptUnchecksummed?: boolean;
  /** Objects larger than this are reported as failures and left alone (default {@link DEFAULT_MAX_BYTES}). */
  readonly maxBytes?: number;
}

export type JournalEntry =
  | {
      /** Written BEFORE the object is rewritten: a kill between the write and the `reencrypted` line still leaves the purge list. */
      readonly at: string;
      readonly status: "intent";
      readonly bucket: string;
      readonly key: string;
      readonly sha256Hex: string;
      readonly byteSize: number;
      readonly supersededVersionId: string;
    }
  | {
      readonly at: string;
      readonly status: "reencrypted";
      readonly bucket: string;
      readonly key: string;
      readonly sha256Hex: string;
      readonly byteSize: number;
      /** The plaintext version this run left in place: the operator purges it after verifying (runbook). */
      readonly supersededVersionId: string;
      readonly newVersionId: string;
    }
  | {
      readonly at: string;
      readonly status: "failed";
      readonly bucket: string;
      readonly key: string;
      readonly reason: string;
      /** Present only when the failure came after the `intent` line was written (the rewrite may have begun): the plaintext version a re-run will not list again. */
      readonly supersededVersionId?: string;
    };

export interface ReencryptFailure {
  readonly bucket: string;
  readonly key: string;
  readonly reason: string;
}

export interface ReencryptSummary {
  readonly mode: "dry-run" | "apply";
  readonly buckets: number;
  readonly objects: number;
  readonly alreadyEncrypted: number;
  /** Rewritten this run (apply) — each with a retained plaintext version listed in the journal. */
  readonly reencrypted: number;
  /** Plaintext objects a dry-run would rewrite (or an apply left for the next run because of --limit). */
  readonly pending: number;
  readonly pendingBytes: number;
  readonly failed: readonly ReencryptFailure[];
}

type SignedFetch = ReturnType<typeof createS3SignedFetch>;

interface Head {
  readonly byteSize: number;
  readonly mimeType: string;
  readonly sha256Hex: string | null;
  readonly encryption: string | null;
  readonly versionId: string | null;
}

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function headObject(
  fetchS3: SignedFetch,
  bucket: string,
  key: string,
  signal: AbortSignal,
  versionId?: string,
): Promise<Head | null> {
  const res = await fetchS3({
    method: "HEAD",
    bucket,
    objectKey: key,
    query: versionId ? [["versionId", versionId]] : [],
    payload: null,
    signal,
    extraHeaders: { "x-amz-checksum-mode": "ENABLED" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HEAD answered HTTP ${res.status}`);
  const checksum = res.headers.get("x-amz-checksum-sha256");
  return {
    byteSize: Number(res.headers.get("content-length") ?? Number.NaN),
    mimeType: res.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream",
    sha256Hex: checksum ? Buffer.from(checksum, "base64").toString("hex") : null,
    encryption: res.headers.get("x-amz-server-side-encryption"),
    versionId: res.headers.get("x-amz-version-id"),
  };
}

async function bucketIsVersioned(fetchS3: SignedFetch, bucket: string, signal: AbortSignal): Promise<boolean> {
  const res = await fetchS3({
    method: "GET",
    bucket,
    objectKey: null,
    query: [["versioning", ""]],
    payload: null,
    signal,
  });
  if (!res.ok) throw new Error(`GetBucketVersioning answered HTTP ${res.status} (run with the operator's admin key)`);
  return /<Status>\s*Enabled\s*<\/Status>/.test(await res.text());
}

async function journal(ctx: Ctx, entry: JournalEntry): Promise<void> {
  try {
    await ctx.options.journal?.(entry);
  } catch (error) {
    throw new JournalError(`journal write failed: ${reasonOf(error)}`);
  }
}

interface Ctx {
  readonly fetchS3: SignedFetch;
  readonly store: ReturnType<typeof createS3ObjectStore>;
  readonly signal: () => AbortSignal;
  readonly options: ReencryptOptions;
  readonly now: () => Date;
}

/** What {@link rewriteObject} hands on: the reference hash and size, never the bytes (they are dropped before the read-back). */
interface Rewritten {
  readonly reference: string;
  readonly size: number;
}

/**
 * Read the source, check it, journal the intent, write the encrypted version. Its own function so the object's bytes are out of
 * scope (collectable) before the read-back reads the new version: a 512 MiB object would otherwise be held twice or three times.
 * `intentWritten` is set the moment the intent line is on disk: a failure after that is a failure AFTER the write may have begun.
 */
async function rewriteObject(
  ctx: Ctx,
  bucket: string,
  key: string,
  before: Head,
  state: { intentWritten: boolean },
): Promise<Rewritten> {
  const { store, signal } = ctx;
  if (before.sha256Hex === null && ctx.options.adoptUnchecksummed !== true)
    throw new Error(
      "no stored SHA-256 to verify against (written without a checksum; --adopt-unchecksummed re-checks the new version against the bytes read)",
    );
  if (before.versionId === null)
    throw new Error("the store reported no version id, so the retained source cannot be proven");
  const bytes = await store.getObject({ bucket, objectKey: key, maxBytes: MAX_OBJECT_BYTES, signal: signal() });
  if (!bytes) throw new Error("vanished during the run");
  const actual = sigV4Sha256Hex(bytes);
  if (before.sha256Hex !== null && actual !== before.sha256Hex)
    throw new Error("the bytes read do not match the stored SHA-256; nothing was written");
  const reference = before.sha256Hex ?? actual;
  // The purge list is written first: if the process dies after the rewrite, the superseded version is still on record.
  await journal(ctx, {
    at: ctx.now().toISOString(),
    status: "intent",
    bucket,
    key,
    sha256Hex: reference,
    byteSize: bytes.byteLength,
    supersededVersionId: before.versionId,
  });
  state.intentWritten = true;
  // `putObject` names SSE-S3 and fails when the store does not confirm it.
  await store.putObject({ bucket, objectKey: key, bytes, mimeType: before.mimeType, signal: signal() });
  return { reference, size: bytes.byteLength };
}

/** Rewrite one plaintext object and prove the result; throws (and writes nothing more) when any proof fails. */
async function reencryptObject(
  ctx: Ctx,
  bucket: string,
  key: string,
  before: Head,
  state: { intentWritten: boolean },
): Promise<JournalEntry> {
  const { fetchS3, store, signal } = ctx;
  const { reference, size } = await rewriteObject(ctx, bucket, key, before, state);
  const superseded = before.versionId as string; // rewriteObject refused a null one

  const after = await headObject(fetchS3, bucket, key, signal());
  if (after?.encryption !== SSE_ALGORITHM) throw new Error("the rewritten object is not reported as encrypted");
  if (after.sha256Hex !== reference || after.byteSize !== size)
    throw new Error("the rewritten object does not have the source's SHA-256 and size");
  if (after.versionId === null || after.versionId === superseded)
    throw new Error("the rewrite did not create a new version, so the source may be gone");
  // The encrypted version must also DECRYPT to the same bytes: a purge deletes the only other readable copy.
  const readBack = await store.getObject({ bucket, objectKey: key, maxBytes: MAX_OBJECT_BYTES, signal: signal() });
  if (!readBack || sigV4Sha256Hex(readBack) !== reference)
    throw new Error("the encrypted version does not read back as the source's bytes");
  const source = await headObject(fetchS3, bucket, key, signal(), superseded);
  if (source === null || (before.sha256Hex !== null && source.sha256Hex !== before.sha256Hex))
    throw new Error("the plaintext source version is no longer readable after the rewrite");
  return {
    at: ctx.now().toISOString(),
    status: "reencrypted",
    bucket,
    key,
    sha256Hex: reference,
    byteSize: size,
    supersededVersionId: superseded,
    newVersionId: after.versionId,
  };
}

interface Tally {
  objects: number;
  alreadyEncrypted: number;
  reencrypted: number;
  pending: number;
  pendingBytes: number;
}

async function runBucket(
  ctx: Ctx,
  bucket: string,
  tally: Tally,
  failed: ReencryptFailure[],
  budget: { left: number },
): Promise<void> {
  const { options, signal } = ctx;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  // Versioning only matters for a bucket that holds plaintext: a bucket created after the cutover has none and needs no rewrite.
  let versioned: boolean | null = null;
  if (options.apply) await ensureBucketDefaultEncryption(ctx.fetchS3, bucket, signal);
  const keys = (await listKeys(ctx.fetchS3, bucket, signal)) ?? new Set<string>();
  for (const key of keys) {
    tally.objects++;
    let before: Head | null = null;
    const state = { intentWritten: false };
    try {
      before = await headObject(ctx.fetchS3, bucket, key, signal());
      if (!before) continue; // deleted since the listing
      if (before.encryption === SSE_ALGORITHM) {
        tally.alreadyEncrypted++;
        continue;
      }
      versioned ??= await bucketIsVersioned(ctx.fetchS3, bucket, signal());
      if (!versioned)
        throw new Error(
          "versioning is not enabled: a rewrite would overwrite the plaintext source, which this tool never does (enable versioning first)",
        );
      if (before.byteSize > maxBytes)
        throw new Error(
          `${before.byteSize} bytes is over --max-bytes ${maxBytes}: not rewritten (raise it and give the container more memory)`,
        );
      if (!options.apply || budget.left <= 0) {
        tally.pending++;
        tally.pendingBytes += Number.isFinite(before.byteSize) ? before.byteSize : 0;
        continue;
      }
      budget.left--;
      const entry = await reencryptObject(ctx, bucket, key, before, state);
      tally.reencrypted++;
      await journal(ctx, entry);
    } catch (error) {
      if (error instanceof JournalError) throw error;
      const reason = reasonOf(error);
      failed.push({ bucket, key, reason });
      await journal(ctx, {
        at: ctx.now().toISOString(),
        status: "failed",
        bucket,
        key,
        reason,
        // only once the intent was on disk: before that the version named here would be the object's one and only plaintext copy
        ...(state.intentWritten && before?.versionId ? { supersededVersionId: before.versionId } : {}),
      });
    }
  }
}

/** Dry-run (default) or apply over every matching bucket; see the file header. */
export async function reencryptObjectStore(
  config: S3ObjectStoreConfig,
  options: ReencryptOptions = {},
  deps: { readonly fetchImpl?: typeof fetch } = {},
): Promise<ReencryptSummary> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  // The rewrite always demands encryption, whatever the deployment flag says.
  const sseConfig: S3ObjectStoreConfig = { ...config, requireServerSideEncryption: true };
  const ctx: Ctx = {
    fetchS3: createS3SignedFetch(sseConfig, deps, "reencrypt-objects"),
    store: createS3ObjectStore(sseConfig, deps),
    signal: () => AbortSignal.timeout(timeoutMs),
    options,
    now: options.now ?? (() => new Date()),
  };
  const list = await ctx.fetchS3({
    method: "GET",
    bucket: "",
    objectKey: null,
    query: [],
    payload: null,
    signal: ctx.signal(),
  });
  if (!list.ok) throw new Error(`ListBuckets answered HTTP ${list.status}`);
  const names = [...(await list.text()).matchAll(LIST_BUCKETS_KEY_RE)]
    .map((m) => m[1] ?? "")
    .filter((n) => REENCRYPTED_BUCKET.test(n) && (!options.buckets || options.buckets.has(n)));
  const tally: Tally = { objects: 0, alreadyEncrypted: 0, reencrypted: 0, pending: 0, pendingBytes: 0 };
  const failed: ReencryptFailure[] = [];
  const budget = { left: options.limit ?? Number.POSITIVE_INFINITY };
  for (const bucket of names) {
    try {
      await runBucket(ctx, bucket, tally, failed, budget);
    } catch (error) {
      if (error instanceof JournalError) throw error;
      failed.push({ bucket, key: "", reason: reasonOf(error) });
    }
  }
  return { mode: options.apply ? "apply" : "dry-run", buckets: names.length, ...tally, failed };
}

export interface PurgeableVersion {
  readonly status: "purgeable";
  readonly bucket: string;
  readonly key: string;
  readonly supersededVersionId: string;
}

export interface HeldVersion {
  readonly status: "hold";
  readonly bucket: string;
  readonly key: string;
  readonly reason: string;
}

/**
 * `--verify <journal>`, READ-ONLY: decide which plaintext versions the journal left are SAFE to purge, so the operator deletes
 * only those. A version is purgeable when the object's CURRENT version is reported encrypted, carries the journaled SHA-256,
 * reads back as bytes with that SHA-256, and is not the superseded version itself. An object with a `failed` line is held (a
 * rewrite that failed after its write may have left a new version that does not decrypt), as is any check that fails; a
 * superseded version that is already gone needs nothing. It never writes or deletes.
 */
export async function verifyJournal(
  config: S3ObjectStoreConfig,
  journalText: string,
  options: { readonly requestTimeoutMs?: number } = {},
  deps: { readonly fetchImpl?: typeof fetch } = {},
): Promise<{
  readonly purgeable: PurgeableVersion[];
  readonly held: HeldVersion[];
  readonly alreadyPurged: number;
}> {
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const sseConfig: S3ObjectStoreConfig = { ...config, requireServerSideEncryption: true };
  const fetchS3 = createS3SignedFetch(sseConfig, deps, "reencrypt-objects:verify");
  const store = createS3ObjectStore(sseConfig, deps);
  const signal = (): AbortSignal => AbortSignal.timeout(timeoutMs);

  const intents = new Map<string, Extract<JournalEntry, { status: "intent" }>>();
  const failedKeys = new Set<string>();
  const lines = journalText.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch {
      throw new Error(`journal: line ${i + 1} is not JSON`);
    }
    const id = `${entry.bucket}\n${entry.key}`;
    if (entry.status === "intent") intents.set(id, entry);
    else if (entry.status === "failed") failedKeys.add(id);
  }

  const purgeable: PurgeableVersion[] = [];
  const held: HeldVersion[] = [];
  let alreadyPurged = 0;
  for (const [id, intent] of intents) {
    const { bucket, key } = intent;
    const hold = (reason: string): void => void held.push({ status: "hold", bucket, key, reason });
    if (failedKeys.has(id)) {
      hold("a rewrite of this object failed: look at the journal and re-run before purging");
      continue;
    }
    try {
      const superseded = await headObject(fetchS3, bucket, key, signal(), intent.supersededVersionId);
      if (superseded === null) {
        alreadyPurged++; // nothing left to purge
        continue;
      }
      const current = await headObject(fetchS3, bucket, key, signal());
      if (!current) hold("the object no longer exists");
      else if (current.encryption !== SSE_ALGORITHM)
        hold("the current version is not reported as encrypted");
      else if (current.versionId === intent.supersededVersionId)
        hold("the current version is still the plaintext one");
      else if (current.sha256Hex !== intent.sha256Hex)
        hold("the current version's SHA-256 is not the journaled one");
      else {
        const bytes = await store.getObject({
          bucket,
          objectKey: key,
          maxBytes: MAX_OBJECT_BYTES,
          signal: signal(),
        });
        if (!bytes || sigV4Sha256Hex(bytes) !== intent.sha256Hex)
          hold("the current version does not read back as the journaled bytes");
        else
          purgeable.push({
            status: "purgeable",
            bucket,
            key,
            supersededVersionId: intent.supersededVersionId,
          });
      }
    } catch (error) {
      hold(reasonOf(error));
    }
  }
  return { purgeable, held, alreadyPurged };
}

export function parseArgs(argv: readonly string[]): {
  apply: boolean;
  journal: string;
  buckets: Set<string>;
  limit: number | undefined;
  adoptUnchecksummed: boolean;
  maxBytes: number | undefined;
  verify: string | undefined;
} {
  const buckets = new Set<string>();
  let journal = DEFAULT_JOURNAL;
  let limit: number | undefined;
  let maxBytes: number | undefined;
  let verify: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply" || arg === "--adopt-unchecksummed") continue;
    if (arg === "--journal") journal = argv[++i] ?? "";
    else if (arg === "--verify") verify = argv[++i] ?? "";
    else if (arg === "--bucket") buckets.add(argv[++i] ?? "");
    else if (arg === "--limit") limit = Number(argv[++i]);
    else if (arg === "--max-bytes") maxBytes = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (verify !== undefined && !verify) throw new Error("--verify needs a journal file path");
  if (!journal) throw new Error("--journal needs a file path");
  if ([...buckets].some((b) => !b)) throw new Error("--bucket needs a bucket name");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
    throw new Error("--limit needs a whole number >= 1");
  if (maxBytes !== undefined && (!Number.isInteger(maxBytes) || maxBytes < 1))
    throw new Error("--max-bytes needs a whole number of bytes >= 1");
  return {
    apply: argv.includes("--apply"),
    journal,
    buckets,
    limit,
    adoptUnchecksummed: argv.includes("--adopt-unchecksummed"),
    maxBytes,
    verify,
  };
}

if (import.meta.main) {
  const {
    apply,
    journal: journalPath,
    buckets,
    limit,
    adoptUnchecksummed,
    maxBytes,
    verify,
  } = parseArgs(process.argv.slice(2));
  // A journal that cannot be written would lose the purge list: find out before touching a single object.
  if (apply) await appendFile(journalPath, "", { mode: 0o600 });
  const env = process.env;
  const endpoint = env.OBJECT_STORE_ENDPOINT?.trim();
  const accessKeyId = env.OBJECT_STORE_ACCESS_KEY?.trim();
  const secretAccessKey = env.OBJECT_STORE_SECRET_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey)
    throw new Error("OBJECT_STORE_ENDPOINT, OBJECT_STORE_ACCESS_KEY and OBJECT_STORE_SECRET_KEY are required");
  if (verify !== undefined) {
    // One NDJSON line per version: purgeable (safe to delete) or hold (not yet). Exit 1 while anything is held.
    const { readFile } = await import("node:fs/promises");
    const result = await verifyJournal(
      {
        endpoint,
        accessKeyId,
        secretAccessKey,
        region: env.OBJECT_STORE_REGION?.trim() || "us-east-1",
        forcePathStyle: true,
      },
      await readFile(verify, "utf8"),
    );
    for (const line of [...result.purgeable, ...result.held]) process.stdout.write(`${JSON.stringify(line)}\n`);
    process.stderr.write(
      `verify: ${result.purgeable.length} purgeable, ${result.held.length} held, ${result.alreadyPurged} already purged\n`,
    );
    process.exit(result.held.length === 0 ? 0 : 1);
  }
  const summary = await reencryptObjectStore(
    {
      endpoint,
      accessKeyId,
      secretAccessKey,
      region: env.OBJECT_STORE_REGION?.trim() || "us-east-1",
      forcePathStyle: true,
    },
    {
      apply,
      ...(buckets.size ? { buckets } : {}),
      ...(limit ? { limit } : {}),
      ...(adoptUnchecksummed ? { adoptUnchecksummed } : {}),
      ...(maxBytes ? { maxBytes } : {}),
      journal: (entry) => appendFile(journalPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
    },
  );
  // Keys carry opaque ids only (D11); the summary holds no object content, but it names keys: keep it with the journal.
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  process.exit(summary.failed.length === 0 ? 0 : 1);
}
