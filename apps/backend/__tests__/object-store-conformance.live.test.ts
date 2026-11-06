// Object-store conformance — LIVE (ADR-0050 D6 "proof before cutover").
//
// Runs the REAL M22 SigV4 adapter (`s3-object-store.ts`) against whatever S3 endpoint the env names, and
// asserts every behaviour ChartWarden depends on. Production is moving MinIO -> SeaweedFS; CI runs this
// against SeaweedFS (scripts/object-store-conformance/seaweedfs-up.sh). Point it at any other store to
// compare: a red test here is a store that cannot hold ChartWarden's data, not a flaky test.
//
// Env (the suite skips when OBJECT_STORE_ENDPOINT is unset; everything else is then required):
//   OBJECT_STORE_ENDPOINT, OBJECT_STORE_REGION (default us-east-1)
//   OBJECT_STORE_ADMIN_ACCESS_KEY / _SECRET_KEY   store admin: bucket versioning + the out-of-scope bucket
//   OBJECT_STORE_APP_ACCESS_KEY / _SECRET_KEY     the app's scoped key (tenant-* / chartwarden-*), as in prod
//   OBJECT_STORE_AUDIT_SINK_PORT                  the suite listens here for the per-request audit records
//                                                 the store (or its log shipper) POSTs as JSON
import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { OrgId, SignedUrlDescriptor } from "@chartwarden/types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deriveTenantBucket } from "../src/modules/22-documents/lifecycle/storage";
import {
  type S3ObjectStoreConfig,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  parseListObjectVersionsXml,
  sigV4AmzDate,
  sigV4CanonicalQuery,
  sigV4CanonicalRequest,
  sigV4Sha256Hex,
  sigV4Signature,
  sigV4SigningKey,
  sigV4StringToSign,
  sigV4UriEncode,
} from "../src/modules/22-documents/seams/s3-object-store";

const env = process.env;
const ENDPOINT = env.OBJECT_STORE_ENDPOINT?.trim();
const REGION = env.OBJECT_STORE_REGION?.trim() || "us-east-1";
const AUDIT_SINK_PORT = Number(env.OBJECT_STORE_AUDIT_SINK_PORT);
const AUDIT_WAIT_MS = 20_000;
const AUDIT_POLL_MS = 250;
const EXPIRY_DAYS = 3;
const MIME = "application/pdf";

const credentials = (prefix: "ADMIN" | "APP"): S3ObjectStoreConfig => ({
  endpoint: ENDPOINT ?? "http://unset.invalid",
  region: REGION,
  accessKeyId: env[`OBJECT_STORE_${prefix}_ACCESS_KEY`] ?? "",
  secretAccessKey: env[`OBJECT_STORE_${prefix}_SECRET_KEY`] ?? "",
  forcePathStyle: true,
});

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const b64Sha256 = (bytes: Uint8Array): string =>
  Buffer.from(sigV4Sha256Hex(bytes), "hex").toString("base64");
const CHECKSUM_REFUSALS =
  /BadDigest|XAmzContentSHA256Mismatch|XAmzContentChecksumMismatch|InvalidDigest|InvalidRequest/;

