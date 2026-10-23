// apps/backend/__tests__/m25-raw-advice-store.test.ts — the M25 raw-835 stage over a mocked S3 (#669, #670):
// keyed by advice id in the tenant bucket, bucket created on first use, delete removes every version.
import { describe, expect, it } from "vitest";
import { buildM25RawAdviceStore } from "../src/m25-raw-advice-store";

const ENV = {
  MINIO_ENDPOINT: "http://minio.local:9000",
  MINIO_ACCESS_KEY: "k",
  MINIO_SECRET_KEY: "s",
};
const ORG = "11111111-1111-4111-8111-111111111111";
const BUCKET = `tenant-${ORG}`;

function fakeS3() {
  const calls: string[] = [];
  const objects = new Map<string, Uint8Array>();
  let bucketExists = false;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}${url.search}`);
    const [, bucket, ...rest] = url.pathname.split("/");
    const key = rest.join("/");
    if (bucket !== BUCKET) return new Response(null, { status: 403 });
    if (!key) {
      if (method === "HEAD") return new Response(null, { status: bucketExists ? 200 : 404 });
      if (method === "PUT") {
        bucketExists = true;
        return new Response(null, { status: 200 });
      }
      if (method === "GET" && url.searchParams.has("versions")) {
        const keys = [...objects.keys()].filter((k) => k === url.searchParams.get("prefix"));
        const xml = `<ListVersionsResult><IsTruncated>false</IsTruncated>${keys
          .map((k) => `<Version><Key>${k}</Key><VersionId>null</VersionId></Version>`)
          .join("")}</ListVersionsResult>`;
        return new Response(xml, { status: 200 });
      }
    }
    if (!bucketExists) return new Response(null, { status: 404 });
    if (method === "PUT") {
      objects.set(key, new Uint8Array(await new Response(init?.body as Uint8Array).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (method === "GET") {
      const o = objects.get(key);
      return o ? new Response(o, { status: 200 }) : new Response(null, { status: 404 });
    }
    if (method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as typeof fetch;
  return { fetchImpl, calls, objects, dropBucket: () => (bucketExists = false) };
}

describe("M25 raw advice store", () => {
  it("is absent without MINIO_* so postAdvice stays fail-closed", () => {
    expect(buildM25RawAdviceStore({})).toBeUndefined();
  });

  it("creates the tenant bucket on first stage, keys by advice id, round-trips and deletes", async () => {
    const s3 = fakeS3();
    const store = buildM25RawAdviceStore(ENV, { fetchImpl: s3.fetchImpl });
    if (!store) throw new Error("unreachable");
    await store.put(ORG, "advice-1", "ISA*raw");
    await store.put(ORG, "advice-2", "ISA*other");
    expect(s3.calls.filter((c) => c.startsWith("PUT /" + BUCKET + "/m25-835/"))).toHaveLength(2);
    expect(s3.calls.filter((c) => c === `PUT /${BUCKET}`)).toHaveLength(1); // ensured once, memoized
    expect(await store.get(ORG, "advice-1")).toBe("ISA*raw");
    expect(await store.get(ORG, "missing")).toBeNull();
    await store.delete(ORG, "advice-1");
    expect(await store.get(ORG, "advice-1")).toBeNull();
    expect(await store.get(ORG, "advice-2")).toBe("ISA*other"); // a neighbour is untouched
  });

  it("re-creates a tenant bucket that vanished after it was memoized, then retries the stage once", async () => {
    const s3 = fakeS3();
    const store = buildM25RawAdviceStore(ENV, { fetchImpl: s3.fetchImpl });
    if (!store) throw new Error("unreachable");
    await store.put(ORG, "a", "one");
    s3.dropBucket();
    await store.put(ORG, "b", "two");
    expect(await store.get(ORG, "b")).toBe("two");
  });

  it("refuses non-UTF-8 staged bytes instead of posting replacement characters", async () => {
    const s3 = fakeS3();
    const store = buildM25RawAdviceStore(ENV, { fetchImpl: s3.fetchImpl });
    if (!store) throw new Error("unreachable");
    await store.put(ORG, "a", "x");
    s3.objects.set("m25-835/a", new Uint8Array([0xff, 0xfe, 0xfd]));
    await expect(store.get(ORG, "a")).rejects.toThrow();
  });
});
