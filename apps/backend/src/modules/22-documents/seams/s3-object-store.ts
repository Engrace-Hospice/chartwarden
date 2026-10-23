// apps/backend/src/modules/22-documents/seams/s3-object-store.ts — the PRODUCTION
// {@link ObjectStorePort} adapter for MinIO/S3 (closes the TASK-002 refusal in
// ./drizzle-readers-store.ts `createRefusingObjectStore`).
//
// ZERO NEW DEPENDENCIES: the repo carries no `minio`/`@aws-sdk/*` package and adding one is a
// footprint decision this task does not make. AWS Signature V4 is a small, fully-specified,
// deterministic algorithm — implemented here directly over `fetch` + `node:crypto` (bun runtime):
//
//   • putObject          — HTTP PUT with a SigV4 `Authorization` HEADER; `x-amz-content-sha256`
//                          carries the REAL sha256 of the bytes (uploads never use UNSIGNED-PAYLOAD)
//                          and that same hex digest is the port's return value.
//   • presign            — SigV4 QUERY-STRING presigned GET (X-Amz-Algorithm/Credential/Date/
//                          Expires/SignedHeaders/Signature) with payload hash `UNSIGNED-PAYLOAD`
//                          (the one place UNSIGNED-PAYLOAD is legal here — a presigned GET cannot
//                          know the body). TTL comes from the descriptor's `ttlSeconds`, clamped to
//                          [1s, 7d]; a missing/non-positive TTL falls back to
//                          {@link DEFAULT_PRESIGN_TTL_SECONDS} (300s — short-TTL per §4.12).
//   • destroyAllVersions — D12 / DR-019 version-aware shred: `GET ?versions&prefix=<key>` (paged via
//                          key-marker/version-id-marker), collect every <Version> AND <DeleteMarker>
//                          whose <Key> EXACTLY equals the object key, then `DELETE ?versionId=…` per
//                          entry (sequential). An unversioned bucket lists the single null version
//                          (`<VersionId>null</VersionId>`) — deleted via `?versionId=null`. A 404 on
//                          the list (bucket gone) or on a delete (version already gone) is treated
//                          as already-destroyed; any other non-2xx fails LOUDLY so the eraser never
//                          reports a shred that did not happen.
//
// URLs are PATH-STYLE by default (`http(s)://endpoint/bucket/key` — the MinIO default);
// `forcePathStyle: false` switches to virtual-host style (`bucket.endpoint-host`). Region defaults
// to "us-east-1", service is "s3". The endpoint is used origin-only (no path-prefix support).
//
// SECURITY (§4.12): the secret key and every presigned URL stay OUT of logs and error messages —
// errors name only the operation, HTTP status, and the PHI-free (D11) bucket/objectKey pair.
// The clock and fetch are injectable so the SigV4 math is deterministic under test (the exported
// `sigV4*` helpers are verified against the official AWS SigV4 test-suite example values).
import { createHash, createHmac } from "node:crypto";
import type { IsoInstant, OrgId, SignedUrlDescriptor } from "@chartwarden/types";
import { deriveTenantBucket } from "../lifecycle/storage";
import type { ObjectReaderPort, ObjectStorePort } from "./store";

// ── config ──────────────────────────────────────────────────────────────────────────────────────

/** Typed config for {@link createS3ObjectStore}. `endpoint` is an absolute http(s) origin. */
export interface S3ObjectStoreConfig {
  /** Internal MinIO/S3 endpoint used for server-side IO, e.g. `http://minio:9000`. */
  readonly endpoint: string;
  /** Public origin used only in presigned URLs. Defaults to `endpoint`. */
  readonly publicEndpoint?: string;
  /** SigV4 region; defaults to `"us-east-1"` (the MinIO default). */
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Path-style URLs (`endpoint/bucket/key`) when true — the MinIO default. Defaults to TRUE. */
  readonly forcePathStyle?: boolean;
}

/** Injectable IO/clock seams so the adapter is deterministic + network-free under test. */
export interface S3ObjectStoreDeps {
  /** The HTTP client; defaults to the global `fetch` (bun runtime). */
  readonly fetchImpl?: typeof fetch;
  /** The clock every signature/expiry derives from; defaults to `() => new Date()`. */
  readonly now?: () => Date;
}

