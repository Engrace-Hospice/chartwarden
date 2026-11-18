import { describe, expect, it, vi } from "vitest";
import { SYNTHETIC_MBI } from "../clearinghouse/conformance";
import { LocalFakeHttpClient, type LocalFakeHttpResponse } from "../testing/local-fake-http-client";
import {
  EPISODE_ALERT_DDE_API_KEY_ENV,
  EPISODE_ALERT_DDE_BASE_URL_ENV,
  EpisodeAlertDdeProvider,
  assertSafeBaseUrl,
  createEpisodeAlertDdeProviderFromEnv,
} from "./episode-alert-dde-provider";
import type { EpisodeAlertDdeOptions } from "./episode-alert-dde-provider";
import { EA_DDE_FACTS, EA_DDE_WIRE, WIRE_UNVERIFIED } from "./episode-alert-dde-wire";
import type { EpisodeAlertDdeWire } from "./episode-alert-dde-wire";
import { DDE_PROVIDER_ENV, bindDdeProvider } from "./provider-registry";
import { DDE, type DdeContext, type DdeOperation } from "./types";

const MBI = SYNTHETIC_MBI;
const SECRET = "synthetic-ea-key-not-a-credential";
const CTX: DdeContext = {
  organizationId: "synthetic-org",
  providerEntityId: "synthetic-provider",
  operatorMembershipId: "synthetic-operator",
  correlationId: "synthetic-correlation",
  usage: "production",
};
const OP: DdeOperation = {
  kind: "noe",
  controlNumber: "synthetic-cn-1",
  idempotencyKey: "dde:item:synthetic-1",
  payload: { format: "json", document: { itemType: "noe" } },
  beneficiary: { mbi: MBI, lastName: "Synthetic", firstName: "Patient", dateOfBirth: "1950-01-01" },
};

/** A plumbing-only wire paired only with LocalFakeHttpClient; it exists nowhere in the vendor wire module. */
const TEST_WIRE: EpisodeAlertDdeWire = {
  verified: true,
  buildSubmit: (secret, _ctx, op) => ({
    ok: true,
    value: {
      path: "t/submit",
      method: "POST",
      headers: { k: secret },
      body: JSON.stringify(op.beneficiary),
    },
  }),
  parseReceipt: (body, op) =>
    body === "bad"
      ? { ok: false, code: "EA_DDE_WIRE_UNREADABLE" }
      : {
          ok: true,
          value: {
            providerReference: "synthetic-ref-1",
            idempotencyKey: op.idempotencyKey,
            controlNumber: op.controlNumber,
            receivedAt: "2026-01-01T00:00:00Z",
            replayed: false,
          },
        },
  buildChangeReport: (secret) => ({
    ok: true,
    value: { path: "t/changes", method: "GET", headers: { k: secret } },
  }),
  parseChangeReport: () => ({
    ok: true,
    value: { items: [], nextCursor: "synthetic-cursor", hasMore: false },
  }),
  buildStatus: (secret) => ({
    ok: true,
    value: { path: "t/status", method: "GET", headers: { k: secret } },
  }),
  parseStatus: (_body, ref) => ({
    ok: true,
    value: { providerReference: ref, state: "received", latest: null },
  }),
};

function make(response: LocalFakeHttpResponse = { body: "ok" }, wire = TEST_WIRE) {
  const httpClient = new LocalFakeHttpClient([response]);
  const provider = new EpisodeAlertDdeProvider(
    { apiKey: SECRET, baseUrl: "https://vendor.invalid/api" },
    { wire, httpClient },
  );
  return { provider, httpClient };
}

const code = (result: { ok: boolean; degraded?: { code: string } }) =>
  result.ok ? "ok" : (result.degraded?.code ?? "?");

describe("Episode Alert DDE adapter skeleton (wire unverified)", () => {
  it("records no vendor fact and the default wire answers unverified for every operation", () => {
    expect(Object.values(EA_DDE_FACTS).every((value) => value === null)).toBe(true);
    expect(EA_DDE_WIRE.verified).toBe(false);
    expect(EA_DDE_WIRE.buildSubmit(SECRET, CTX, OP)).toEqual({ ok: false, code: WIRE_UNVERIFIED });
    expect(EA_DDE_WIRE.buildChangeReport(SECRET, CTX, null)).toEqual({
      ok: false,
      code: WIRE_UNVERIFIED,
    });
    expect(EA_DDE_WIRE.parseChangeReport("<x/>")).toEqual({ ok: false, code: WIRE_UNVERIFIED });
  });

  it("refuses to bind from environment and cannot be activated through DDE_PROVIDER", () => {
    const env = {
      [EPISODE_ALERT_DDE_API_KEY_ENV]: SECRET,
      [EPISODE_ALERT_DDE_BASE_URL_ENV]: "https://x.invalid",
    };
    expect(() => createEpisodeAlertDdeProviderFromEnv(env)).toThrow(
      /wire format and approved API destination/,
    );
    expect(() =>
      bindDdeProvider(
        { [DDE_PROVIDER_ENV]: "episode_alert", ...env },
        { episode_alert: (e) => createEpisodeAlertDdeProviderFromEnv(e) },
      ),
    ).toThrow(/wire format and approved API destination/);
    expect(() => bindDdeProvider({ [DDE_PROVIDER_ENV]: "episode_alert" }, {})).toThrow(
      /no adapter/,
    );
  });

  it("fails closed with DDE_NOT_WIRED and sends nothing when the default wire is unverified", async () => {
    const fetchSpy = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const provider = new EpisodeAlertDdeProvider({
        apiKey: SECRET,
        baseUrl: "https://vendor.invalid",
      });
      for (const result of [
        await provider.submitOperation(CTX, OP),
        await provider.fetchOutcomes(CTX, null),
        await provider.fetchOperationStatus(CTX, "synthetic-ref"),
      ]) {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.degraded.code).toBe(DDE.NOT_WIRED);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps synthetic MBI and key values out of degraded results", async () => {
    const { provider } = make({ body: `${MBI} ${SECRET}`, status: 500 });
    const result = JSON.stringify(await provider.submitOperation(CTX, OP));
    expect(result).not.toContain(MBI);
    expect(result).not.toContain(SECRET);
  });
});