/** A 4xx whose S3 error code matches `code` — a mis-signed request (SignatureDoesNotMatch) does not count. */
async function expectRefused(res: Response, code: RegExp): Promise<void> {
  const body = await res.text();
  expect(
    res.status,
    `expected a 4xx refusal, got ${res.status}: ${body.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(400);
  expect(res.status).toBeLessThan(500);
  expect(body, `refusal for the wrong reason: ${body.slice(0, 200)}`).toMatch(code);
}

const descriptorFor = (bucket: string, objectKey: string): SignedUrlDescriptor =>
  ({ bucket, objectKey, ttlSeconds: 60 }) as unknown as SignedUrlDescriptor;

/**
 * A raw header-signed S3 request — for the calls the adapter deliberately never makes (bucket versioning,
 * a forged checksum, an out-of-scope bucket). Built from the adapter's own exported SigV4 primitives.
 */
async function rawS3(
  config: S3ObjectStoreConfig,
  req: {
    readonly method: "GET" | "PUT" | "DELETE" | "HEAD";
    readonly bucket: string;
    readonly key?: string;
    readonly query?: readonly (readonly [string, string])[];
    readonly body?: Uint8Array;
    readonly headers?: Readonly<Record<string, string>>;
  },
): Promise<Response> {
  const url = new URL(config.endpoint);
  const amzDate = sigV4AmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const keyPath = req.key ? `/${sigV4UriEncode(req.key, false)}` : "";
  const canonicalUri = `/${sigV4UriEncode(req.bucket, true)}${keyPath}`;
  const canonicalQuery = sigV4CanonicalQuery(req.query ?? []);
  const payloadHash = sigV4Sha256Hex(req.body ?? new Uint8Array());
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...req.headers,
  };
  const canonical = sigV4CanonicalRequest({
    method: req.method,
    canonicalUri,
    canonicalQuery,
    headers,
    payloadHash,
  });
  const signature = sigV4Signature(
    sigV4SigningKey({
      secretAccessKey: config.secretAccessKey,
      dateStamp,
      region: REGION,
      service: "s3",
    }),
    sigV4StringToSign({ amzDate, scope, canonicalRequest: canonical.text }),
  );
  const { host: _host, ...send } = headers;
  return fetch(`${url.origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`, {
    method: req.method,
    headers: {
      ...send,
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${canonical.signedHeaders}, Signature=${signature}`,
    },
    ...(req.body
      ? { body: req.body as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"] }
      : {}),
  });
}

/** One audited S3 call, normalised from the MinIO/RustFS (`api.bucket`) or SeaweedFS (`bucket`/`key`) shape. */
interface AuditHit {
  readonly bucket: string;
  readonly key: string;
  readonly operation: string;
}

/** A POST body's records: a bare record (MinIO), an array (Fluent Bit) or a `{ Records: [...] }` envelope (RustFS). */
function auditRecordsOf(body: unknown): readonly unknown[] {
  const list = Array.isArray(body) ? body : [body];
  return list.flatMap((item) => {
    const records = (item as { Records?: unknown } | null)?.Records;
    return Array.isArray(records) ? records : [item];
  });
}

function normaliseAudit(record: unknown): AuditHit | null {
  if (typeof record !== "object" || record === null) return null;
  const r = record as Record<string, unknown>;
  const api = (typeof r.api === "object" && r.api !== null ? r.api : {}) as Record<string, unknown>;
  const bucket = r.bucket ?? api.bucket;
  const key = r.key ?? api.object;
  if (typeof bucket !== "string" || typeof key !== "string") return null;
  let decoded = key.replace(/^\//, "");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // keep the raw key; it simply will not match
  }
  return { bucket, key: decoded, operation: String(r.operation ?? api.name ?? "") };
}

