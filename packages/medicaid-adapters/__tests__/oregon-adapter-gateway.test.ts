// WX-PR-011 — the Oregon adapter's gateway delegation: with NO gateway injected it still throws the
// original structured ADAPTER_NOT_WIRED (unchanged behavior — dev/test/CI default); with a fake gateway
// injected it delegates real work through. Also proves the registry threads the gateway to Oregon only —
// WA/ID/CA/NV stay deny-stubs regardless.
import { describe, expect, it, vi } from "vitest";
import type { TradingPartnerCredentials } from "../src/credentials";
import { MedicaidAdapterError } from "../src/errors";
import { OregonMedicaidAdapter } from "../src/oregon";
import type { OregonGatewayPort } from "../src/oregon/launch-gateway";
import { MedicaidAdapterRegistry } from "../src/registry";

const CREDS: TradingPartnerCredentials = {
  providerEntityId: "pe-1",
  serviceState: "OR",
  channel: "direct_mmis",
  mcoId: null,
  tradingPartnerId: "TP-1",
  clientId: null,
  clientSecret: null,
  sftpHost: null,
  sftpUser: null,
  sftpKey: null,
  portalUrl: "https://oha-sandbox.example/api",
  additionalConfig: null,
};

function fakeGateway(overrides: Partial<OregonGatewayPort> = {}): OregonGatewayPort {
  return {
    eligibilityCheck: vi.fn(),
    submit: vi.fn(),
    poll: vi.fn(),
    parseAcknowledgment: vi.fn(),
    parseRemittance: vi.fn(),
    rateLookup: vi.fn(),
    healthy: vi.fn(async () => ({ ok: true, lastChecked: "now", latencyMs: 1 })),
    ...overrides,
  };
}

describe("OregonMedicaidAdapter — no gateway (default)", () => {
  it("still throws ADAPTER_NOT_WIRED on every I/O method", async () => {
    const adapter = new OregonMedicaidAdapter();
    await expect(
      adapter.submit({
        body: new Uint8Array(),
        idempotencyKey: "k",
        channel: "direct_mmis",
        credentials: CREDS,
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_NOT_WIRED" });
    await expect(adapter.healthy()).resolves.toMatchObject({ ok: false });
  });
});

describe("OregonMedicaidAdapter — with an injected gateway", () => {
  it("delegates eligibilityCheck to the gateway", async () => {
    const gw = fakeGateway({
      eligibilityCheck: vi.fn(async () => ({
        outcome: "active",
        mcoId: null,
        mcoName: null,
        routingChannel: "direct_mmis",
        recipientIdFormatValid: true,
        recipientIdMasked: "****",
        vendorTransactionId: null,
      })),
    });
    const adapter = new OregonMedicaidAdapter(gw);
    const result = await adapter.eligibilityCheck({
      orgId: "o1",
      patientId: "p1",
      asOfServiceDate: "2026-01-01",
      recipientIdPlain: "12345678",
      credentials: CREDS,
    });
    expect(result.outcome).toBe("active");
    expect(gw.eligibilityCheck).toHaveBeenCalledTimes(1);
  });

  it("assembleSubmissionPayload never touches the gateway (pure local render)", async () => {
    const gw = fakeGateway();
    const adapter = new OregonMedicaidAdapter(gw);
    const result = await adapter.assembleSubmissionPayload({
      orgId: "o1",
      claimId: "c1",
      claimSnapshot: {
        claimId: "c1",
        patientId: "p1",
        serviceState: "OR",
        tob: "811",
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
        mcoId: null,
        medicaidClaimControlNumber: "CCN-1",
        lines: [],
      },
      credentials: CREDS,
    });
    expect(result.idempotencyKey).toBe("CCN-1");
    expect(result.channel).toBe("direct_mmis");
    expect(gw.submit).not.toHaveBeenCalled();
  });

  it("delegates submit/poll/rateLookup/parseAcknowledgment to the gateway", async () => {
    const gw = fakeGateway({
      submit: vi.fn(async () => ({
        result: "accepted_sync" as const,
        vendorTransactionId: "vtx-1",
      })),
      poll: vi.fn(async () => ({
        result: "still_pending" as const,
        nextPollAt: "2026-01-02T00:00:00.000Z",
      })),
      rateLookup: vi.fn(async () => ({ rateCents: 100, scheduleId: "s1" })),
      parseAcknowledgment: vi.fn(async () => ({
        kind: "sync_277ca" as const,
        outcome: "accepted" as const,
      })),
    });
    const adapter = new OregonMedicaidAdapter(gw);
    await expect(
      adapter.submit({
        body: new Uint8Array(),
        idempotencyKey: "k",
        channel: "direct_mmis",
        credentials: CREDS,
      }),
    ).resolves.toMatchObject({ result: "accepted_sync" });
    await expect(
      adapter.poll({ vendorTransactionId: "vtx-1", credentials: CREDS }),
    ).resolves.toMatchObject({
      result: "still_pending",
    });
    await expect(
      adapter.rateLookup({
        serviceDate: "2026-01-01",
        loc: "RHC",
        county: null,
        credentials: CREDS,
      }),
    ).resolves.toMatchObject({ rateCents: 100 });
    await expect(
      adapter.parseAcknowledgment({ rawPayload: new Uint8Array(), expectedKind: "sync_277ca" }),
    ).resolves.toMatchObject({ outcome: "accepted" });
    expect(gw.submit).toHaveBeenCalledTimes(1);
    expect(gw.poll).toHaveBeenCalledTimes(1);
    expect(gw.rateLookup).toHaveBeenCalledTimes(1);
    expect(gw.parseAcknowledgment).toHaveBeenCalledTimes(1);
  });

  it("healthy() reports ok when a gateway is present (does not itself probe the network)", async () => {
    const adapter = new OregonMedicaidAdapter(fakeGateway());
    await expect(adapter.healthy()).resolves.toMatchObject({ ok: true });
  });
});

describe("MedicaidAdapterRegistry — threads the gateway to Oregon only", () => {
  it("Oregon uses the injected gateway; WA/ID/CA/NV stay deny-stubs unaffected", async () => {
    const gw = fakeGateway({
      submit: vi.fn(async () => ({
        result: "accepted_sync" as const,
        vendorTransactionId: "vtx-1",
      })),
    });
    const reg = new MedicaidAdapterRegistry([], gw);
    const or = reg.requireAdapterForState("OR");
    await expect(
      or.submit({
        body: new Uint8Array(),
        idempotencyKey: "k",
        channel: "direct_mmis",
        credentials: CREDS,
      }),
    ).resolves.toMatchObject({ result: "accepted_sync" });

    const wa = reg.requireAdapterForState("WA");
    await expect(
      wa.submit({
        body: new Uint8Array(),
        idempotencyKey: "k",
        channel: "direct_mmis",
        credentials: CREDS,
      }),
    ).rejects.toMatchObject({ code: "ADAPTER_DENY_STUB" });
  });

  it("with no gateway argument, Oregon falls back to ADAPTER_NOT_WIRED (unchanged default)", async () => {
    const reg = new MedicaidAdapterRegistry();
    await expect(
      reg.requireAdapterForState("OR").submit({
        body: new Uint8Array(),
        idempotencyKey: "k",
        channel: "direct_mmis",
        credentials: CREDS,
      }),
    ).rejects.toBeInstanceOf(MedicaidAdapterError);
  });
});