describe("Episode Alert DDE local plumbing (scripted fake responses only)", () => {
  it("maps HTTP statuses without exposing bodies", async () => {
    const statusCases: readonly [number, string][] = [
      [200, "ok"],
      [401, DDE.NOT_PROVISIONED],
      [403, DDE.NOT_PROVISIONED],
      [422, DDE.INVALID_REQUEST],
      [409, DDE.IDEMPOTENCY_CONFLICT],
      [503, DDE.UNAVAILABLE],
    ];
    for (const [status, expected] of statusCases) {
      const { provider } = make({ body: `synthetic ${MBI} ${SECRET}`, status });
      expect(code(await provider.fetchOutcomes(CTX, null))).toBe(expected);
      expect(JSON.stringify(await provider.fetchOutcomes(CTX, null))).not.toContain(SECRET);
    }
  });

  it("maps local timeout/network and unreadable response behavior without returning payload text", async () => {
    const exhausted = new EpisodeAlertDdeProvider(
      { apiKey: SECRET, baseUrl: "https://vendor.invalid/api" },
      { wire: TEST_WIRE, httpClient: new LocalFakeHttpClient([]) },
    );
    expect(code(await exhausted.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
    const { provider } = make({ body: "bad" });
    expect(code(await provider.submitOperation(CTX, OP))).toBe(DDE.UNAVAILABLE);
  });

  it("refuses test usage without a local fake and allows it only with that no-network client", async () => {
    const fetchSpy = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const noFake = new EpisodeAlertDdeProvider({
        apiKey: SECRET,
        baseUrl: "https://vendor.invalid/api",
        allowTestUsage: true,
      } as EpisodeAlertDdeOptions);
      expect(code(await noFake.fetchOutcomes({ ...CTX, usage: "test" }, null))).toBe(
        DDE.NOT_PROVISIONED,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }

    const { provider, httpClient } = make();
    expect(code(await provider.fetchOutcomes({ ...CTX, usage: "test" }, null))).toBe("ok");
    expect(httpClient.requests).toHaveLength(1);
  });

  it("rejects an arbitrary fetch-shaped object as a local test client", () => {
    const arbitraryClient = { fetch: globalThis.fetch } as unknown as LocalFakeHttpClient;
    expect(
      () =>
        new EpisodeAlertDdeProvider(
          { apiKey: SECRET, baseUrl: "https://vendor.invalid/api" },
          { wire: TEST_WIRE, httpClient: arbitraryClient },
        ),
    ).toThrow(/LocalFakeHttpClient/);
  });

  it("rejects unsafe paths before the local fake is called", async () => {
    for (const path of [
      "//evil.invalid/x",
      "https://evil.invalid/x",
      "../other",
      "/root",
      "changes?token=x",
      "%2e%2e/x",
    ]) {
      const { provider, httpClient } = make();
      const wire: EpisodeAlertDdeWire = {
        ...TEST_WIRE,
        buildChangeReport: () => ({
          ok: true,
          value: { path, method: "GET", headers: { k: SECRET } },
        }),
      };
      const withWire = new EpisodeAlertDdeProvider(
        { apiKey: SECRET, baseUrl: "https://vendor.invalid/api" },
        { wire, httpClient },
      );
      expect(code(await withWire.fetchOutcomes(CTX, null))).toBe(DDE.INVALID_REQUEST);
      expect(httpClient.requests).toHaveLength(0);
    }
  });

  it("rejects oversized, mismatched, invalid UTF-8 and over-limit streamed responses", async () => {
    const oversizedDeclared: LocalFakeHttpResponse = {
      body: "ok",
      headers: { "content-length": "2000000" },
    };
    const mismatched: LocalFakeHttpResponse = { body: "short", headers: { "content-length": "2" } };
    const invalidUtf8: LocalFakeHttpResponse = { body: new Uint8Array([0xc3, 0x28]) };
    const streaming: LocalFakeHttpResponse = {
      chunks: [new Uint8Array(600_000), new Uint8Array(600_000)],
    };
    for (const response of [oversizedDeclared, mismatched, invalidUtf8, streaming]) {
      const { provider } = make(response);
      expect(code(await provider.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
    }
  });

  it("requires HTTPS without URL credentials, query or fragment", () => {
    for (const url of [
      "http://vendor.invalid",
      "https://u:p@vendor.invalid",
      "https://vendor.invalid?key=x",
      "https://vendor.invalid#fragment",
      "https://vendor.invalid\\@evil.invalid",
    ]) {
      expect(() => assertSafeBaseUrl(url)).toThrow();
    }
    expect(() => assertSafeBaseUrl("https://vendor.invalid/api")).not.toThrow();
    const env = {
      [EPISODE_ALERT_DDE_API_KEY_ENV]: SECRET,
      [EPISODE_ALERT_DDE_BASE_URL_ENV]: "https://vendor.invalid/api",
    };
    expect(() => createEpisodeAlertDdeProviderFromEnv(env)).toThrow(
      /wire format and approved API destination/,
    );
  });
});