/** Result of an idempotent tenant-bucket ensure. Prefixes are logical S3 prefixes, not folders. */
export interface TenantStorageEnsureResult {
  readonly bucket: string;
  readonly created: boolean;
  readonly prefixesEnsured: readonly string[];
}

/**
 * Read the MinIO env contract and return a {@link S3ObjectStoreConfig}, or null when the deployment
 * has not configured object storage (MINIO_ENDPOINT / MINIO_ACCESS_KEY / MINIO_SECRET_KEY unset or
 * blank) — the composition root keeps the refusing adapter then, so a half-configured store can
 * never silently no-op. MINIO_REGION is optional (defaults to "us-east-1" downstream).
 */
export function s3ObjectStoreConfigFromEnv(
  env: Record<string, string | undefined>,
): S3ObjectStoreConfig | null {
  const endpoint = env.MINIO_ENDPOINT?.trim();
  const publicEndpoint = env.MINIO_PUBLIC_ENDPOINT?.trim();
  const accessKeyId = env.MINIO_ACCESS_KEY?.trim();
  const secretAccessKey = env.MINIO_SECRET_KEY?.trim();
  if (!endpoint || !accessKeyId || !secretAccessKey) return null;
  const region = env.MINIO_REGION?.trim();
  return {
    endpoint,
    ...(publicEndpoint ? { publicEndpoint } : {}),
    accessKeyId,
    secretAccessKey,
    ...(region ? { region } : {}),
    forcePathStyle: true,
  };
}

// ── SigV4 constants ─────────────────────────────────────────────────────────────────────────────

/** §4.12 short-TTL default when the descriptor carries no positive `ttlSeconds`. */
export const DEFAULT_PRESIGN_TTL_SECONDS = 300;
/** SigV4 hard maximum for `X-Amz-Expires` (7 days). */
const MAX_PRESIGN_TTL_SECONDS = 604_800;
const SIGV4_ALGORITHM = "AWS4-HMAC-SHA256";
const S3_SERVICE = "s3";
const DEFAULT_REGION = "us-east-1";
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
/** sha256("") — the payload hash for bodyless signed requests (GET list / DELETE). */
const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ── SigV4 pure helpers (exported for the deterministic official-test-vector tests) ──────────────

/** sha256 of bytes/utf8-string, lowercase hex. */
export function sigV4Sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `Date` → SigV4 `x-amz-date` (`YYYYMMDDTHHMMSSZ`); slice(0, 8) of it is the credential date. */
export function sigV4AmzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/**
 * AWS SigV4 "UriEncode": RFC 3986 unreserved chars pass through; everything else is %XX with
 * UPPERCASE hex over the UTF-8 bytes; `/` passes through only when `encodeSlash` is false (URI
 * paths — object keys keep their segment structure).
 */
export function sigV4UriEncode(value: string, encodeSlash: boolean): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (
      (b >= 0x41 && b <= 0x5a) || // A–Z
      (b >= 0x61 && b <= 0x7a) || // a–z
      (b >= 0x30 && b <= 0x39) || // 0–9
      ch === "-" ||
      ch === "_" ||
      ch === "." ||
      ch === "~" ||
      (!encodeSlash && ch === "/")
    ) {
      out += ch;
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Canonical query string: encode each name/value, sort by encoded name then value, join `k=v&…`. */
export function sigV4CanonicalQuery(params: readonly (readonly [string, string])[]): string {
  return params
    .map(([k, v]) => [sigV4UriEncode(k, true), sigV4UriEncode(v, true)] as const)
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

/**
 * Canonical request per the SigV4 spec: method, encoded URI, canonical query, canonical headers
 * (lowercased names, trimmed + inner-whitespace-collapsed values, sorted), signed-header list,
 * payload hash. Returns the canonical request text and the `SignedHeaders` value.
 */
export function sigV4CanonicalRequest(args: {
  readonly method: string;
  readonly canonicalUri: string;
  readonly canonicalQuery: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadHash: string;
}): { readonly text: string; readonly signedHeaders: string } {
  const entries = Object.entries(args.headers)
    .map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, " ")] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([k]) => k).join(";");
  const canonicalHeaders = entries.map(([k, v]) => `${k}:${v}\n`).join("");
  const text = [
    args.method,
    args.canonicalUri,
    args.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join("\n");
  return { text, signedHeaders };
}

