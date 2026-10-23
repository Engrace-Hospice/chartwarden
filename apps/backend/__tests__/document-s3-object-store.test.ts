// apps/backend/__tests__/document-s3-object-store.test.ts — the production MinIO/S3 ObjectStorePort
// adapter (dependency-free SigV4 over fetch + node:crypto; closes the TASK-002 createRefusingObjectStore
// refusal for M22's render/presign/destroy paths).
//
// The SigV4 math is verified against the OFFICIAL AWS Signature Version 4 test-suite example values
// ("Authenticating Requests (AWS Signature Version 4)" — the examplebucket examples, 20130524, with the
// documented example credentials AKIAIOSFODNN7EXAMPLE / wJalrXUtnFXSbcqYW2ZPxRfiCYEXAMPLEKEY):
//   • the GET-object Authorization-header example  (signature f0e8bdb8…36bdb41)
//   • the PUT-object Authorization-header example  (signature 98ad7217…ce108bd — exercises UriEncode `$`)
//   • the presigned-GET query-string example        (signature aeeed9bb…604d404 — UNSIGNED-PAYLOAD)
// Plus: presign shape/TTL/determinism with an injected clock, the ListObjectVersions XML parser on
// fixtures, and putObject/destroyAllVersions flows over a mocked fetch (no network anywhere).
import { createHash } from "node:crypto";
import type { OrgId, SignedUrlDescriptor } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  createS3ObjectStore,
  createS3TenantStorageProvisioner,
  deriveTenantBucket,
  parseListObjectVersionsXml,
  s3ObjectStoreConfigFromEnv,
  sigV4AmzDate,
  sigV4CanonicalQuery,
  sigV4CanonicalRequest,
  sigV4Sha256Hex,
  sigV4Signature,
  sigV4SigningKey,
  sigV4StringToSign,
  sigV4UriEncode,
} from "../src/modules/22-documents/index";

// ── the official AWS SigV4 example fixtures ─────────────────────────────────────────────────────

const AWS_EXAMPLE_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
// The OFFICIAL AWS SigV4 S3 test-suite example secret (docs.aws.amazon.com sigv4 examples) —
// the whole point of these vectors is byte-exact reproduction, so the key must be verbatim.
const AWS_EXAMPLE_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const AWS_EXAMPLE_AMZ_DATE = "20130524T000000Z";
const AWS_EXAMPLE_DATE_STAMP = "20130524";
const AWS_EXAMPLE_SCOPE = `${AWS_EXAMPLE_DATE_STAMP}/us-east-1/s3/aws4_request`;
const AWS_EXAMPLE_HOST = "examplebucket.s3.amazonaws.com";
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const exampleSigningKey = () =>
  sigV4SigningKey({
    secretAccessKey: AWS_EXAMPLE_SECRET_KEY,
    dateStamp: AWS_EXAMPLE_DATE_STAMP,
    region: "us-east-1",
    service: "s3",
  });

const orgId = "00000000-0000-4000-9000-000000000001" as OrgId;

