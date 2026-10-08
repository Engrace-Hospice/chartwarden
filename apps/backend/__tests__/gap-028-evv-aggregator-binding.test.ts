// GAP-028 — the aggregator submission path is bindable by configuration: an HTTPS Sandata transport and a
// config-driven credential store replace the deny/unbound defaults when (and only when) configured. Vendor
// contract is exercised against a fake fetch; no Sandata sandbox was reachable.
import { type FetchLike, createHttpSandataTransport } from "@wardenx/evv-aggregators";
import { describe, expect, it } from "vitest";

import {
  EvvAggregatorPortUnboundError,
  createConfiguredAggregatorCredentialStore,
  parseEvvAggregatorCredentials,
} from "../src/modules/18-evv/jobs/ports";

const NOW = new Date("2026-10-08T12:00:00.000Z");
const creds = { providerEntityId: "pe", secrets: { username: "u", password: "p" } };

function fakeFetch(
  status: number,
  body: unknown,
  calls: Array<{ url: string; init: unknown }> = [],
) {
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => body };
  };
  return fn;
}

describe("GAP-028 HTTPS Sandata transport", () => {
  it("refuses a non-https base URL", () => {
    expect(() => createHttpSandataTransport({ baseUrl: "http://x" })).toThrow(/https/);
  });

  it("posts with basic auth and idempotency key; 202 becomes pending_async", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const t = createHttpSandataTransport({
      baseUrl: "https://sandata.example/api/",
      fetchImpl: fakeFetch(202, { transactionId: "tx1" }, calls),
      clock: () => NOW,
    });
    const res = await t.post({ body: { a: 1 }, idempotencyKey: "idem", credentials: creds });
    expect(res).toMatchObject({ result: "pending_async", transactionId: "tx1" });
    expect(calls[0]?.url).toBe("https://sandata.example/api/submissions");
    const init = calls[0]?.init as { headers: Record<string, string>; body: string };
    expect(init.headers["idempotency-key"]).toBe("idem");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });

  it("maps 5xx and a network failure to transport_failure, never an acceptance", async () => {
    const down = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(503, {}),
      clock: () => NOW,
    });
    expect(await down.post({ body: {}, idempotencyKey: "i", credentials: creds })).toMatchObject({
      result: "transport_failure",
    });
    const broken = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
      clock: () => NOW,
    });
    expect(await broken.post({ body: {}, idempotencyKey: "i", credentials: creds })).toMatchObject({
      result: "transport_failure",
    });
  });

  it("maps a 2xx without a transaction id to transport_failure", async () => {
    const t = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(200, { status: "accepted" }),
      clock: () => NOW,
    });
    expect(await t.post({ body: {}, idempotencyKey: "i", credentials: creds })).toMatchObject({
      result: "transport_failure",
    });
  });

  it("maps a 422 to rejected with the vendor code", async () => {
    const t = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(422, { code: "BAD_SERVICE", message: "unknown service" }),
    });
    expect(await t.post({ body: {}, idempotencyKey: "i", credentials: creds })).toMatchObject({
      result: "rejected",
      rejectionCode: "BAD_SERVICE",
    });
  });

  it("polls to accepted, and treats an unreadable poll as still_pending", async () => {
    const ok = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(200, { status: "accepted" }),
      clock: () => NOW,
    });
    expect(await ok.pollStatus({ transactionId: "tx1", credentials: creds })).toEqual({
      result: "accepted",
      acceptedAt: NOW.toISOString(),
    });
    const flaky = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(500, {}),
      clock: () => NOW,
    });
    expect(await flaky.pollStatus({ transactionId: "tx1", credentials: creds })).toMatchObject({
      result: "still_pending",
    });
  });

  it("throws before any request when credentials lack a username or password", async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const t = createHttpSandataTransport({
      baseUrl: "https://s.example",
      fetchImpl: fakeFetch(200, {}, calls),
    });
    await expect(
      t.post({
        body: {},
        idempotencyKey: "i",
        credentials: { providerEntityId: "pe", secrets: {} },
      }),
    ).rejects.toThrow(/username/);
    expect(calls).toHaveLength(0);
  });
});

describe("GAP-028 configured credential store", () => {
  const raw = JSON.stringify([
    {
      providerEntityId: "pe-1",
      vendor: "sandata",
      stateCode: "TX",
      secrets: { username: "u", password: "p" },
    },
  ]);

  it("resolves an exact (provider, vendor, state) entry", async () => {
    const store = createConfiguredAggregatorCredentialStore(parseEvvAggregatorCredentials(raw));
    const got = await store.resolve({
      providerEntityId: "pe-1",
      vendor: "sandata",
      stateCode: "TX",
    });
    expect(got.secrets).toEqual({ username: "u", password: "p" });
  });

  it("never falls back to another provider entity's entry", async () => {
    const store = createConfiguredAggregatorCredentialStore(parseEvvAggregatorCredentials(raw));
    await expect(
      store.resolve({ providerEntityId: "pe-2", vendor: "sandata", stateCode: "TX" }),
    ).rejects.toBeInstanceOf(EvvAggregatorPortUnboundError);
  });

  it("stays fail-closed when nothing is configured", async () => {
    const store = createConfiguredAggregatorCredentialStore(
      parseEvvAggregatorCredentials(undefined),
    );
    await expect(
      store.resolve({ providerEntityId: "pe-1", vendor: "sandata", stateCode: "TX" }),
    ).rejects.toBeInstanceOf(EvvAggregatorPortUnboundError);
  });

  it("rejects malformed configuration at parse time", () => {
    expect(() => parseEvvAggregatorCredentials("{")).toThrow(/valid JSON/);
    expect(() =>
      parseEvvAggregatorCredentials(
        JSON.stringify([
          { providerEntityId: "p", vendor: "v", stateCode: "tx", secrets: { a: "b" } },
        ]),
      ),
    ).toThrow(/stateCode/);
  });
});