/** `AWS4-HMAC-SHA256\n<amzDate>\n<scope>\n<hex(sha256(canonicalRequest))>`. */
export function sigV4StringToSign(args: {
  readonly amzDate: string;
  readonly scope: string;
  readonly canonicalRequest: string;
}): string {
  return [SIGV4_ALGORITHM, args.amzDate, args.scope, sigV4Sha256Hex(args.canonicalRequest)].join(
    "\n",
  );
}

/** The HMAC key-derivation chain (`AWS4<secret>` → date → region → service → `aws4_request`). */
export function sigV4SigningKey(args: {
  readonly secretAccessKey: string;
  readonly dateStamp: string;
  readonly region: string;
  readonly service: string;
}): Buffer {
  const kDate = hmac(`AWS4${args.secretAccessKey}`, args.dateStamp);
  const kRegion = hmac(kDate, args.region);
  const kService = hmac(kRegion, args.service);
  return hmac(kService, "aws4_request");
}

/** Final signature: hex(HMAC(signingKey, stringToSign)). */
export function sigV4Signature(signingKey: Buffer, stringToSign: string): string {
  return createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
}

// ── ListObjectVersions XML parsing (exported for the fixture test) ──────────────────────────────

/** One `<Version>`/`<DeleteMarker>` entry from a ListObjectVersions result. */
export interface ListedObjectVersion {
  readonly key: string;
  readonly versionId: string;
  readonly kind: "version" | "delete-marker";
}

/** The slice of a ListObjectVersions page {@link parseListObjectVersionsXml} extracts. */
export interface ParsedVersionList {
  readonly entries: readonly ListedObjectVersion[];
  readonly isTruncated: boolean;
  readonly nextKeyMarker: string | null;
  readonly nextVersionIdMarker: string | null;
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function unescapeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos);|&#x([0-9a-fA-F]+);|&#(\d+);/g, (m, hex, dec) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
    return XML_ENTITIES[m] ?? m;
  });
}

function firstTagText(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  return m?.[1] !== undefined ? unescapeXmlText(m[1]) : null;
}

/**
 * TINY TARGETED parser for the S3/MinIO `ListObjectVersions` (`GET ?versions`) result — NOT a
 * general XML parser. Documented assumptions (all hold for server-generated S3/MinIO responses):
 *   • `<Version>` / `<DeleteMarker>` blocks are non-nested, non-self-closed, and attribute-free;
 *   • each block's first `<Key>` / `<VersionId>` are the entry's values; a MISSING `<VersionId>`
 *     is treated as the unversioned null version (`"null"`);
 *   • text values use only standard XML entity/numeric escapes (no CDATA) — the request never asks
 *     for `encoding-type=url`, so keys arrive XML-escaped, not URL-encoded;
 *   • `<IsTruncated>` / `<NextKeyMarker>` / `<NextVersionIdMarker>` appear at most once.
 */
export function parseListObjectVersionsXml(xml: string): ParsedVersionList {
  const entries: ListedObjectVersion[] = [];
  const blockRe = /<(Version|DeleteMarker)>([\s\S]*?)<\/\1>/g;
  for (let m = blockRe.exec(xml); m !== null; m = blockRe.exec(xml)) {
    const tag = m[1];
    const block = m[2] ?? "";
    const key = firstTagText(block, "Key");
    if (key === null) continue; // a block with no <Key> is not an object entry
    entries.push({
      key,
      versionId: firstTagText(block, "VersionId") ?? "null",
      kind: tag === "Version" ? "version" : "delete-marker",
    });
  }
  return {
    entries,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
    nextKeyMarker: firstTagText(xml, "NextKeyMarker"),
    nextVersionIdMarker: firstTagText(xml, "NextVersionIdMarker"),
  };
}

// ── the adapter ─────────────────────────────────────────────────────────────────────────────────

