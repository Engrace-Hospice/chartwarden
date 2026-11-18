import { describe, expect, it } from "vitest";
import { LocalFakeHttpClient, type LocalFakeHttpResponse } from "../testing/local-fake-http-client";
import {
  EPISODE_ALERT_DDE_API_KEY_ENV,
  EPISODE_ALERT_DDE_BASE_URL_ENV,
  EpisodeAlertDdeProvider,
  createEpisodeAlertDdeProviderFromEnv,
} from "./episode-alert-dde-provider";
import type { EpisodeAlertDdeWire } from "./episode-alert-dde-wire";
import { DDE, type DdeContext } from "./types";

const SECRET = "ea-secret-key-123";
const CTX: DdeContext = {
  organizationId: "org-1",
  providerEntityId: "pe-1",
  operatorMembershipId: "op-1",
  correlationId: "c-1",
  usage: "production",
};

/** A wire for exercising the plumbing ONLY: its paths are invented here and exist nowhere else. */
const wireFor = (path: string): EpisodeAlertDdeWire => ({
  verified: true,
  buildSubmit: () => ({ ok: false, code: "EA_DDE_WIRE_UNREADABLE" }),
  parseReceipt: () => ({ ok: false, code: "EA_DDE_WIRE_UNREADABLE" }),
  buildChangeReport: (secret) => ({
    ok: true,
    value: { path, method: "GET", headers: { k: secret } },
  }),
  parseChangeReport: () => ({ ok: true, value: { items: [], nextCursor: "1", hasMore: false } }),
  buildStatus: () => ({ ok: false, code: "EA_DDE_WIRE_UNREADABLE" }),
  parseStatus: () => ({ ok: false, code: "EA_DDE_WIRE_UNREADABLE" }),
});

const provider = (path: string, responses: readonly LocalFakeHttpResponse[] = [{ body: "ok" }]) =>
  new EpisodeAlertDdeProvider(
    { apiKey: SECRET, baseUrl: "https://vendor.invalid/api" },
    { wire: wireFor(path), httpClient: new LocalFakeHttpClient(responses) },
  );
const code = (r: { ok: boolean; degraded?: { code: string } }) =>
  r.ok ? "ok" : (r.degraded?.code ?? "?");

describe("Episode Alert DDE plumbing hardening", () => {
  it("never sends the credential to another origin or above the API root", async () => {
    const response: LocalFakeHttpResponse = { body: "ok" };
    for (const path of ["//evil.invalid/x", "https://evil.invalid/x", "../other", "/root"]) {
      expect(code(await provider(path, [response]).fetchOutcomes(CTX, null))).toBe(
        DDE.INVALID_REQUEST,
      );
    }
    expect(code(await provider("changes").fetchOutcomes(CTX, null))).toBe("ok");
  });

  it("refuses an answer over the byte cap, by stream or by header", async () => {
    const big = "x".repeat(1_000_001);
    const byStream = provider("c", [{ body: big }]);
    expect(code(await byStream.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
    const byHeader = provider("c", [{ body: "ok", headers: { "content-length": "2000000" } }]);
    expect(code(await byHeader.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
  });

  it("requires an https base URL without embedded credentials", () => {
    const key = { [EPISODE_ALERT_DDE_API_KEY_ENV]: SECRET };
    for (const url of ["http://vendor.invalid", "https://u:p@vendor.invalid", "not a url"]) {
      expect(() => new EpisodeAlertDdeProvider({ apiKey: SECRET, baseUrl: url })).toThrow();
    }
    expect(() =>
      createEpisodeAlertDdeProviderFromEnv({
        ...key,
        [EPISODE_ALERT_DDE_BASE_URL_ENV]: "https://vendor.invalid/api",
      }),
    ).toThrow(/wire format and approved API destination/);
  });
});
