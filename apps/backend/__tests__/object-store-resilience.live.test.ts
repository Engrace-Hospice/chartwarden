// Object-store resilience — LIVE: fault injection, tenant isolation and backup/restore for the chosen stores
// (SeaweedFS primary, RustFS second copy). Companion to object-store-conformance.live.test.ts, which proves the
// API surface; this proves the failure behaviour. Faults are real: the primary's container is paused (a hung
// store), restarted (durability), and has an upload connection cut mid-body.
//
// Env (the suite skips when OBJECT_STORE_ENDPOINT is unset; everything else is then required):
//   OBJECT_STORE_ENDPOINT / _REGION / _ADMIN_ACCESS_KEY / _ADMIN_SECRET_KEY / _APP_ACCESS_KEY / _APP_SECRET_KEY
//   OBJECT_STORE_CONTAINER          the primary's docker container (paused / restarted by the fault tests)
//   BACKUP_STORE_ENDPOINT / _ACCESS_KEY / _SECRET_KEY / _CONTAINER   the second copy (admin key) and its container
// Run: scripts/object-store-conformance/{seaweedfs,rustfs}-up.sh, then `bun run test:object-store:resilience:live`.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { connect } from "node:net";
import type { OrgId, SignedUrlDescriptor } from "@chartwarden/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyObjectStore, listKeys } from "../../../scripts/object-store-copy";
import { deriveTenantBucket } from "../src/modules/22-documents/lifecycle/storage";
import {
  type S3ObjectStoreConfig,
  createS3ObjectStore,
  createS3SignedFetch,
  createS3TenantStorageProvisioner,
} from "../src/modules/22-documents/seams/s3-object-store";

const env = process.env;
const ENDPOINT = env.OBJECT_STORE_ENDPOINT?.trim();
const REGION = env.OBJECT_STORE_REGION?.trim() || "us-east-1";
const PRIMARY_CONTAINER = env.OBJECT_STORE_CONTAINER?.trim() ?? "";
const BACKUP_CONTAINER = env.BACKUP_STORE_CONTAINER?.trim() ?? "";
const HUNG_STORE_TIMEOUT_MS = 1_500;
const READY_WAIT_MS = 60_000;
const READY_POLL_MS = 500;
const RESTART_OBJECTS = 20;
const LARGE_OBJECT_BYTES = 1024 * 1024;
const MIME = "application/pdf";
const MAX_BYTES = 8 * 1024 * 1024;
const FAULT_TEST_TIMEOUT_MS = 120_000;
const TENANT_BUCKET_PREFIX = "tenant-";

const config = (
  endpoint: string | undefined,
  access: string,
  secret: string,
): S3ObjectStoreConfig => ({
  endpoint: endpoint ?? "http://unset.invalid",
  region: REGION,
  accessKeyId: env[access] ?? "",
  secretAccessKey: env[secret] ?? "",
  forcePathStyle: true,
});
const primaryApp = config(ENDPOINT, "OBJECT_STORE_APP_ACCESS_KEY", "OBJECT_STORE_APP_SECRET_KEY");
const primaryAdmin = config(
  ENDPOINT,
  "OBJECT_STORE_ADMIN_ACCESS_KEY",
  "OBJECT_STORE_ADMIN_SECRET_KEY",
);
const backupAdmin = config(
  env.BACKUP_STORE_ENDPOINT?.trim(),
  "BACKUP_STORE_ACCESS_KEY",
  "BACKUP_STORE_SECRET_KEY",
);

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const docker = (...args: string[]): string => execFileSync("docker", args, { encoding: "utf8" });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const deadline = (): AbortSignal => AbortSignal.timeout(HUNG_STORE_TIMEOUT_MS);
const descriptorFor = (bucket: string, objectKey: string): SignedUrlDescriptor =>
  ({ bucket, objectKey, ttlSeconds: 60 }) as unknown as SignedUrlDescriptor;

