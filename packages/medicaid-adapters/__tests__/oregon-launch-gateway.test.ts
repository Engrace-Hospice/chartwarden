// WX-PR-011 — the Oregon launch-gateway's faithful-fake test harness (mirrors M23's
// launch-gateway.test.ts pattern: inject a fake GatewayHttpPort, assert on request shape + response
// validation, never touch a real network). Covers eligibility/submit/poll/parse/rate-lookup/healthy,
// malformed-response rejection, missing-portalUrl fail-closed, and the env config loader's capability gate.
import { describe, expect, it, vi } from "vitest";
import type { TradingPartnerCredentials } from "../src/credentials";
import {
  assembleOregonSubmissionPayload,
  createM24OregonGateway,
  m24LaunchGatewayConfigFromEnv,
} from "../src/oregon/launch-gateway";

const CREDS: TradingPartnerCredentials = {
  providerEntityId: "pe-1",
  serviceState: "OR",
  channel: "direct_mmis",
  mcoId: null,
  tradingPartnerId: "TP-1",
  clientId: "client-1",
  clientSecret: "secret-1",
  sftpHost: null,
  sftpUser: null,
  sftpKey: null,
  portalUrl: "https://oha-sandbox.example/api",
  additionalConfig: null,
};

function fakeHttp(
  handler: (path: string, method: string, body: unknown) => { status: number; body: unknown },
) {
  return { request: vi.fn(async (input) => handler(input.path, input.method, input.body)) };
}

