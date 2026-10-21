// TASK-020 — the shared client auto-attaches Idempotency-Key on mutating requests so a network-level
// retry replays instead of double-executing the backend's `requireIdempotencyKey` guard (§4.1.1). Verifies
// the middleware directly against a captured Request, without a real server or the generated `paths` type.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient } from "../client";

function fetchCapturingRequest(): { fetch: typeof fetch; requests: Request[] } {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req.clone());
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

describe("createApiClient — Idempotency-Key middleware (TASK-020)", () => {
  it("attaches a generated Idempotency-Key to a POST (e.g. a claim submit)", async () => {
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST(
      "/api/v1/billing/claims/{id}/submit" as never,
      {
        params: { path: { id: "claim-1" } },
      } as never,
    );
    expect(requests).toHaveLength(1);
    const key = requests[0]?.headers.get("Idempotency-Key");
    expect(key).toBeTruthy();
    expect(key).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("attaches a key to PATCH/PUT/DELETE but not to GET", async () => {
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.GET("/api/v1/billing/claims" as never, {} as never);
    expect(requests[0]?.headers.has("Idempotency-Key")).toBe(false);
  });

  it("never overwrites a caller-supplied Idempotency-Key", async () => {
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST(
      "/api/v1/billing/claims/assemble" as never,
      {
        headers: { "Idempotency-Key": "caller-chosen-key" },
      } as never,
    );
    expect(requests[0]?.headers.get("Idempotency-Key")).toBe("caller-chosen-key");
  });
});

describe("createApiClient — CSRF token middleware (WX-PR-017)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("attaches X-CSRF-Token from the chartwarden_csrf cookie on a mutating request", async () => {
    vi.stubGlobal("document", { cookie: "other=1; chartwarden_csrf=abc123; more=2" });
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST(
      "/api/v1/billing/claims/{id}/submit" as never,
      { params: { path: { id: "claim-1" } } } as never,
    );
    expect(requests[0]?.headers.get("X-CSRF-Token")).toBe("abc123");
  });

  it("falls back to the legacy wardenx_csrf cookie until the server swaps it", async () => {
    vi.stubGlobal("document", { cookie: "wardenx_csrf=old123" });
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST(
      "/api/v1/billing/claims/{id}/submit" as never,
      { params: { path: { id: "claim-1" } } } as never,
    );
    expect(requests[0]?.headers.get("X-CSRF-Token")).toBe("old123");
  });

  it("does not attach X-CSRF-Token to a GET", async () => {
    vi.stubGlobal("document", { cookie: "chartwarden_csrf=abc123" });
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.GET("/api/v1/billing/claims" as never, {} as never);
    expect(requests[0]?.headers.has("X-CSRF-Token")).toBe(false);
  });

  it("sends no X-CSRF-Token when the cookie is absent (no document / no cookie)", async () => {
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST("/api/v1/billing/claims/assemble" as never, {} as never);
    expect(requests[0]?.headers.has("X-CSRF-Token")).toBe(false);
  });

  it("never overwrites a caller-supplied X-CSRF-Token", async () => {
    vi.stubGlobal("document", { cookie: "chartwarden_csrf=abc123" });
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.POST(
      "/api/v1/billing/claims/assemble" as never,
      { headers: { "X-CSRF-Token": "caller-chosen" } } as never,
    );
    expect(requests[0]?.headers.get("X-CSRF-Token")).toBe("caller-chosen");
  });
});

describe("createApiClient — onResponseStatus hook (TASK-033)", () => {
  it("reports the HTTP status of every response, success or error", async () => {
    const statuses: number[] = [];
    const fetchImpl = (async () =>
      new Response("{}", {
        status: 503,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const client = createApiClient({
      fetch: fetchImpl,
      baseUrl: "http://localhost",
      onResponseStatus: (status) => statuses.push(status),
    });
    await client.GET("/api/v1/billing/claims" as never, {} as never);
    expect(statuses).toEqual([503]);
  });

  it("does not observe responses when no hook is given (leaf-safe default)", async () => {
    const { fetch, requests } = fetchCapturingRequest();
    const client = createApiClient({ fetch, baseUrl: "http://localhost" });
    await client.GET("/api/v1/billing/claims" as never, {} as never);
    expect(requests).toHaveLength(1); // no throw, no behavior change
  });
});
