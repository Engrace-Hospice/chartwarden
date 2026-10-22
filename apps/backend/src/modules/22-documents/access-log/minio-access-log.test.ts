import type { DbClient } from "@chartwarden/db";
// GAP-141 — the MinIO access-log ingestor: record parsing and the webhook's fail-closed auth.
import { describe, expect, it } from "vitest";
import { buildServer } from "../../../bootstrap/index";
import { MAX_RECORDS_PER_DELIVERY, parseConsumptions } from "./minio-access-log";
import { bearerMatches, registerMinioAccessLogRoute } from "./minio-access-log-routes";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const get = (over: Record<string, unknown> = {}) => ({
  version: "1",
  time: "2026-10-06T11:59:30.000Z",
  requestID: "req-1",
  api: {
    name: "GetObject",
    bucket: `tenant-${ORG}`,
    object: "documents/p/encounter/d/f.pdf",
    status: "OK",
    statusCode: 200,
    ...over,
  },
});

describe("parseConsumptions", () => {
  it("turns a successful GetObject on a tenant bucket into a consumption", () => {
    const [c] = parseConsumptions(get(), NOW);
    expect(c).toMatchObject({
      organizationId: ORG,
      bucket: `tenant-${ORG}`,
      objectKey: "documents/p/encounter/d/f.pdf",
      requestId: "req-1",
    });
    expect(c?.occurredAt.toISOString()).toBe("2026-10-06T11:59:30.000Z");
  });

  it("accepts a batch (array) of records", () => {
    expect(parseConsumptions([get(), get({ object: "intake/b/x.pdf" })], NOW)).toHaveLength(2);
  });

  it.each([
    ["a HEAD", get({ name: "HeadObject" })],
    ["a PUT", get({ name: "PutObject" })],
    ["a failed GET", get({ statusCode: 403, status: "Forbidden" })],
    ["a non-tenant bucket", get({ bucket: "chartwarden-platform-terminology" })],
    ["a tenant bucket with a non-uuid suffix", get({ bucket: "tenant-not-a-uuid" })],
    ["a record with no object", get({ object: undefined })],
  ])("ignores %s", (_label, record) => {
    expect(parseConsumptions(record, NOW)).toEqual([]);
  });

  it("ignores malformed bodies instead of throwing", () => {
    expect(parseConsumptions(null, NOW)).toEqual([]);
    expect(parseConsumptions("nope", NOW)).toEqual([]);
    expect(parseConsumptions([1, "x", {}], NOW)).toEqual([]);
  });

  it("decodes a percent-encoded object key and bounds an oversized delivery", () => {
    const [c] = parseConsumptions(get({ object: "documents/p/a%20b.pdf" }), NOW);
    expect(c?.objectKey).toBe("documents/p/a b.pdf");
    const many = Array.from({ length: MAX_RECORDS_PER_DELIVERY + 50 }, () => get());
    expect(parseConsumptions(many, NOW)).toHaveLength(MAX_RECORDS_PER_DELIVERY);
  });
});

describe("bearerMatches", () => {
  it("matches only the exact token, and never throws on a length mismatch", () => {
    expect(bearerMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches("Bearer s3cre", "s3cret")).toBe(false);
    expect(bearerMatches("bearer s3cret", "s3cret")).toBe(true);
    expect(bearerMatches(undefined, "s3cret")).toBe(false);
    expect(bearerMatches("s3cret", "s3cret")).toBe(false);
  });
});

describe("POST /api/v1/webhooks/minio/access-log", () => {
  // The database is a Proxy that throws on use: every path below must be decided BEFORE touching it.
  const untouchedDb = new Proxy(
    {},
    {
      get() {
        throw new Error("must not touch the db");
      },
    },
  ) as DbClient;
  const make = (token: string | undefined) => {
    const app = buildServer({ security: { rateLimitEnabled: false } });
    registerMinioAccessLogRoute(app, { db: untouchedDb, token, now: () => NOW });
    return app;
  };
  const post = (app: ReturnType<typeof make>, authorization?: string, payload: unknown = get()) =>
    app.inject({
      method: "POST",
      url: "/api/v1/webhooks/minio/access-log",
      headers: authorization ? { authorization } : {},
      payload: payload as object,
    });

  it("answers 503 when no token is configured (never open)", async () => {
    expect((await post(make(undefined), "Bearer anything")).statusCode).toBe(503);
  });

  it("answers 401 on a missing or wrong token", async () => {
    const app = make("s3cret");
    expect((await post(app)).statusCode).toBe(401);
    expect((await post(app, "Bearer wrong")).statusCode).toBe(401);
  });

  it("answers 200 and touches nothing when the delivery holds no consumptions", async () => {
    const app = make("s3cret");
    const res = await post(app, "Bearer s3cret", get({ name: "HeadObject" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ received: 0, recorded: 0 });
  });
});