describe("createM24OregonGateway — eligibility", () => {
  it("parses a valid response and sends the trading-partner id in the request body", async () => {
    const http = fakeHttp((path, method, body) => {
      expect(path).toBe("/eligibility");
      expect(method).toBe("POST");
      expect((body as Record<string, unknown>).tradingPartnerId).toBe("TP-1");
      return {
        status: 200,
        body: {
          outcome: "active",
          mcoId: null,
          mcoName: null,
          routingChannel: "direct_mmis",
          recipientIdFormatValid: true,
          recipientIdMasked: "****5678",
          vendorTransactionId: "vtx-1",
        },
      };
    });
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    const result = await gw.eligibilityCheck({
      recipientIdPlain: "12345678",
      asOfServiceDate: "2026-01-01",
      credentials: CREDS,
    });
    expect(result.outcome).toBe("active");
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed response (missing required fields)", async () => {
    const http = fakeHttp(() => ({ status: 200, body: { outcome: "active" } }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(
      gw.eligibilityCheck({
        recipientIdPlain: "12345678",
        asOfServiceDate: "2026-01-01",
        credentials: CREDS,
      }),
    ).rejects.toThrow(/invalid eligibility/);
  });

  it("fails closed with no network call when the credential carries no portalUrl", async () => {
    const http = fakeHttp(() => ({ status: 200, body: {} }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(
      gw.eligibilityCheck({
        recipientIdPlain: "12345678",
        asOfServiceDate: "2026-01-01",
        credentials: { ...CREDS, portalUrl: null },
      }),
    ).rejects.toThrow(/no portalUrl configured/);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("rejects a non-2xx HTTP status", async () => {
    const http = fakeHttp(() => ({ status: 500, body: null }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(
      gw.eligibilityCheck({
        recipientIdPlain: "12345678",
        asOfServiceDate: "2026-01-01",
        credentials: CREDS,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("createM24OregonGateway — submit (outage / duplicate / accept variants)", () => {
  it("accepted_sync", async () => {
    const http = fakeHttp((path) => {
      expect(path).toBe("/claims");
      return { status: 200, body: { result: "accepted_sync", vendorTransactionId: "vtx-2" } };
    });
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    const result = await gw.submit({
      body: new Uint8Array([1]),
      idempotencyKey: "k1",
      credentials: CREDS,
    });
    expect(result).toMatchObject({ result: "accepted_sync", vendorTransactionId: "vtx-2" });
  });

  it("pending_async", async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: {
        result: "pending_async",
        vendorTransactionId: "vtx-3",
        nextPollAt: "2026-01-02T00:00:00.000Z",
      },
    }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    const result = await gw.submit({
      body: new Uint8Array([1]),
      idempotencyKey: "k2",
      credentials: CREDS,
    });
    expect(result).toMatchObject({ result: "pending_async", vendorTransactionId: "vtx-3" });
  });

  it("rejected_sync", async () => {
    const http = fakeHttp(() => ({
      status: 200,
      body: {
        result: "rejected_sync",
        rejectionCode: "R001",
        rejectionReason: "invalid recipient id",
        vendorTransactionId: null,
      },
    }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    const result = await gw.submit({
      body: new Uint8Array([1]),
      idempotencyKey: "k3",
      credentials: CREDS,
    });
    expect(result).toMatchObject({ result: "rejected_sync", rejectionCode: "R001" });
  });

  it("an outage (non-2xx / network throw) surfaces as a rejected promise, not a silent success", async () => {
    const http = {
      request: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    };
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(
      gw.submit({ body: new Uint8Array([1]), idempotencyKey: "k4", credentials: CREDS }),
    ).rejects.toThrow("ECONNRESET");
  });

  it("a duplicate submit (same idempotencyKey) sends the SAME key twice — the server, not this gateway, dedupes", async () => {
    const seenKeys: unknown[] = [];
    const http = fakeHttp((_p, _m, body) => {
      seenKeys.push((body as Record<string, unknown>).idempotencyKey);
      return { status: 200, body: { result: "accepted_sync", vendorTransactionId: "vtx-dup" } };
    });
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await gw.submit({ body: new Uint8Array([1]), idempotencyKey: "same-key", credentials: CREDS });
    await gw.submit({ body: new Uint8Array([1]), idempotencyKey: "same-key", credentials: CREDS });
    expect(seenKeys).toEqual(["same-key", "same-key"]);
  });
});

describe("createM24OregonGateway — poll", () => {
  it("still_pending / accepted / rejected / timeout", async () => {
    const responses = [
      { result: "still_pending", nextPollAt: "2026-01-03T00:00:00.000Z" },
      {
        result: "accepted",
        ack: { kind: "sync_277ca", outcome: "accepted", payerClaimControlNumber: "PCC1" },
      },
      { result: "rejected", rejectionCode: "R002", rejectionReason: "duplicate claim" },
      { result: "timeout" },
    ];
    let i = 0;
    const http = fakeHttp(() => ({ status: 200, body: responses[i++] }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(
      gw.poll({ vendorTransactionId: "vtx", credentials: CREDS }),
    ).resolves.toMatchObject({
      result: "still_pending",
    });
    await expect(
      gw.poll({ vendorTransactionId: "vtx", credentials: CREDS }),
    ).resolves.toMatchObject({
      result: "accepted",
    });
    await expect(
      gw.poll({ vendorTransactionId: "vtx", credentials: CREDS }),
    ).resolves.toMatchObject({
      result: "rejected",
      rejectionCode: "R002",
    });
    await expect(
      gw.poll({ vendorTransactionId: "vtx", credentials: CREDS }),
    ).resolves.toMatchObject({
      result: "timeout",
    });
  });

  it("rejects a malformed poll response", async () => {
    const http = fakeHttp(() => ({ status: 200, body: { result: "bogus" } }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await expect(gw.poll({ vendorTransactionId: "vtx", credentials: CREDS })).rejects.toThrow(
      /invalid poll/,
    );
  });
});

describe("createM24OregonGateway — parseAcknowledgment / rateLookup / healthy", () => {
  it("parses a matching-kind ack and rejects a kind mismatch", async () => {
    const gw = createM24OregonGateway({ timeoutMs: 5000 });
    const raw = new TextEncoder().encode(
      JSON.stringify({ kind: "sync_277ca", outcome: "accepted" }),
    );
    await expect(
      gw.parseAcknowledgment({ rawPayload: raw, expectedKind: "sync_277ca" }),
    ).resolves.toMatchObject({
      outcome: "accepted",
    });
    await expect(
      gw.parseAcknowledgment({ rawPayload: raw, expectedKind: "sync_999" }),
    ).rejects.toThrow(/kind mismatch/);
  });

  it("rejects non-JSON ack payload", async () => {
    const gw = createM24OregonGateway({ timeoutMs: 5000 });
    await expect(
      gw.parseAcknowledgment({
        rawPayload: new TextEncoder().encode("not json"),
        expectedKind: "sync_277ca",
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("rateLookup — credential-rotation: a different PE's credential hits its OWN portalUrl", async () => {
    const seenUrls: string[] = [];
    const http = {
      request: vi.fn(async (input: { baseUrl: string }) => {
        seenUrls.push(input.baseUrl);
        return { status: 200, body: { rateCents: 12345, scheduleId: "sched-1" } };
      }),
    };
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    await gw.rateLookup({
      serviceDate: "2026-01-01",
      loc: "RHC",
      county: "Umatilla",
      credentials: CREDS,
    });
    await gw.rateLookup({
      serviceDate: "2026-01-01",
      loc: "RHC",
      county: "Umatilla",
      credentials: {
        ...CREDS,
        providerEntityId: "pe-2",
        portalUrl: "https://other-pe.example/api",
      },
    });
    expect(seenUrls).toEqual(["https://oha-sandbox.example/api", "https://other-pe.example/api"]);
  });

  it("healthy() reports latency + ok", async () => {
    const http = fakeHttp(() => ({ status: 200, body: { ok: true } }));
    const gw = createM24OregonGateway({ timeoutMs: 5000 }, http);
    const result = await gw.healthy(CREDS);
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("assembleOregonSubmissionPayload — pure local render", () => {
  it("renders a deterministic JSON envelope keyed by the control number", () => {
    const snapshot = {
      claimId: "c1",
      patientId: "p1",
      serviceState: "OR",
      tob: "811",
      serviceFrom: "2026-01-01",
      serviceTo: "2026-01-31",
      mcoId: null,
      medicaidClaimControlNumber: "CCN-1",
      lines: [],
    };
    const { body, idempotencyKey } = assembleOregonSubmissionPayload(snapshot);
    expect(idempotencyKey).toBe("CCN-1");
    const parsed = JSON.parse(new TextDecoder().decode(body));
    expect(parsed).toMatchObject({ schema: "wardenx.oregon-direct-mmis.v1", claimId: "c1" });
  });
});

describe("m24LaunchGatewayConfigFromEnv — capability gate", () => {
  it("returns null when unset (the default — no accidental outbound calls)", () => {
    expect(m24LaunchGatewayConfigFromEnv({})).toBeNull();
    expect(m24LaunchGatewayConfigFromEnv({ M24_LAUNCH_GATEWAY_ENABLED: "false" })).toBeNull();
  });
  it("returns a config when explicitly enabled", () => {
    expect(m24LaunchGatewayConfigFromEnv({ M24_LAUNCH_GATEWAY_ENABLED: "true" })).toEqual({
      timeoutMs: 30000,
    });
  });
  it("rejects an out-of-range timeout", () => {
    expect(() =>
      m24LaunchGatewayConfigFromEnv({
        M24_LAUNCH_GATEWAY_ENABLED: "true",
        M24_GATEWAY_TIMEOUT_MS: "500",
      }),
    ).toThrow(/M24_GATEWAY_TIMEOUT_MS/);
  });
});