describe("SigV4 core — official AWS test-suite example values", () => {
  it("reproduces the GET-object Authorization-header example exactly", () => {
    const { text, signedHeaders } = sigV4CanonicalRequest({
      method: "GET",
      canonicalUri: "/test.txt",
      canonicalQuery: "",
      headers: {
        host: AWS_EXAMPLE_HOST,
        range: "bytes=0-9",
        "x-amz-content-sha256": EMPTY_BODY_SHA256,
        "x-amz-date": AWS_EXAMPLE_AMZ_DATE,
      },
      payloadHash: EMPTY_BODY_SHA256,
    });
    expect(signedHeaders).toBe("host;range;x-amz-content-sha256;x-amz-date");
    expect(text).toBe(
      [
        "GET",
        "/test.txt",
        "",
        `host:${AWS_EXAMPLE_HOST}`,
        "range:bytes=0-9",
        `x-amz-content-sha256:${EMPTY_BODY_SHA256}`,
        `x-amz-date:${AWS_EXAMPLE_AMZ_DATE}`,
        "",
        "host;range;x-amz-content-sha256;x-amz-date",
        EMPTY_BODY_SHA256,
      ].join("\n"),
    );
    // The documented canonical-request hash, string-to-sign, and final signature.
    expect(sigV4Sha256Hex(text)).toBe(
      "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
    );
    const stringToSign = sigV4StringToSign({
      amzDate: AWS_EXAMPLE_AMZ_DATE,
      scope: AWS_EXAMPLE_SCOPE,
      canonicalRequest: text,
    });
    expect(stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        AWS_EXAMPLE_AMZ_DATE,
        AWS_EXAMPLE_SCOPE,
        "7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972",
      ].join("\n"),
    );
    expect(sigV4Signature(exampleSigningKey(), stringToSign)).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("reproduces the PUT-object example (UriEncode of `$`, multi-header sort, real payload hash)", () => {
    const payloadHash = sigV4Sha256Hex("Welcome to Amazon S3.");
    expect(payloadHash).toBe("44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072");
    expect(sigV4UriEncode("test$file.text", false)).toBe("test%24file.text");
    const { text } = sigV4CanonicalRequest({
      method: "PUT",
      canonicalUri: "/test%24file.text",
      canonicalQuery: "",
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        host: AWS_EXAMPLE_HOST,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": AWS_EXAMPLE_AMZ_DATE,
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash,
    });
    const stringToSign = sigV4StringToSign({
      amzDate: AWS_EXAMPLE_AMZ_DATE,
      scope: AWS_EXAMPLE_SCOPE,
      canonicalRequest: text,
    });
    expect(sigV4Signature(exampleSigningKey(), stringToSign)).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("reproduces the presigned-GET query-string example (UNSIGNED-PAYLOAD)", () => {
    const canonicalQuery = sigV4CanonicalQuery([
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${AWS_EXAMPLE_ACCESS_KEY}/${AWS_EXAMPLE_SCOPE}`],
      ["X-Amz-Date", AWS_EXAMPLE_AMZ_DATE],
      ["X-Amz-Expires", "86400"],
      ["X-Amz-SignedHeaders", "host"],
    ]);
    expect(canonicalQuery).toBe(
      "X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host",
    );
    const { text } = sigV4CanonicalRequest({
      method: "GET",
      canonicalUri: "/test.txt",
      canonicalQuery,
      headers: { host: AWS_EXAMPLE_HOST },
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    expect(sigV4Sha256Hex(text)).toBe(
      "3bfa292879f6447bbcda7001decf97f4a54dc650c8942174ae0a9121cf58ad04",
    );
    const stringToSign = sigV4StringToSign({
      amzDate: AWS_EXAMPLE_AMZ_DATE,
      scope: AWS_EXAMPLE_SCOPE,
      canonicalRequest: text,
    });
    expect(sigV4Signature(exampleSigningKey(), stringToSign)).toBe(
      "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("formats the amz-date and encodes per the SigV4 UriEncode table", () => {
    expect(sigV4AmzDate(new Date("2013-05-24T00:00:00.000Z"))).toBe(AWS_EXAMPLE_AMZ_DATE);
    expect(sigV4UriEncode("a b/c~d-e_f.g", false)).toBe("a%20b/c~d-e_f.g");
    expect(sigV4UriEncode("a b/c", true)).toBe("a%20b%2Fc");
    expect(sigV4UriEncode("é", true)).toBe("%C3%A9"); // UTF-8 bytes, uppercase hex
  });
});

// ── presign via the adapter (injected clock; no network) ────────────────────────────────────────

const neverFetch = (async () => {
  throw new Error("presign must not perform network IO");
}) as unknown as typeof fetch;

const fixedNow = () => new Date("2013-05-24T00:00:00.000Z");

describe("createS3ObjectStore presign", () => {
  it("mints the EXACT documented AWS presigned URL for the official example inputs", async () => {
    // virtual-host style against s3.amazonaws.com reproduces the doc example end-to-end.
    const store = createS3ObjectStore(
      {
        endpoint: "https://s3.amazonaws.com",
        accessKeyId: AWS_EXAMPLE_ACCESS_KEY,
        secretAccessKey: AWS_EXAMPLE_SECRET_KEY,
        forcePathStyle: false,
      },
      { fetchImpl: neverFetch, now: fixedNow },
    );
    const descriptor: SignedUrlDescriptor = {
      bucket: "examplebucket",
      objectKey: "test.txt",
      ttlSeconds: 86_400,
      accessKind: "signed_url_issued",
    };
    const { url, expiresAt } = await store.presign({ descriptor, organizationId: orgId });
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt" +
        "?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
        "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request" +
        "&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host" +
        "&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    expect(expiresAt).toBe("2013-05-25T00:00:00.000Z");
  });

  it("optional responseOverrides (M36 chat attachments) are signed query params; absent => M22 URL unchanged", async () => {
    const store = createS3ObjectStore(
      {
        endpoint: "http://minio.local:9000",
        accessKeyId: AWS_EXAMPLE_ACCESS_KEY,
        secretAccessKey: AWS_EXAMPLE_SECRET_KEY,
      },
      { fetchImpl: neverFetch, now: fixedNow },
    );
    const descriptor: SignedUrlDescriptor = {
      bucket: "tenant-abc",
      objectKey: "messaging/c/a",
      ttlSeconds: 120,
      accessKind: "signed_url_issued",
    };
    const plain = await store.presign({ descriptor, organizationId: orgId });
    const forced = await store.presign({
      descriptor,
      organizationId: orgId,
      responseOverrides: { contentDisposition: "attachment", contentType: "application/pdf" },
    });
    expect(plain.url).not.toContain("response-content");
    expect(forced.url).toContain("response-content-disposition=attachment");
    expect(forced.url).toContain("response-content-type=application%2Fpdf");
    expect(forced.url).not.toBe(plain.url); // the signature covers the overrides
  });

  it("path-style (MinIO default): shape, descriptor TTL, deterministic under a fixed clock", async () => {
    const store = createS3ObjectStore(
      {
        endpoint: "http://minio.local:9000",
        accessKeyId: AWS_EXAMPLE_ACCESS_KEY,
        secretAccessKey: AWS_EXAMPLE_SECRET_KEY,
      },
      { fetchImpl: neverFetch, now: fixedNow },
    );
    const descriptor: SignedUrlDescriptor = {
      bucket: "tenant-abc",
      objectKey: "documents/ab/cd/render-1.pdf",
      ttlSeconds: 300,
      accessKind: "signed_url_issued",
    };
    const first = await store.presign({ descriptor, organizationId: orgId });
    const second = await store.presign({ descriptor, organizationId: orgId });
    expect(
      first.url.startsWith("http://minio.local:9000/tenant-abc/documents/ab/cd/render-1.pdf?"),
    ).toBe(true);
    expect(first.url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
    expect(first.url).toContain("X-Amz-Expires=300");
    expect(first.url).toContain("X-Amz-SignedHeaders=host");
    expect(first.url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(first.expiresAt).toBe("2013-05-24T00:05:00.000Z"); // clock + 300s
    expect(second.url).toBe(first.url); // SigV4 is deterministic under a fixed clock
  });

  it("uses the public endpoint only for presigned URLs", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 404 }));
    const store = createS3ObjectStore(
      {
        endpoint: "http://minio:9000",
        publicEndpoint: "https://storage.example.com",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
      { fetchImpl, now: fixedNow },
    );
    const result = await store.presign({
      descriptor: {
        bucket: "tenant-abc",
        objectKey: "documents/file.pdf",
        ttlSeconds: 300,
        accessKind: "signed_url_issued",
      },
      organizationId: orgId,
    });
    expect(result.url).toMatch(
      /^https:\/\/storage\.example\.com\/tenant-abc\/documents\/file\.pdf\?/,
    );
    const upload = await store.presignUpload({
      bucket: "tenant-abc",
      objectKey: "documents/file.pdf",
      mimeType: "application/pdf",
      sha256Hex: sigV4Sha256Hex("file"),
      ttlSeconds: 300,
    });
    expect(upload.url).toMatch(
      /^https:\/\/storage\.example\.com\/tenant-abc\/documents\/file\.pdf\?/,
    );
    await expect(
      store.inspectObject({ bucket: "tenant-abc", objectKey: "missing" }),
    ).resolves.toBeNull();
    expect(calls.map((call) => call.url)).toEqual(["http://minio:9000/tenant-abc/missing"]);
  });

  it("falls back to the 300s default on a non-positive TTL and clamps to the SigV4 7-day max", async () => {
    const store = createS3ObjectStore(
      {
        endpoint: "http://minio.local:9000",
        accessKeyId: "k",
        secretAccessKey: "s",
      },
      { fetchImpl: neverFetch, now: fixedNow },
    );
    const base = { bucket: "b", objectKey: "k.pdf", accessKind: "signed_url_issued" as const };
    const zero = await store.presign({
      descriptor: { ...base, ttlSeconds: 0 },
      organizationId: orgId,
    });
    expect(zero.url).toContain(`X-Amz-Expires=${DEFAULT_PRESIGN_TTL_SECONDS}`);
    const huge = await store.presign({
      descriptor: { ...base, ttlSeconds: 10_000_000 },
      organizationId: orgId,
    });
    expect(huge.url).toContain("X-Amz-Expires=604800");
  });

  it("fails fast at construction on a bad endpoint", () => {
    expect(() =>
      createS3ObjectStore({ endpoint: "not a url", accessKeyId: "k", secretAccessKey: "s" }),
    ).toThrow(/absolute URL/);
    expect(() =>
      createS3ObjectStore({ endpoint: "ftp://x", accessKeyId: "k", secretAccessKey: "s" }),
    ).toThrow(/http/);
    expect(() =>
      createS3ObjectStore({
        endpoint: "http://minio:9000",
        publicEndpoint: "not a url",
        accessKeyId: "k",
        secretAccessKey: "s",
      }),
    ).toThrow(/absolute URL/);
  });
});

// ── env helper ──────────────────────────────────────────────────────────────────────────────────

describe("s3ObjectStoreConfigFromEnv", () => {
  it("returns null when the MinIO env contract is absent or partial (refusing adapter stays)", () => {
    expect(s3ObjectStoreConfigFromEnv({})).toBeNull();
    expect(s3ObjectStoreConfigFromEnv({ MINIO_ENDPOINT: "http://minio:9000" })).toBeNull();
    expect(
      s3ObjectStoreConfigFromEnv({
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_ACCESS_KEY: "  ",
        MINIO_SECRET_KEY: "s",
      }),
    ).toBeNull();
  });

  it("returns a path-style config (region optional, defaulting downstream)", () => {
    expect(
      s3ObjectStoreConfigFromEnv({
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_PUBLIC_ENDPOINT: "https://storage.example.com",
        MINIO_ACCESS_KEY: "ak",
        MINIO_SECRET_KEY: "sk",
      }),
    ).toEqual({
      endpoint: "http://minio:9000",
      publicEndpoint: "https://storage.example.com",
      accessKeyId: "ak",
      secretAccessKey: "sk",
      forcePathStyle: true,
    });
    expect(
      s3ObjectStoreConfigFromEnv({
        MINIO_ENDPOINT: "http://minio:9000",
        MINIO_ACCESS_KEY: "ak",
        MINIO_SECRET_KEY: "sk",
        MINIO_REGION: "eu-west-1",
      }),
    ).toMatchObject({ region: "eu-west-1" });
  });
});

// ── ListObjectVersions XML parser ───────────────────────────────────────────────────────────────

const VERSIONED_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>tenant-abc</Name>
  <Prefix>documents/key-1.pdf</Prefix>
  <KeyMarker></KeyMarker>
  <VersionIdMarker></VersionIdMarker>
  <MaxKeys>1000</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <Version>
    <Key>documents/key-1.pdf</Key>
    <VersionId>v2-newer</VersionId>
    <IsLatest>false</IsLatest>
    <Size>1024</Size>
  </Version>
  <DeleteMarker>
    <Key>documents/key-1.pdf</Key>
    <VersionId>dm-1</VersionId>
    <IsLatest>true</IsLatest>
  </DeleteMarker>
  <Version>
    <Key>documents/key-1.pdf</Key>
    <VersionId>v1-older</VersionId>
  </Version>
  <Version>
    <Key>documents/key-1.pdf.rendered-later</Key>
    <VersionId>other-key-version</VersionId>
  </Version>
</ListVersionsResult>`;

describe("parseListObjectVersionsXml", () => {
  it("extracts Version + DeleteMarker entries in document order", () => {
    const parsed = parseListObjectVersionsXml(VERSIONED_LIST_XML);
    expect(parsed.isTruncated).toBe(false);
    expect(parsed.entries).toEqual([
      { key: "documents/key-1.pdf", versionId: "v2-newer", kind: "version" },
      { key: "documents/key-1.pdf", versionId: "dm-1", kind: "delete-marker" },
      { key: "documents/key-1.pdf", versionId: "v1-older", kind: "version" },
      {
        key: "documents/key-1.pdf.rendered-later",
        versionId: "other-key-version",
        kind: "version",
      },
    ]);
  });

  it("unescapes XML entities in keys and defaults a missing VersionId to the null version", () => {
    const parsed = parseListObjectVersionsXml(
      `<ListVersionsResult><IsTruncated>false</IsTruncated>
        <Version><Key>a&amp;b &lt;c&gt;.pdf</Key></Version>
       </ListVersionsResult>`,
    );
    expect(parsed.entries).toEqual([{ key: "a&b <c>.pdf", versionId: "null", kind: "version" }]);
  });

  it("surfaces truncation markers", () => {
    const parsed = parseListObjectVersionsXml(
      `<ListVersionsResult><IsTruncated>true</IsTruncated>
        <NextKeyMarker>documents/key-1.pdf</NextKeyMarker>
        <NextVersionIdMarker>v-42</NextVersionIdMarker>
       </ListVersionsResult>`,
    );
    expect(parsed.isTruncated).toBe(true);
    expect(parsed.nextKeyMarker).toBe("documents/key-1.pdf");
    expect(parsed.nextVersionIdMarker).toBe("v-42");
  });
});

// ── putObject / verified upload / destroyAllVersions over a mocked fetch ────────────────────────

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Uint8Array | null;
}

function mockFetch(responder: (call: RecordedCall, index: number) => Response): {
  fetchImpl: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body instanceof Uint8Array ? init.body : null,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const testConfig = {
  endpoint: "http://minio.local:9000",
  accessKeyId: AWS_EXAMPLE_ACCESS_KEY,
  secretAccessKey: AWS_EXAMPLE_SECRET_KEY,
} as const;

describe("createS3ObjectStore putObject (mocked fetch)", () => {
  it("PUTs with a SigV4 Authorization header and returns the REAL sha256 of the bytes", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    const bytes = new TextEncoder().encode("%PDF-1.7 rendered bytes");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    const { sha256Hex } = await store.putObject({
      bucket: "tenant-abc",
      objectKey: "documents/ab/render-1.pdf",
      bytes,
    });
    expect(sha256Hex).toBe(expectedSha);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe("PUT");
    expect(call.url).toBe("http://minio.local:9000/tenant-abc/documents/ab/render-1.pdf");
    expect(call.body).toBe(bytes);
    // The upload signs the REAL payload hash — never UNSIGNED-PAYLOAD (§4.12 posture).
    expect(call.headers["x-amz-content-sha256"]).toBe(expectedSha);
    expect(call.headers["x-amz-date"]).toBe(AWS_EXAMPLE_AMZ_DATE);
    expect(call.headers["content-type"]).toBe("application/octet-stream");
    expect(call.headers.authorization).toMatch(
      new RegExp(
        `^AWS4-HMAC-SHA256 Credential=${AWS_EXAMPLE_ACCESS_KEY}/${AWS_EXAMPLE_SCOPE}, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$`,
      ),
    );
    // The signature is independently reproducible from the same canonical inputs.
    const { text, signedHeaders } = sigV4CanonicalRequest({
      method: "PUT",
      canonicalUri: "/tenant-abc/documents/ab/render-1.pdf",
      canonicalQuery: "",
      headers: {
        host: "minio.local:9000",
        "content-type": "application/octet-stream",
        "x-amz-content-sha256": expectedSha,
        "x-amz-date": AWS_EXAMPLE_AMZ_DATE,
      },
      payloadHash: expectedSha,
    });
    const expectedSignature = sigV4Signature(
      exampleSigningKey(),
      sigV4StringToSign({
        amzDate: AWS_EXAMPLE_AMZ_DATE,
        scope: AWS_EXAMPLE_SCOPE,
        canonicalRequest: text,
      }),
    );
    expect(call.headers.authorization).toBe(
      `AWS4-HMAC-SHA256 Credential=${AWS_EXAMPLE_ACCESS_KEY}/${AWS_EXAMPLE_SCOPE}, SignedHeaders=${signedHeaders}, Signature=${expectedSignature}`,
    );
  });

  it("fails LOUDLY on a non-2xx, naming only op/status/bucket/key (no URL, no secret)", async () => {
    const { fetchImpl } = mockFetch(() => new Response("denied", { status: 403 }));
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    const err = await store
      .putObject({ bucket: "tenant-abc", objectKey: "k.pdf", bytes: new Uint8Array([1]) })
      .then(
        () => null,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("putObject");
    expect(err!.message).toContain("403");
    expect(err!.message).not.toContain(AWS_EXAMPLE_SECRET_KEY);
    expect(err!.message).not.toContain("http://");
  });
});

describe("createS3TenantStorageProvisioner (mocked fetch)", () => {
  const prefixes = [
    "documents",
    "generated",
    "intake",
    "claims",
    "cost-reports",
    "exports",
  ] as const;
  const organizationId = "4f84bc52-d63e-49a6-9faf-a79496bed824";

  it("creates the exact M22 tenant bucket when absent and confirms every logical prefix", async () => {
    const { fetchImpl, calls } = mockFetch(
      (_, index) => new Response(null, { status: index === 0 ? 404 : 200 }),
    );
    const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });

    await expect(storage.ensureTenantPrefixes({ organizationId, prefixes })).resolves.toEqual({
      bucket: deriveTenantBucket(organizationId as OrgId),
      created: true,
      prefixesEnsured: [...prefixes],
    });
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "PUT"]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://minio.local:9000/tenant-4f84bc52-d63e-49a6-9faf-a79496bed824",
      "http://minio.local:9000/tenant-4f84bc52-d63e-49a6-9faf-a79496bed824",
    ]);
    expect(calls[1]?.body).toEqual(new Uint8Array());
  });

  it("is a no-op when the tenant bucket already exists", async () => {
    const { fetchImpl, calls } = mockFetch(() => new Response(null, { status: 200 }));
    const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });

    await expect(storage.ensureTenantPrefixes({ organizationId, prefixes })).resolves.toEqual({
      bucket: deriveTenantBucket(organizationId as OrgId),
      created: false,
      prefixesEnsured: [...prefixes],
    });
    expect(calls.map((c) => c.method)).toEqual(["HEAD"]);
  });

  describe("ensurePrefixExpiry (lifecycle rule)", () => {
    const noSuchConfig = `<Error><Code>NoSuchLifecycleConfiguration</Code></Error>`;
    const input = { organizationId, prefix: "m25-835/", days: 30 };
    const bodyText = (c: { body: Uint8Array | null }): string =>
      new TextDecoder().decode(c.body ?? new Uint8Array());

    it("PUTs one prefix-scoped expiry rule (with Content-MD5) when the bucket has no lifecycle config", async () => {
      const { fetchImpl, calls } = mockFetch((call) =>
        call.method === "GET"
          ? new Response(noSuchConfig, { status: 404 })
          : new Response(null, { status: 200 }),
      );
      const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });
      await expect(storage.ensurePrefixExpiry(input)).resolves.toEqual({ applied: true });
      expect(calls.map((c) => `${c.method} ${new URL(c.url).search}`)).toEqual([
        "GET ?lifecycle=",
        "PUT ?lifecycle=",
      ]);
      const xml = bodyText(calls[1] as never);
      expect(xml).toContain("<ID>cw-expire-m25-835</ID>");
      expect(xml).toContain("<Prefix>m25-835/</Prefix>");
      expect(xml).toContain("<Days>30</Days>");
      expect(xml).toContain("<NoncurrentDays>30</NoncurrentDays>");
      expect(calls[1]?.headers["content-md5"]).toBe(createHash("md5").update(xml).digest("base64"));
    });

    it("keeps the bucket's other rules when adding ours (PUT replaces the whole config)", async () => {
      const other =
        "<LifecycleConfiguration><Rule><ID>other</ID><Status>Enabled</Status><Filter><Prefix>x/</Prefix></Filter><Expiration><Days>5</Days></Expiration></Rule></LifecycleConfiguration>";
      const { fetchImpl, calls } = mockFetch((call) =>
        call.method === "GET"
          ? new Response(other, { status: 200 })
          : new Response(null, { status: 200 }),
      );
      const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });
      await storage.ensurePrefixExpiry(input);
      const xml = bodyText(calls[1] as never);
      expect(xml).toContain("<ID>other</ID>");
      expect(xml).toContain("<ID>cw-expire-m25-835</ID>");
      expect(xml.endsWith("</LifecycleConfiguration>")).toBe(true);
    });

    it("is a no-op when our rule is already present", async () => {
      const mine = `<LifecycleConfiguration><Rule><ID>cw-expire-m25-835</ID><Status>Enabled</Status></Rule></LifecycleConfiguration>`;
      const { fetchImpl, calls } = mockFetch(() => new Response(mine, { status: 200 }));
      const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });
      await expect(storage.ensurePrefixExpiry(input)).resolves.toEqual({ applied: false });
      expect(calls.map((c) => c.method)).toEqual(["GET"]);
    });

    it("fails loudly on an unexpected status and rejects a non-positive window", async () => {
      const { fetchImpl } = mockFetch(() => new Response(null, { status: 403 }));
      const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });
      await expect(storage.ensurePrefixExpiry(input)).rejects.toThrow(/getLifecycle.*403/);
      await expect(storage.ensurePrefixExpiry({ ...input, days: 0 })).rejects.toThrow(/days/);
    });
  });

  it("is idempotent across two successive calls", async () => {
    let exists = false;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "HEAD") return new Response(null, { status: exists ? 200 : 404 });
      exists = true;
      return new Response(null, { status: 200 });
    });
    const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });

    await storage.ensureTenantPrefixes({ organizationId, prefixes });
    await storage.ensureTenantPrefixes({ organizationId, prefixes });
    expect(calls.map((c) => c.method)).toEqual(["HEAD", "PUT", "HEAD"]);
  });

  it("treats a concurrent already-created bucket as idempotent", async () => {
    const { fetchImpl } = mockFetch(
      (call) => new Response(null, { status: call.method === "HEAD" ? 404 : 409 }),
    );
    const storage = createS3TenantStorageProvisioner(testConfig, { fetchImpl, now: fixedNow });

    await expect(storage.ensureTenantPrefixes({ organizationId, prefixes })).resolves.toMatchObject(
      {
        bucket: deriveTenantBucket(organizationId as OrgId),
        created: false,
        prefixesEnsured: [...prefixes],
      },
    );
  });

  it("fails explicitly when MinIO rejects the existence check or creation", async () => {
    const deniedHead = createS3TenantStorageProvisioner(testConfig, {
      fetchImpl: mockFetch(() => new Response(null, { status: 403 })).fetchImpl,
      now: fixedNow,
    });
    await expect(deniedHead.ensureTenantPrefixes({ organizationId, prefixes })).rejects.toThrow(
      /bucketExists.*403/,
    );

    const deniedCreate = createS3TenantStorageProvisioner(testConfig, {
      fetchImpl: mockFetch(
        (call) => new Response(null, { status: call.method === "HEAD" ? 404 : 500 }),
      ).fetchImpl,
      now: fixedNow,
    });
    await expect(deniedCreate.ensureTenantPrefixes({ organizationId, prefixes })).rejects.toThrow(
      /createBucket.*500/,
    );
  });
});