interface ResolvedTarget {
  /** `protocol//host` to prefix the canonical URI with. */
  readonly origin: string;
  /** The `Host` header value the signature covers. */
  readonly host: string;
  /** SigV4-encoded URI path (`/bucket/seg/…` path-style; `/seg/…` virtual-host). */
  readonly canonicalUri: string;
}

function parseS3Endpoint(endpoint: string, constructorName: string): URL {
  try {
    const endpointUrl = new URL(endpoint);
    if (endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
      throw new Error("protocol");
    }
    return endpointUrl;
  } catch {
    throw new Error(
      `${constructorName}: \`endpoint\` must be an absolute URL using http(s) (e.g. http://minio.internal:9000)`,
    );
  }
}

function assertS3Credentials(config: S3ObjectStoreConfig, constructorName: string): void {
  if (!config.accessKeyId || !config.secretAccessKey) {
    throw new Error(`${constructorName}: accessKeyId and secretAccessKey are required`);
  }
}

function createS3SignedFetch(
  config: S3ObjectStoreConfig,
  deps: S3ObjectStoreDeps,
  constructorName: string,
): (args: {
  readonly method: "GET" | "PUT" | "DELETE" | "HEAD";
  readonly bucket: string;
  readonly objectKey: string | null;
  readonly query: readonly (readonly [string, string])[];
  readonly payload: Uint8Array | null;
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Aborts the HTTP request (M36 attachments bound every store call; additive, ignored by M22's own callers). */
  readonly signal?: AbortSignal;
}) => Promise<Response> {
  const endpointUrl = parseS3Endpoint(config.endpoint, constructorName);
  assertS3Credentials(config, constructorName);
  const region = config.region?.trim() || DEFAULT_REGION;
  const pathStyle = config.forcePathStyle !== false; // MinIO default: path-style
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? ((): Date => new Date());

  const target = (bucket: string, objectKey: string | null): ResolvedTarget => {
    const host = pathStyle ? endpointUrl.host : `${bucket}.${endpointUrl.host}`;
    const keyPath = objectKey === null ? "" : `/${sigV4UriEncode(objectKey, false)}`;
    const canonicalUri = pathStyle ? `/${sigV4UriEncode(bucket, true)}${keyPath}` : keyPath || "/";
    return { origin: `${endpointUrl.protocol}//${host}`, host, canonicalUri };
  };

  const scopeFor = (dateStamp: string): string =>
    `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;

  return async (args): Promise<Response> => {
    const at = now();
    const amzDate = sigV4AmzDate(at);
    const dateStamp = amzDate.slice(0, 8);
    const t = target(args.bucket, args.objectKey);
    const payloadHash = args.payload === null ? EMPTY_BODY_SHA256 : sigV4Sha256Hex(args.payload);
    const headers: Record<string, string> = {
      host: t.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...args.extraHeaders,
    };
    const canonicalQuery = sigV4CanonicalQuery(args.query);
    const { text: canonicalRequest, signedHeaders } = sigV4CanonicalRequest({
      method: args.method,
      canonicalUri: t.canonicalUri,
      canonicalQuery,
      headers,
      payloadHash,
    });
    const scope = scopeFor(dateStamp);
    const signature = sigV4Signature(
      sigV4SigningKey({
        secretAccessKey: config.secretAccessKey,
        dateStamp,
        region,
        service: S3_SERVICE,
      }),
      sigV4StringToSign({ amzDate, scope, canonicalRequest }),
    );
    const { host: _hostHeader, ...sendHeaders } = headers;
    const url = `${t.origin}${t.canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
    return fetchImpl(url, {
      method: args.method,
      ...(args.signal ? { signal: args.signal } : {}),
      headers: {
        ...sendHeaders,
        authorization: `${SIGV4_ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(args.payload === null
        ? {}
        : { body: args.payload as unknown as NonNullable<Parameters<typeof fetch>[1]>["body"] }),
    });
  };
}

/**
 * Build the production MinIO/S3 {@link ObjectStorePort} — dependency-free SigV4 over `fetch` +
 * `node:crypto`. Fails fast at construction on an invalid endpoint (a boot-time misconfiguration
 * must never surface as a runtime signing error). See the file header for the per-op contract.
 */
export function createS3ObjectStore(
  config: S3ObjectStoreConfig,
  deps: S3ObjectStoreDeps = {},
): ObjectStorePort & ObjectReaderPort {
  const region = config.region?.trim() || DEFAULT_REGION;
  const now = deps.now ?? ((): Date => new Date());
  const signedFetch = createS3SignedFetch(config, deps, "createS3ObjectStore");

  const presignEndpointUrl = parseS3Endpoint(
    config.publicEndpoint ?? config.endpoint,
    "createS3ObjectStore",
  );
  const target = (bucket: string, objectKey: string | null): ResolvedTarget => {
    const endpointUrl = presignEndpointUrl;
    const pathStyle = config.forcePathStyle !== false;
    const host = pathStyle ? endpointUrl.host : `${bucket}.${endpointUrl.host}`;
    const keyPath = objectKey === null ? "" : `/${sigV4UriEncode(objectKey, false)}`;
    const canonicalUri = pathStyle ? `/${sigV4UriEncode(bucket, true)}${keyPath}` : keyPath || "/";
    return { origin: `${endpointUrl.protocol}//${host}`, host, canonicalUri };
  };

  const scopeFor = (dateStamp: string): string =>
    `${dateStamp}/${region}/${S3_SERVICE}/aws4_request`;

  const opError = (op: string, status: number, bucket: string, objectKey: string): Error =>
    // PHI-free by construction: D11 opaque key + tenant bucket; NEVER the URL or any header.
    new Error(`m22 s3 object store: '${op}' failed with HTTP ${status} for ${bucket}/${objectKey}`);

  return {
    async putObject({ bucket, objectKey, bytes, mimeType, signal }) {
      const sha256Hex = sigV4Sha256Hex(bytes);
      const res = await signedFetch({
        method: "PUT",
        bucket,
        objectKey,
        query: [],
        payload: bytes,
        ...(signal ? { signal } : {}),
        extraHeaders: mimeType
          ? {
              "content-type": mimeType,
              "x-amz-checksum-sha256": Buffer.from(sha256Hex, "hex").toString("base64"),
            }
          : { "content-type": "application/octet-stream" },
      });
      if (!res.ok) throw opError("putObject", res.status, bucket, objectKey);
      return { sha256Hex };
    },

    async presignUpload({
      bucket,
      objectKey,
      mimeType,
      sha256Hex,
      ttlSeconds: requested,
      contentLength,
    }) {
      const ttlSeconds = Math.min(Math.max(Math.ceil(requested), 30), 900);
      const at = now();
      const amzDate = sigV4AmzDate(at);
      const dateStamp = amzDate.slice(0, 8);
      const scope = scopeFor(dateStamp);
      const t = target(bucket, objectKey);
      const checksum = Buffer.from(sha256Hex, "hex").toString("base64");
      // Optional exact-size binding: with `content-length` signed the store refuses a body of any other length.
      const signedHeadersValue =
        contentLength === undefined
          ? "content-type;host;x-amz-checksum-sha256"
          : "content-length;content-type;host;x-amz-checksum-sha256";
      const query: (readonly [string, string])[] = [
        ["X-Amz-Algorithm", SIGV4_ALGORITHM],
        ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(ttlSeconds)],
        ["X-Amz-SignedHeaders", signedHeadersValue],
      ];
      const canonicalQuery = sigV4CanonicalQuery(query);
      const headers = {
        host: t.host,
        "content-type": mimeType,
        "x-amz-checksum-sha256": checksum,
        ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
      };
      const { text: canonicalRequest } = sigV4CanonicalRequest({
        method: "PUT",
        canonicalUri: t.canonicalUri,
        canonicalQuery,
        headers,
        payloadHash: UNSIGNED_PAYLOAD,
      });
      const signingKey = sigV4SigningKey({
        secretAccessKey: config.secretAccessKey,
        dateStamp,
        region,
        service: S3_SERVICE,
      });
      const signature = sigV4Signature(
        signingKey,
        sigV4StringToSign({ amzDate, scope, canonicalRequest }),
      );
      return {
        url: `${t.origin}${t.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
        headers: {
          "content-type": mimeType,
          "x-amz-checksum-sha256": checksum,
          ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }),
        },
        expiresAt: new Date(at.getTime() + ttlSeconds * 1000).toISOString(),
      };
    },

    async getObject({ bucket, objectKey, maxBytes, signal }) {
      const res = await signedFetch({
        method: "GET",
        bucket,
        objectKey,
        query: [],
        payload: null,
        ...(signal ? { signal } : {}),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw opError("getObject", res.status, bucket, objectKey);
      const tooBig = (): Error =>
        new Error(
          `m22 s3 object store: object exceeds ${maxBytes} bytes at ${bucket}/${objectKey}`,
        );
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
      // Stream with a running count so a chunked / header-less body is cut off at the cap, not buffered whole.
      const reader = res.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > maxBytes) throw tooBig();
        return bytes;
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw tooBig();
        }
        chunks.push(value);
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        out.set(c, at);
        at += c.byteLength;
      }
      return out;
    },

    async inspectObject({ bucket, objectKey, signal }) {
      const res = await signedFetch({
        method: "HEAD",
        bucket,
        objectKey,
        query: [],
        payload: null,
        ...(signal ? { signal } : {}),
        extraHeaders: { "x-amz-checksum-mode": "ENABLED" },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw opError("inspectObject", res.status, bucket, objectKey);
      const size = Number(res.headers.get("content-length"));
      const checksum = res.headers.get("x-amz-checksum-sha256");
      const mimeType = res.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (!Number.isSafeInteger(size) || size < 0 || !checksum || !mimeType) {
        throw new Error(
          `m22 s3 object store: incomplete verified metadata for ${bucket}/${objectKey}`,
        );
      }
      return {
        byteSize: size,
        mimeType,
        sha256Hex: Buffer.from(checksum, "base64").toString("hex"),
      };
    },

    async presign({
      descriptor,
      responseOverrides,
    }: {
      descriptor: SignedUrlDescriptor;
      organizationId: OrgId;
      responseOverrides?: { contentDisposition?: string; contentType?: string };
    }) {
      const requested = descriptor.ttlSeconds;
      const ttlSeconds = Math.min(
        Number.isFinite(requested) && requested > 0
          ? Math.ceil(requested)
          : DEFAULT_PRESIGN_TTL_SECONDS,
        MAX_PRESIGN_TTL_SECONDS,
      );
      const at = now();
      const amzDate = sigV4AmzDate(at);
      const dateStamp = amzDate.slice(0, 8);
      const scope = scopeFor(dateStamp);
      const t = target(descriptor.bucket, descriptor.objectKey);
      const query: (readonly [string, string])[] = [
        ["X-Amz-Algorithm", SIGV4_ALGORITHM],
        ["X-Amz-Credential", `${config.accessKeyId}/${scope}`],
        ["X-Amz-Date", amzDate],
        ["X-Amz-Expires", String(ttlSeconds)],
        ["X-Amz-SignedHeaders", "host"],
        // Optional and absent for every M22 caller, so M22 URLs are byte-identical to before.
        ...(responseOverrides?.contentDisposition
          ? [["response-content-disposition", responseOverrides.contentDisposition] as const]
          : []),
        ...(responseOverrides?.contentType
          ? [["response-content-type", responseOverrides.contentType] as const]
          : []),
      ];
      const canonicalQuery = sigV4CanonicalQuery(query);
      const { text: canonicalRequest } = sigV4CanonicalRequest({
        method: "GET",
        canonicalUri: t.canonicalUri,
        canonicalQuery,
        headers: { host: t.host },
        payloadHash: UNSIGNED_PAYLOAD, // presigned GET only — uploads always sign the real hash
      });
      const stringToSign = sigV4StringToSign({ amzDate, scope, canonicalRequest });
      const signingKey = sigV4SigningKey({
        secretAccessKey: config.secretAccessKey,
        dateStamp,
        region,
        service: S3_SERVICE,
      });
      const signature = sigV4Signature(signingKey, stringToSign);
      const url = `${t.origin}${t.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
      const expiresAt: IsoInstant = new Date(at.getTime() + ttlSeconds * 1000).toISOString();
      return { url, expiresAt }; // handed straight to the caller — never logged (§4.12)
    },

    async destroyAllVersions({ bucket, objectKey, signal }) {
      // Page through ?versions with prefix=<key>; entries sort ascending by key, so once a page's
      // max key passes the target the exact-match set is complete.
      let keyMarker: string | null = null;
      let versionIdMarker: string | null = null;
      for (;;) {
        const query: (readonly [string, string])[] = [
          ["prefix", objectKey],
          ["versions", ""],
          ...(keyMarker !== null ? [["key-marker", keyMarker] as const] : []),
          ...(versionIdMarker !== null ? [["version-id-marker", versionIdMarker] as const] : []),
        ];
        const listRes = await signedFetch({
          method: "GET",
          bucket,
          objectKey: null,
          query,
          payload: null,
          ...(signal ? { signal } : {}),
        });
        if (listRes.status === 404) return; // bucket gone ⇒ every version already gone
        if (!listRes.ok)
          throw opError("destroyAllVersions:list", listRes.status, bucket, objectKey);
        const page = parseListObjectVersionsXml(await listRes.text());

        // Delete every version + delete-marker for the EXACT key, sequentially (D12/DR-019).
        for (const entry of page.entries) {
          if (entry.key !== objectKey) continue;
          const delRes = await signedFetch({
            method: "DELETE",
            bucket,
            objectKey,
            query: [["versionId", entry.versionId]],
            payload: null,
            ...(signal ? { signal } : {}),
          });
          if (!delRes.ok && delRes.status !== 404) {
            // 404 ⇒ that version is already gone (idempotent shred); anything else fails LOUDLY.
            throw opError("destroyAllVersions:delete", delRes.status, bucket, objectKey);
          }
        }

        const pastTarget = page.entries.some((e) => e.key > objectKey);
        if (!page.isTruncated || pastTarget) return;
        keyMarker = page.nextKeyMarker ?? objectKey;
        versionIdMarker = page.nextVersionIdMarker;
        if (page.nextKeyMarker === null && page.nextVersionIdMarker === null) return; // no markers ⇒ cannot page further safely
      }
    },
  };
}

/**
 * Idempotently provision the M22 tenant bucket (`tenant-<organizationId>`) for M34 lifecycle jobs.
 * Prefixes remain logical S3 key prefixes; no `.keep` objects are materialized.
 */
export function createS3TenantStorageProvisioner(
  config: S3ObjectStoreConfig,
  deps: S3ObjectStoreDeps = {},
): {
  ensureTenantPrefixes(input: {
    readonly organizationId: string;
    readonly prefixes: readonly string[];
  }): Promise<TenantStorageEnsureResult>;
  /**
   * Idempotently expire every object (and noncurrent version) under `prefix` after `days`. Used for transient PHI
   * staging prefixes (M25 `m25-835/`) so an orphan cannot outlive a bounded window. S3's PUT replaces the whole
   * lifecycle config, so the bucket's existing rules are read and kept; our rule is added only when absent.
   */
  ensurePrefixExpiry(input: {
    readonly organizationId: string;
    readonly prefix: string;
    readonly days: number;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly applied: boolean }>;
} {
  const signedFetch = createS3SignedFetch(config, deps, "createS3TenantStorageProvisioner");

  const opError = (op: string, status: number, bucket: string): Error =>
    new Error(`m34 s3 tenant storage: '${op}' failed with HTTP ${status} for bucket ${bucket}`);

  return {
    async ensureTenantPrefixes({ organizationId, prefixes }) {
      const bucket = deriveTenantBucket(organizationId as OrgId);
      const head = await signedFetch({
        method: "HEAD",
        bucket,
        objectKey: null,
        query: [],
        payload: null,
      });
      if (head.ok) return { bucket, created: false, prefixesEnsured: [...prefixes] };
      if (head.status !== 404) throw opError("bucketExists", head.status, bucket);

      const created = await signedFetch({
        method: "PUT",
        bucket,
        objectKey: null,
        query: [],
        payload: new Uint8Array(),
      });
      if (!created.ok && created.status !== 409)
        throw opError("createBucket", created.status, bucket);
      return { bucket, created: created.ok, prefixesEnsured: [...prefixes] };
    },

    async ensurePrefixExpiry({ organizationId, prefix, days, signal }) {
      if (!Number.isInteger(days) || days < 1)
        throw new Error("ensurePrefixExpiry: days must be a positive integer");
      if (!/^[A-Za-z0-9._\-/]+$/.test(prefix)) throw new Error("ensurePrefixExpiry: unsafe prefix");
      const bucket = deriveTenantBucket(organizationId as OrgId);
      const ruleId = `cw-expire:${prefix}`;
      const read = async (op: string): Promise<string> => {
        const res = await signedFetch({
          method: "GET",
          bucket,
          objectKey: null,
          query: [["lifecycle", ""]],
          payload: null,
          ...(signal ? { signal } : {}),
        });
        if (res.status === 404) return ""; // NoSuchLifecycleConfiguration (or bucket gone: the PUT will say so)
        if (!res.ok) throw opError(op, res.status, bucket);
        return res.text();
      };
      const existing = await read("getLifecycle");
      const rule =
        `<Rule><ID>${ruleId}</ID><Status>Enabled</Status><Filter><Prefix>${prefix}</Prefix></Filter>` +
        `<Expiration><Days>${days}</Days></Expiration>` +
        `<NoncurrentVersionExpiration><NoncurrentDays>${days}</NoncurrentDays></NoncurrentVersionExpiration></Rule>`;

      // PUT replaces the whole config, so a body we cannot positively recognise is never rewritten.
      const trimmed = existing.trim();
      const emptyConfig = trimmed === "" || /^<LifecycleConfiguration\b[^>]*\/>$/.test(trimmed);
      const closeAt = existing.lastIndexOf("</LifecycleConfiguration>");
      if (
        !emptyConfig &&
        (!/^(<\?xml[^>]*\?>\s*)?<LifecycleConfiguration(\s[^>]*)?>/.test(trimmed) || closeAt < 0)
      )
        throw new Error(
          `m34 s3 tenant storage: unrecognised lifecycle config for bucket ${bucket}; refusing to overwrite`,
        );

      let xml: string;
      if (emptyConfig) {
        xml = `<LifecycleConfiguration>${rule}</LifecycleConfiguration>`;
      } else {
        const ours = [...existing.matchAll(/<Rule>[\s\S]*?<\/Rule>/g)].find((m) =>
          new RegExp(`<ID>\\s*${ruleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*</ID>`).test(
            m[0],
          ),
        );
        if (ours) {
          const current =
            /<Status>\s*Enabled\s*<\/Status>/.test(ours[0]) &&
            ours[0].includes(`<Prefix>${prefix}</Prefix>`) &&
            new RegExp(`<Days>\\s*${days}\\s*</Days>`).test(ours[0]) &&
            new RegExp(`<NoncurrentDays>\\s*${days}\\s*</NoncurrentDays>`).test(ours[0]);
          if (current) return { applied: false };
          xml = existing.replace(ours[0], rule); // a changed window/prefix replaces our own rule only
        } else {
          xml = `${existing.slice(0, closeAt)}${rule}${existing.slice(closeAt)}`;
        }
      }
      const body = new TextEncoder().encode(xml);
      const put = await signedFetch({
        method: "PUT",
        bucket,
        objectKey: null,
        query: [["lifecycle", ""]],
        payload: body,
        ...(signal ? { signal } : {}),
        // S3 requires an integrity header on PutBucketLifecycle; Content-MD5 is accepted by AWS and MinIO.
        extraHeaders: {
          "content-md5": createHash("md5").update(body).digest("base64"),
          "content-type": "application/xml",
        },
      });
      if (!put.ok) throw opError("putLifecycle", put.status, bucket);
      // S3 has no conditional PUT for lifecycle: a concurrent writer could have replaced the config between our
      // GET and PUT. Re-read and fail loudly (the next stage retries) rather than report a rule that is not there.
      if (!(await read("verifyLifecycle")).includes(`<ID>${ruleId}</ID>`))
        throw opError("verifyLifecycle", 409, bucket);
      return { applied: true };
    },
  };
}
