import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFetchX12835HttpPort,
  m25X12WorkerConfigFromEnv,
} from "../ingest/x12-worker-transport";

describe("m25X12WorkerConfigFromEnv", () => {
  it("returns null when M25_X12_WORKER_URL is unset (the fail-closed default)", () => {
    expect(m25X12WorkerConfigFromEnv({})).toBeNull();
  });

  it("reads the base url/token/timeout when configured", () => {
    const config = m25X12WorkerConfigFromEnv({
      M25_X12_WORKER_URL: "https://x12-worker.invalid",
      M25_X12_WORKER_TOKEN: "secret-token",
      M25_X12_WORKER_TIMEOUT_MS: "5000",
    });
    expect(config).toEqual({
      baseUrl: "https://x12-worker.invalid",
      bearerToken: "secret-token",
      timeoutMs: 5000,
    });
  });

  it("defaults the timeout to 30000ms and allows an unset token", () => {
    const config = m25X12WorkerConfigFromEnv({ M25_X12_WORKER_URL: "https://x12-worker.invalid" });
    expect(config).toEqual({ baseUrl: "https://x12-worker.invalid", timeoutMs: 30000 });
  });

  it("throws on an out-of-range timeout rather than silently clamping", () => {
    expect(() =>
      m25X12WorkerConfigFromEnv({
        M25_X12_WORKER_URL: "https://x12-worker.invalid",
        M25_X12_WORKER_TIMEOUT_MS: "999999",
      }),
    ).toThrow("M25_X12_WORKER_TIMEOUT_MS must be an integer from 1000 through 120000");
  });
});

describe("createFetchX12835HttpPort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a real POST request with the bearer token, JSON body, and joined path", async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        seenUrl = url;
        seenInit = init;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const port = createFetchX12835HttpPort({
      baseUrl: "https://x12-worker.invalid/",
      bearerToken: "secret-token",
      timeoutMs: 5000,
    });
    const res = await port.request({
      method: "POST",
      path: "/parse835",
      body: { minioObjectKey: "k" },
    });
    expect(seenUrl).toBe("https://x12-worker.invalid/parse835");
    expect(seenInit?.method).toBe("POST");
    expect((seenInit?.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
    expect(seenInit?.body).toBe(JSON.stringify({ minioObjectKey: "k" }));
    expect(res).toEqual({ status: 200, body: { ok: true } });
  });

  it("omits the authorization header when no bearer token is configured", async () => {
    let seenInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seenInit = init;
        return new Response("{}", { status: 200 });
      }),
    );
    const port = createFetchX12835HttpPort({
      baseUrl: "https://x12-worker.invalid",
      timeoutMs: 5000,
    });
    await port.request({ method: "POST", path: "/parse835", body: {} });
    expect((seenInit?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("returns a null body rather than throwing when the sidecar response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );
    const port = createFetchX12835HttpPort({
      baseUrl: "https://x12-worker.invalid",
      timeoutMs: 5000,
    });
    const res = await port.request({ method: "POST", path: "/parse835", body: {} });
    expect(res).toEqual({ status: 502, body: null });
  });
});