describe("createS3ObjectStore verified upload (mocked fetch)", () => {
  it("presigns a short-lived PUT with the declared MIME type and base64 SHA-256 checksum", async () => {
    const store = createS3ObjectStore(testConfig, { fetchImpl: neverFetch, now: fixedNow });
    const sha256Hex = createHash("sha256").update("verified upload").digest("hex");
    const result = await store.presignUpload({
      bucket: "tenant-abc",
      objectKey: "uploads/upload-id/object",
      mimeType: "application/pdf",
      sha256Hex,
      ttlSeconds: 900,
    });

    expect(result.url).toContain("X-Amz-Expires=900");
    expect(result.url).toContain("X-Amz-SignedHeaders=content-type%3Bhost%3Bx-amz-checksum-sha256");
    expect(result.headers).toEqual({
      "content-type": "application/pdf",
      "x-amz-checksum-sha256": Buffer.from(sha256Hex, "hex").toString("base64"),
    });
    expect(result.expiresAt).toBe("2013-05-24T00:15:00.000Z");
  });

  it("binds the exact byte length into the signature when contentLength is given (H1), and leaves other callers unchanged", async () => {
    const store = createS3ObjectStore(testConfig, { fetchImpl: neverFetch, now: fixedNow });
    const sha256Hex = createHash("sha256").update("verified upload").digest("hex");
    const base = {
      bucket: "tenant-abc",
      objectKey: "uploads/upload-id/object",
      mimeType: "application/pdf",
      sha256Hex,
      ttlSeconds: 900,
    };
    const bound = await store.presignUpload({ ...base, contentLength: 1234 });
    expect(bound.url).toContain(
      "X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bx-amz-checksum-sha256",
    );
    expect(bound.headers["content-length"]).toBe("1234");
    const other = await store.presignUpload({ ...base, contentLength: 1235 });
    expect(other.url).not.toBe(bound.url); // a different length is a different signature
    const unbound = await store.presignUpload(base);
    expect(unbound.url).not.toContain("content-length");
    expect(unbound.headers).not.toHaveProperty("content-length");
  });

  it("HEADs with checksum mode and normalizes verified metadata to lowercase hex", async () => {
    const sha256Hex = createHash("sha256").update("verified upload").digest("hex");
    const { fetchImpl, calls } = mockFetch(
      () =>
        new Response(null, {
          status: 200,
          headers: {
            "content-length": "4096",
            "content-type": "application/pdf; charset=binary",
            "x-amz-checksum-sha256": Buffer.from(sha256Hex, "hex").toString("base64"),
          },
        }),
    );
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });

    await expect(
      store.inspectObject({ bucket: "tenant-abc", objectKey: "uploads/upload-id/object" }),
    ).resolves.toEqual({ byteSize: 4096, mimeType: "application/pdf", sha256Hex });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("HEAD");
    expect(calls[0]?.headers["x-amz-checksum-mode"]).toBe("ENABLED");
    expect(calls[0]?.headers.authorization).toContain(
      "SignedHeaders=host;x-amz-checksum-mode;x-amz-content-sha256;x-amz-date",
    );
  });

  it("returns null for a missing staged object and rejects incomplete verification metadata", async () => {
    const missing = mockFetch(() => new Response(null, { status: 404 }));
    const missingStore = createS3ObjectStore(testConfig, {
      fetchImpl: missing.fetchImpl,
      now: fixedNow,
    });
    await expect(
      missingStore.inspectObject({ bucket: "tenant-abc", objectKey: "missing" }),
    ).resolves.toBeNull();

    const incomplete = mockFetch(
      () => new Response(null, { status: 200, headers: { "content-length": "10" } }),
    );
    const incompleteStore = createS3ObjectStore(testConfig, {
      fetchImpl: incomplete.fetchImpl,
      now: fixedNow,
    });
    await expect(
      incompleteStore.inspectObject({ bucket: "tenant-abc", objectKey: "incomplete" }),
    ).rejects.toThrow(/incomplete verified metadata/);
  });
});