describe.skipIf(!ENDPOINT)("object-store conformance — LIVE (ADR-0050 D6)", () => {
  const app = credentials("APP");
  const admin = credentials("ADMIN");
  // Built in beforeAll: a skipped describe still runs its body, and the adapter throws on empty credentials.
  let store!: ReturnType<typeof createS3ObjectStore>;
  let provisioner!: ReturnType<typeof createS3TenantStorageProvisioner>;
  const organizationId = randomUUID() as OrgId;
  const bucket = deriveTenantBucket(organizationId);
  const outOfScopeBucket = `cw-conformance-outside-${randomUUID().slice(0, 8)}`;
  const audit: AuditHit[] = [];
  let sink: Server | null = null;

  beforeAll(async () => {
    expect(app.accessKeyId, "OBJECT_STORE_APP_ACCESS_KEY is required").not.toBe("");
    expect(admin.accessKeyId, "OBJECT_STORE_ADMIN_ACCESS_KEY is required").not.toBe("");
    expect(
      Number.isInteger(AUDIT_SINK_PORT) && AUDIT_SINK_PORT > 0,
      "OBJECT_STORE_AUDIT_SINK_PORT is required",
    ).toBe(true);
    store = createS3ObjectStore(app);
    provisioner = createS3TenantStorageProvisioner(app);

    sink = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          for (const record of auditRecordsOf(parsed)) {
            const hit = normaliseAudit(record);
            if (hit) audit.push(hit);
          }
        } catch {
          // not a JSON batch: the audit test reports the missing record
        }
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      sink?.once("error", reject); // EADDRINUSE fails the suite instead of hanging beforeAll
      sink?.listen(AUDIT_SINK_PORT, "0.0.0.0", resolve);
    });

    // The scoped app key creates its own tenant bucket, exactly as M34 provisioning does.
    const ensured = await provisioner.ensureTenantPrefixes({ organizationId, prefixes: [] });
    expect(ensured.bucket).toBe(bucket);
    const outside = await rawS3(admin, { method: "PUT", bucket: outOfScopeBucket });
    expect(outside.ok, `admin creates ${outOfScopeBucket}: ${outside.status}`).toBe(true);
    const seed = { method: "PUT", bucket: outOfScopeBucket, key: "seed.txt" } as const;
    const seeded = await rawS3(admin, { ...seed, body: bytesOf("outside") });
    expect(seeded.ok, `admin seeds the out-of-scope bucket: ${seeded.status}`).toBe(true);
  });

  afterAll(async () => {
    sink?.closeAllConnections(); // the log shipper keeps its connection alive
    await new Promise<void>((resolve) => (sink ? sink.close(() => resolve()) : resolve()));
  });

  describe("checksums", () => {
    it("stores the upload's SHA-256 and returns it on HEAD with checksum mode", async () => {
      const key = `conformance/${randomUUID()}`;
      const bytes = bytesOf(`checksum body ${key}`);
      const { sha256Hex } = await store.putObject({
        bucket,
        objectKey: key,
        bytes,
        mimeType: MIME,
      });

      const inspected = await store.inspectObject({ bucket, objectKey: key });

      expect(inspected).toEqual({ byteSize: bytes.byteLength, mimeType: MIME, sha256Hex });
    });

    it("refuses an upload whose x-amz-checksum-sha256 does not match the bytes", async () => {
      const key = `conformance/${randomUUID()}`;

      const res = await rawS3(app, {
        method: "PUT",
        bucket,
        key,
        body: bytesOf("the real bytes"),
        headers: { "content-type": MIME, "x-amz-checksum-sha256": b64Sha256(bytesOf("other")) },
      });

      await expectRefused(res, CHECKSUM_REFUSALS);
      expect((await rawS3(admin, { method: "HEAD", bucket, key })).status).toBe(404);
    });

    it("refuses a presigned PUT whose body does not match the signed checksum", async () => {
      const key = `conformance/${randomUUID()}`;
      const signed = await store.presignUpload({
        bucket,
        objectKey: key,
        mimeType: MIME,
        sha256Hex: sigV4Sha256Hex(bytesOf("what was promised")),
        ttlSeconds: 60,
      });

      const res = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: bytesOf("what was sent instead"),
      });

      await expectRefused(res, CHECKSUM_REFUSALS);
      expect((await rawS3(admin, { method: "HEAD", bucket, key })).status).toBe(404);
    });
  });

  describe("presigned URLs", () => {
    it("a presigned PUT uploads and the stored checksum matches", async () => {
      const key = `conformance/${randomUUID()}`;
      const bytes = bytesOf(`presigned put ${key}`);
      const sha256Hex = sigV4Sha256Hex(bytes);
      const signed = await store.presignUpload({
        bucket,
        objectKey: key,
        mimeType: MIME,
        sha256Hex,
        ttlSeconds: 60,
        contentLength: bytes.byteLength,
      });

      const res = await fetch(signed.url, { method: "PUT", headers: signed.headers, body: bytes });

      expect(res.status).toBe(200);
      expect(await store.inspectObject({ bucket, objectKey: key })).toEqual({
        byteSize: bytes.byteLength,
        mimeType: MIME,
        sha256Hex,
      });
    });

    it("a presigned GET returns the bytes; a tampered signature is refused", async () => {
      const key = `conformance/${randomUUID()}`;
      const bytes = bytesOf(`presigned get ${key}`);
      await store.putObject({ bucket, objectKey: key, bytes, mimeType: MIME });
      const { url } = await store.presign({
        descriptor: descriptorFor(bucket, key),
        organizationId,
      });
      const flipped = url.replace(
        /X-Amz-Signature=([0-9a-f])/,
        (_m, c: string) => `X-Amz-Signature=${c === "0" ? "1" : "0"}`,
      );

      const ok = await fetch(url);
      const tampered = await fetch(flipped);

      expect(ok.status).toBe(200);
      expect(new Uint8Array(await ok.arrayBuffer())).toEqual(bytes);
      expect(tampered.status).toBe(403);
    });
  });

  describe("erase (D12 version-aware shred)", () => {
    const versionsOf = async (key: string): Promise<number> => {
      const query = [
        ["prefix", key],
        ["versions", ""],
      ] as const;
      const res = await rawS3(admin, { method: "GET", bucket, query });
      expect(res.ok, `ListObjectVersions answered ${res.status}`).toBe(true);
      const { entries } = parseListObjectVersionsXml(await res.text());
      return entries.filter((e) => e.key === key).length;
    };

    it("destroys every version and delete marker of the key, and only that key", async () => {
      const versioning = await rawS3(admin, {
        method: "PUT",
        bucket,
        query: [["versioning", ""]],
        body: bytesOf(
          '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>',
        ),
      });
      expect(versioning.ok, `PutBucketVersioning answered ${versioning.status}`).toBe(true);
      const key = `conformance/erase-${randomUUID()}`;
      const sibling = `${key}-sibling`; // shares the prefix: the exact-key guard must spare it
      await store.putObject({ bucket, objectKey: key, bytes: bytesOf("v1"), mimeType: MIME });
      await store.putObject({ bucket, objectKey: key, bytes: bytesOf("v2"), mimeType: MIME });
      await store.putObject({ bucket, objectKey: sibling, bytes: bytesOf("keep"), mimeType: MIME });
      expect((await rawS3(app, { method: "DELETE", bucket, key })).ok).toBe(true);
      expect(await versionsOf(key)).toBe(3); // v1, v2, the delete marker

      await store.destroyAllVersions({ bucket, objectKey: key, organizationId });

      expect(await versionsOf(key)).toBe(0);
      expect(await store.getObject({ bucket, objectKey: key, maxBytes: 1024 })).toBeNull();
      expect(await versionsOf(sibling)).toBe(1);
    });
  });

  describe("lifecycle", () => {
    it("the prefix-expiry rule is applied, then read back intact (idempotent second call)", async () => {
      const input = { organizationId, prefix: "m25-835/", days: EXPIRY_DAYS };

      const first = await provisioner.ensurePrefixExpiry(input);
      const second = await provisioner.ensurePrefixExpiry(input);

      expect(first.applied).toBe(true);
      // false only when the store returned our rule with its prefix, Days AND NoncurrentDays preserved
      expect(second.applied).toBe(false);
    });
  });

  describe("audit (GAP-141 download confirmation)", () => {
    it(
      "a presigned GET produces an audit record naming the bucket and key",
      async () => {
        const key = `conformance/audit-${randomUUID()}`;
        await store.putObject({
          bucket,
          objectKey: key,
          bytes: bytesOf("audited"),
          mimeType: MIME,
        });
        const { url } = await store.presign({
          descriptor: descriptorFor(bucket, key),
          organizationId,
        });
        expect((await fetch(url)).status).toBe(200);
        const isOurGet = (h: AuditHit): boolean =>
          h.bucket === bucket && h.key === key && /GET/i.test(h.operation);

        const deadline = Date.now() + AUDIT_WAIT_MS;
        while (!audit.some(isOurGet) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, AUDIT_POLL_MS));
        }

        expect(audit.some(isOurGet), `no GET audit record for ${key} in ${AUDIT_WAIT_MS}ms`).toBe(
          true,
        );
      },
      AUDIT_WAIT_MS + 5_000,
    );
  });

  describe("scoped app key (GAP-139)", () => {
    const refused = (res: Response): Promise<void> => expectRefused(res, /AccessDenied/);

    it("cannot read, list, write or delete in a bucket outside tenant-* / chartwarden-*", async () => {
      const seed = { bucket: outOfScopeBucket, key: "seed.txt" };

      await refused(await rawS3(app, { method: "GET", ...seed }));
      await refused(await rawS3(app, { method: "GET", bucket: outOfScopeBucket }));
      await refused(await rawS3(app, { method: "PUT", ...seed, body: bytesOf("overwritten") }));
      await refused(await rawS3(app, { method: "DELETE", ...seed }));

      const stillThere = await rawS3(admin, { method: "GET", ...seed });
      expect(stillThere.status).toBe(200);
      expect(await stillThere.text()).toBe("outside");
    });

    it("cannot create a bucket outside its scope", async () => {
      const rogue = `cw-conformance-rogue-${randomUUID().slice(0, 8)}`;

      await refused(await rawS3(app, { method: "PUT", bucket: rogue }));

      expect((await rawS3(admin, { method: "HEAD", bucket: rogue })).status).toBe(404);
    });
  });
});