/** Poll until the store answers an authenticated bucket HEAD again (after unpause / restart). */
async function waitReady(cfg: S3ObjectStoreConfig, bucket: string): Promise<void> {
  const fetchS3 = createS3SignedFetch(cfg, {}, "resilience:ready");
  const until = Date.now() + READY_WAIT_MS;
  while (Date.now() < until) {
    try {
      const head = { method: "HEAD", bucket, objectKey: null, query: [], payload: null } as const;
      if ((await fetchS3({ ...head, signal: deadline() })).ok) return;
    } catch {
      // not answering yet
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`store did not come back within ${READY_WAIT_MS}ms`);
}

/** The settled outcome of a promise, so a test can assert "rejected" without the rejection escaping. */
async function outcome(p: Promise<unknown>): Promise<"resolved" | "rejected"> {
  try {
    await p;
    return "resolved";
  } catch {
    return "rejected";
  }
}

/** Run `body` with `container` paused, and always unpause it. */
async function whilePaused<T>(container: string, body: () => Promise<T>): Promise<T> {
  docker("pause", container);
  try {
    return await body();
  } finally {
    docker("unpause", container);
  }
}

describe.skipIf(!ENDPOINT)("object-store resilience — LIVE", () => {
  let store!: ReturnType<typeof createS3ObjectStore>;
  let backup!: ReturnType<typeof createS3ObjectStore>;
  const orgA = randomUUID() as OrgId;
  const orgB = randomUUID() as OrgId;
  const bucketA = deriveTenantBucket(orgA);
  const bucketB = deriveTenantBucket(orgB);
  const put = (bucket: string, objectKey: string, bytes: Uint8Array) =>
    store.putObject({ bucket, objectKey, bytes, mimeType: MIME });
  const get = (s: ReturnType<typeof createS3ObjectStore>, bucket: string, objectKey: string) =>
    s.getObject({ bucket, objectKey, maxBytes: MAX_BYTES });
  const erase = (bucket: string, objectKey: string) =>
    store.destroyAllVersions({
      bucket,
      objectKey,
      organizationId: bucket.slice(TENANT_BUCKET_PREFIX.length),
    });

  beforeAll(async () => {
    const required = {
      OBJECT_STORE_APP_ACCESS_KEY: primaryApp.accessKeyId,
      OBJECT_STORE_ADMIN_ACCESS_KEY: primaryAdmin.accessKeyId,
      OBJECT_STORE_CONTAINER: PRIMARY_CONTAINER,
      BACKUP_STORE_ENDPOINT: env.BACKUP_STORE_ENDPOINT?.trim() ?? "",
      BACKUP_STORE_ACCESS_KEY: backupAdmin.accessKeyId,
      BACKUP_STORE_CONTAINER: BACKUP_CONTAINER,
    };
    for (const [name, value] of Object.entries(required)) {
      expect(value, `${name} is required`).not.toBe("");
    }
    store = createS3ObjectStore(primaryApp);
    backup = createS3ObjectStore(backupAdmin);
    const provisioner = createS3TenantStorageProvisioner(primaryApp);
    await provisioner.ensureTenantPrefixes({ organizationId: orgA, prefixes: [] });
    await provisioner.ensureTenantPrefixes({ organizationId: orgB, prefixes: [] });
  });

  afterAll(() => {
    // Never leave a store paused for the next suite, whatever failed (unpausing a running one just errors).
    for (const name of [PRIMARY_CONTAINER, BACKUP_CONTAINER]) {
      try {
        if (name) execFileSync("docker", ["unpause", name], { stdio: "ignore" });
      } catch {
        // was not paused
      }
    }
  });

  describe("fault injection", () => {
    it(
      "a hung (paused) store fails every call within the deadline; a timed-out write lands whole or not at all",
      async () => {
        const key = `resilience/hung-${randomUUID()}`;
        const eraseKey = `${key}-erase`;
        const before = bytesOf("before");
        const after = bytesOf("after, written while the store hung");
        await put(bucketA, key, before);
        await put(bucketA, eraseKey, before);
        const target = { bucket: bucketA, objectKey: key };

        const calls = await whilePaused(PRIMARY_CONTAINER, () =>
          Promise.all([
            outcome(
              store.putObject({ ...target, bytes: after, mimeType: MIME, signal: deadline() }),
            ),
            // a read must never turn a hung store into "not found" (null)
            outcome(store.getObject({ ...target, maxBytes: MAX_BYTES, signal: deadline() })),
            outcome(store.inspectObject({ ...target, signal: deadline() })),
            // an erase must never report a shred that did not happen
            outcome(
              store.destroyAllVersions({
                bucket: bucketA,
                objectKey: eraseKey,
                organizationId: orgA,
                signal: deadline(),
              }),
            ),
          ]),
        );
        await waitReady(primaryApp, bucketA);
        const landed = await get(store, bucketA, key);
        const landedMeta = await store.inspectObject(target);

        expect(calls).toEqual(["rejected", "rejected", "rejected", "rejected"]);
        // A client-side timeout is NOT "not written": the hung store may apply the buffered PUT once it resumes
        // (observed on SeaweedFS). What must hold is atomicity — the old bytes or the new, never a mix — and a
        // checksum that matches whichever landed. Callers treat a timed-out write as unknown and re-verify.
        expect([sha256(before), sha256(after)]).toContain(landed && sha256(landed));
        expect(landedMeta?.sha256Hex).toBe(landed && sha256(landed));
        // the rejected erase sent no DELETE: the object is still there, so the caller's retry is what erases it
        expect(await get(store, bucketA, eraseKey)).toEqual(before);
      },
      FAULT_TEST_TIMEOUT_MS,
    );

    it(
      "a restarted store keeps every acknowledged object with its checksum",
      async () => {
        const written = new Map<string, string>();
        for (let i = 0; i < RESTART_OBJECTS; i++) {
          const key = `resilience/restart-${randomUUID()}`;
          const { sha256Hex } = await put(bucketA, key, randomBytes(1024 + i));
          written.set(key, sha256Hex);
        }

        docker("restart", PRIMARY_CONTAINER);
        await waitReady(primaryApp, bucketA);

        for (const [key, sha] of written) {
          const meta = await store.inspectObject({ bucket: bucketA, objectKey: key });
          const bytes = await get(store, bucketA, key);
          expect(meta?.sha256Hex, key).toBe(sha);
          expect(bytes && sha256(bytes), key).toBe(sha);
        }
      },
      FAULT_TEST_TIMEOUT_MS,
    );

    it("an upload whose connection drops mid-body leaves no object", async () => {
      const key = `resilience/cut-${randomUUID()}`;
      const bytes = randomBytes(LARGE_OBJECT_BYTES);
      const signed = await store.presignUpload({
        bucket: bucketA,
        objectKey: key,
        mimeType: MIME,
        sha256Hex: sha256(bytes),
        ttlSeconds: 60,
        contentLength: bytes.byteLength,
      });
      const url = new URL(signed.url);
      const headers = Object.entries({ ...signed.headers, host: url.host })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");

      await new Promise<void>((resolve, reject) => {
        const socket = connect(Number(url.port), url.hostname, () => {
          socket.write(`PUT ${url.pathname}${url.search} HTTP/1.1\r\n${headers}\r\n\r\n`);
          socket.write(bytes.subarray(0, bytes.byteLength / 2), () => {
            socket.destroy(); // the client dies half-way through the body
            resolve();
          });
        });
        socket.on("error", reject);
      });
      await sleep(READY_POLL_MS);

      expect(await store.inspectObject({ bucket: bucketA, objectKey: key })).toBeNull();
    });

    it(
      "a copy run against a hung target fails loudly, and the next run completes verified",
      async () => {
        const key = `resilience/copy-fault-${randomUUID()}`;
        const bytes = bytesOf("must reach the copy");
        await put(bucketA, key, bytes);
        const failsOrReports = async (): Promise<void> => {
          const summary = await copyObjectStore(primaryAdmin, backupAdmin, {
            requestTimeoutMs: HUNG_STORE_TIMEOUT_MS,
          });
          if (summary.failed.length > 0) throw new Error("the run reported failures");
        };

        const hung = await whilePaused(BACKUP_CONTAINER, () => outcome(failsOrReports()));
        await sleep(READY_POLL_MS);
        const recovered = await copyObjectStore(primaryAdmin, backupAdmin);

        expect(hung).toBe("rejected");
        expect(recovered.failed).toEqual([]);
        const copied = await backup.inspectObject({ bucket: bucketA, objectKey: key });
        expect(copied?.sha256Hex).toBe(sha256(bytes));
      },
      FAULT_TEST_TIMEOUT_MS,
    );
  });

  describe("tenant isolation", () => {
    it("a presigned GET for tenant A cannot be re-pointed at tenant B's bucket or another key", async () => {
      const key = `isolation/${randomUUID()}`;
      await put(bucketA, key, bytesOf("tenant A"));
      await put(bucketB, key, bytesOf("tenant B"));
      await put(bucketA, `${key}-other`, bytesOf("tenant A other"));
      const { url } = await store.presign({
        descriptor: descriptorFor(bucketA, key),
        organizationId: orgA,
      });

      const own = await fetch(url);
      const otherTenant = await fetch(url.replace(`/${bucketA}/`, `/${bucketB}/`));
      const otherKey = await fetch(url.replace(`/${key}?`, `/${key}-other?`));

      expect(own.status).toBe(200);
      expect(await own.text()).toBe("tenant A");
      expect(otherTenant.status).toBe(403);
      expect(otherKey.status).toBe(403);
    });

    it("a presigned PUT for tenant A cannot write into tenant B's bucket", async () => {
      const key = `isolation/put-${randomUUID()}`;
      await put(bucketB, key, bytesOf("tenant B original"));
      const bytes = bytesOf("written by A");
      const signed = await store.presignUpload({
        bucket: bucketA,
        objectKey: key,
        mimeType: MIME,
        sha256Hex: sha256(bytes),
        ttlSeconds: 60,
      });

      const res = await fetch(signed.url.replace(`/${bucketA}/`, `/${bucketB}/`), {
        method: "PUT",
        headers: signed.headers,
        body: bytes,
      });

      expect(res.status).toBe(403);
      expect(await get(store, bucketB, key)).toEqual(bytesOf("tenant B original"));
    });

    it("erasing tenant A's object leaves tenant B's object with the same key", async () => {
      const key = `isolation/erase-${randomUUID()}`;
      await put(bucketA, key, bytesOf("A"));
      await put(bucketB, key, bytesOf("B"));

      await erase(bucketA, key);

      expect(await get(store, bucketA, key)).toBeNull();
      expect(await get(store, bucketB, key)).toEqual(bytesOf("B"));
    });

    it("a lifecycle rule set for tenant A does not appear on tenant B's bucket", async () => {
      const provisioner = createS3TenantStorageProvisioner(primaryApp);
      await provisioner.ensurePrefixExpiry({ organizationId: orgA, prefix: "m25-835/", days: 3 });
      const fetchS3 = createS3SignedFetch(primaryAdmin, {}, "resilience:lifecycle");

      const res = await fetchS3({
        method: "GET",
        bucket: bucketB,
        objectKey: null,
        query: [["lifecycle", ""]],
        payload: null,
      });
      const body = res.ok ? await res.text() : "";
      // positive control: the same probe on tenant A sees the rule, so an empty body above is not a failed probe
      const own = await fetchS3({
        method: "GET",
        bucket: bucketA,
        objectKey: null,
        query: [["lifecycle", ""]],
        payload: null,
      });

      expect(body).not.toContain("cw-expire:m25-835/");
      expect(own.status).toBe(200);
      expect(await own.text()).toContain("cw-expire:m25-835/");
    });
  });

  describe("backup and restore (primary -> RustFS copy -> primary)", () => {
    const fixtures = (): Map<string, Uint8Array> =>
      new Map<string, Uint8Array>([
        [`restore/${randomUUID()}/plain.pdf`, bytesOf("plain document")],
        [`restore/${randomUUID()}/nested/deep/path.pdf`, bytesOf("nested document")],
        [`restore/${randomUUID()}/unicodé ünïcode + spaces.pdf`, bytesOf("odd key")],
        [`restore/${randomUUID()}/large.bin`, randomBytes(LARGE_OBJECT_BYTES)],
        [`restore/${randomUUID()}/empty.bin`, new Uint8Array()],
      ]);

    it(
      "copies, survives the loss of the primary, restores byte-identical and verifiable, per tenant",
      async () => {
        const seeded = new Map([
          [bucketA, fixtures()],
          [bucketB, fixtures()],
        ]);
        for (const [bucket, objects] of seeded) {
          for (const [key, bytes] of objects) await put(bucket, key, bytes);
        }

        const copy = await copyObjectStore(primaryAdmin, backupAdmin);
        expect(copy.failed).toEqual([]);
        for (const [bucket, objects] of seeded) {
          for (const [key, bytes] of objects) {
            const onCopy = await backup.inspectObject({ bucket, objectKey: key });
            expect(onCopy?.sha256Hex, key).toBe(sha256(bytes));
          }
        }

        // Disaster: the primary lost its data and was re-provisioned with empty tenant buckets.
        const primaryFetch = createS3SignedFetch(primaryAdmin, {}, "resilience:disaster");
        for (const bucket of seeded.keys()) {
          const keys = await listKeys(primaryFetch, bucket, () => AbortSignal.timeout(10_000));
          for (const key of keys ?? []) await erase(bucket, key);
        }
        // The scheduled forward run must not mirror that loss onto the copy.
        const afterLoss = await copyObjectStore(primaryAdmin, backupAdmin);
        expect(afterLoss.deleted).toBe(0);
        for (const bucket of seeded.keys()) {
          expect(afterLoss.failed).toContainEqual(
            expect.objectContaining({
              bucket,
              reason: expect.stringMatching(/source bucket is empty/),
            }),
          );
        }
        // A restore never deletes: an object written to the primary after the last copy run survives it.
        const lateKey = `restore/late-${randomUUID()}`;
        await put(bucketA, lateKey, bytesOf("written after the last copy"));
        const restore = await copyObjectStore(backupAdmin, primaryAdmin, { deleteMissing: false });
        expect(await get(store, bucketA, lateKey)).toEqual(bytesOf("written after the last copy"));

        expect(restore.failed).toEqual([]);
        for (const [bucket, objects] of seeded) {
          const otherBucket = bucket === bucketA ? bucketB : bucketA;
          for (const [key, bytes] of objects) {
            // the app's VERIFIED read: the restored object carries its SHA-256, not just its bytes
            expect(await store.inspectObject({ bucket, objectKey: key }), key).toEqual({
              byteSize: bytes.byteLength,
              mimeType: MIME,
              sha256Hex: sha256(bytes),
            });
            expect(await get(store, otherBucket, key), `${key} leaked across tenants`).toBeNull();
          }
        }
        const [firstKey, firstBytes] = [...(seeded.get(bucketA) ?? [])][0] ?? [
          "",
          new Uint8Array(),
        ];
        const { url } = await store.presign({
          descriptor: descriptorFor(bucketA, firstKey),
          organizationId: orgA,
        });
        expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(firstBytes);
      },
      FAULT_TEST_TIMEOUT_MS,
    );

    it(
      "an erase on the primary reaches the copy on the next run, and an unchanged run copies nothing",
      async () => {
        const key = `restore/erase-${randomUUID()}`;
        // a sentinel keeps bucketA non-empty, so the empty-source guard does not apply whatever ran before
        await put(bucketA, `restore/sentinel-${randomUUID()}`, bytesOf("stays"));
        await put(bucketA, key, bytesOf("to erase"));
        await copyObjectStore(primaryAdmin, backupAdmin);
        expect(await get(backup, bucketA, key)).not.toBeNull();

        await erase(bucketA, key);
        const afterErase = await copyObjectStore(primaryAdmin, backupAdmin);
        const unchanged = await copyObjectStore(primaryAdmin, backupAdmin);

        expect(afterErase.deleted).toBeGreaterThanOrEqual(1);
        expect(await get(backup, bucketA, key)).toBeNull();
        expect(unchanged).toMatchObject({ copied: 0, deleted: 0, failed: [] });
      },
      FAULT_TEST_TIMEOUT_MS,
    );
  });
});