describe("createS3ObjectStore getObject (mocked fetch, #658)", () => {
  const store = (respond: () => Response) =>
    createS3ObjectStore(testConfig, { fetchImpl: mockFetch(respond).fetchImpl, now: fixedNow });

  it("GETs the object bytes with a signed request", async () => {
    const m = mockFetch(() => new Response("ISA*00~", { status: 200 }));
    const s = createS3ObjectStore(testConfig, { fetchImpl: m.fetchImpl, now: fixedNow });
    const bytes = await s.getObject({ bucket: "tenant-abc", objectKey: "k", maxBytes: 1024 });
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe("ISA*00~");
    expect(m.calls[0]?.method).toBe("GET");
    expect(m.calls[0]?.headers.authorization).toContain("AWS4-HMAC-SHA256");
  });

  it("returns null for a missing object and refuses an over-size or failing read", async () => {
    await expect(
      store(() => new Response(null, { status: 404 })).getObject({
        bucket: "b",
        objectKey: "k",
        maxBytes: 10,
      }),
    ).resolves.toBeNull();
    await expect(
      store(() => new Response("x".repeat(11), { status: 200 })).getObject({
        bucket: "b",
        objectKey: "k",
        maxBytes: 10,
      }),
    ).rejects.toThrow(/exceeds/);
    // A chunked body with no content-length is cut off at the cap, not buffered whole.
    let pulled = 0;
    const chunked = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(new Uint8Array(6));
        if (pulled > 50) c.close();
      },
    });
    await expect(
      store(() => new Response(chunked, { status: 200 })).getObject({
        bucket: "tenant-abc",
        objectKey: "k",
        maxBytes: 10,
      }),
    ).rejects.toThrow(/exceeds/);
    expect(pulled).toBeLessThan(10);
    await expect(
      store(() => new Response(null, { status: 500 })).getObject({
        bucket: "b",
        objectKey: "k",
        maxBytes: 10,
      }),
    ).rejects.toThrow(/getObject.*500/);
  });
});

describe("createS3ObjectStore destroyAllVersions (mocked fetch)", () => {
  it("lists ?versions then DELETEs every version + delete-marker for the EXACT key, sequentially", async () => {
    const { fetchImpl, calls } = mockFetch((call) =>
      call.method === "GET"
        ? new Response(VERSIONED_LIST_XML, { status: 200 })
        : new Response(null, { status: 204 }),
    );
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    await store.destroyAllVersions({
      bucket: "tenant-abc",
      objectKey: "documents/key-1.pdf",
      organizationId: orgId,
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "DELETE", "DELETE"]);
    const list = calls[0]!;
    expect(list.url).toBe(
      "http://minio.local:9000/tenant-abc?prefix=documents%2Fkey-1.pdf&versions=",
    );
    // Bodyless signed requests carry the empty-body sha256, not UNSIGNED-PAYLOAD.
    expect(list.headers["x-amz-content-sha256"]).toBe(EMPTY_BODY_SHA256);
    // The `.rendered-later` prefix-collision key is NOT deleted — exact-key match only (D11 keys).
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      "http://minio.local:9000/tenant-abc/documents/key-1.pdf?versionId=v2-newer",
      "http://minio.local:9000/tenant-abc/documents/key-1.pdf?versionId=dm-1",
      "http://minio.local:9000/tenant-abc/documents/key-1.pdf?versionId=v1-older",
    ]);
  });

  it("handles the unversioned bucket (single null version → DELETE ?versionId=null)", async () => {
    const xml = `<ListVersionsResult><IsTruncated>false</IsTruncated>
      <Version><Key>k.pdf</Key><VersionId>null</VersionId><IsLatest>true</IsLatest></Version>
    </ListVersionsResult>`;
    const { fetchImpl, calls } = mockFetch((call) =>
      call.method === "GET"
        ? new Response(xml, { status: 200 })
        : new Response(null, { status: 204 }),
    );
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    await store.destroyAllVersions({ bucket: "b", objectKey: "k.pdf", organizationId: orgId });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    expect(calls[1]!.url).toBe("http://minio.local:9000/b/k.pdf?versionId=null");
  });

  it("pages a truncated listing via key-marker/version-id-marker", async () => {
    const page1 = `<ListVersionsResult><IsTruncated>true</IsTruncated>
      <NextKeyMarker>k.pdf</NextKeyMarker><NextVersionIdMarker>v-1</NextVersionIdMarker>
      <Version><Key>k.pdf</Key><VersionId>v-1</VersionId></Version>
    </ListVersionsResult>`;
    const page2 = `<ListVersionsResult><IsTruncated>false</IsTruncated>
      <Version><Key>k.pdf</Key><VersionId>v-2</VersionId></Version>
    </ListVersionsResult>`;
    let listCount = 0;
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "GET") {
        listCount += 1;
        return new Response(listCount === 1 ? page1 : page2, { status: 200 });
      }
      return new Response(null, { status: 204 });
    });
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    await store.destroyAllVersions({ bucket: "b", objectKey: "k.pdf", organizationId: orgId });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "GET", "DELETE"]);
    expect(calls[2]!.url).toContain("key-marker=k.pdf");
    expect(calls[2]!.url).toContain("version-id-marker=v-1");
  });

  it("treats a 404 as already-gone (list 404 → no deletes; delete 404 tolerated)", async () => {
    const gone = mockFetch(() => new Response("no such bucket", { status: 404 }));
    const store1 = createS3ObjectStore(testConfig, { fetchImpl: gone.fetchImpl, now: fixedNow });
    await store1.destroyAllVersions({ bucket: "b", objectKey: "k.pdf", organizationId: orgId });
    expect(gone.calls.map((c) => c.method)).toEqual(["GET"]); // bucket gone ⇒ nothing to delete

    const xml = `<ListVersionsResult><IsTruncated>false</IsTruncated>
      <Version><Key>k.pdf</Key><VersionId>v-1</VersionId></Version>
    </ListVersionsResult>`;
    const partial = mockFetch((call) =>
      call.method === "GET"
        ? new Response(xml, { status: 200 })
        : new Response(null, { status: 404 }),
    );
    const store2 = createS3ObjectStore(testConfig, { fetchImpl: partial.fetchImpl, now: fixedNow });
    await expect(
      store2.destroyAllVersions({ bucket: "b", objectKey: "k.pdf", organizationId: orgId }),
    ).resolves.toBeUndefined(); // idempotent shred
  });

  it("fails LOUDLY when a delete errors (a shred that did not happen is never reported)", async () => {
    const xml = `<ListVersionsResult><IsTruncated>false</IsTruncated>
      <Version><Key>k.pdf</Key><VersionId>v-1</VersionId></Version>
    </ListVersionsResult>`;
    const { fetchImpl } = mockFetch((call) =>
      call.method === "GET"
        ? new Response(xml, { status: 200 })
        : new Response(null, { status: 500 }),
    );
    const store = createS3ObjectStore(testConfig, { fetchImpl, now: fixedNow });
    await expect(
      store.destroyAllVersions({ bucket: "b", objectKey: "k.pdf", organizationId: orgId }),
    ).rejects.toThrow(/destroyAllVersions:delete.*500/);
  });
});
