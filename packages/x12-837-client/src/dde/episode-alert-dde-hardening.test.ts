import { describe, expect, it } from "vitest";
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

const provider = (path: string, f: typeof fetch) =>
  new EpisodeAlertDdeProvider({
    apiKey: SECRET,
    baseUrl: "https://vendor.invalid/api",
    wire: wireFor(path),
    fetch: f,
  });
const code = (r: { ok: boolean; degraded?: { code: string } }) =>
  r.ok ? "ok" : (r.degraded?.code ?? "?");

describe("Episode Alert DDE plumbing hardening", () => {
  it("never sends the credential to another origin or above the API root", async () => {
    let calls = 0;
    const f = (async () => {
      calls += 1;
      return new Response("ok");
    }) as unknown as typeof fetch;
    for (const path of ["//evil.invalid/x", "https://evil.invalid/x", "../other", "/root"]) {
      expect(code(await provider(path, f).fetchOutcomes(CTX, null))).toBe(DDE.INVALID_REQUEST);
    }
    expect(calls).toBe(0);
    expect(code(await provider("changes", f).fetchOutcomes(CTX, null))).toBe("ok");
    expect(calls).toBe(1);
  });

  it("refuses an answer over the byte cap, by stream or by header", async () => {
    const big = "x".repeat(1_000_001);
    const byStream = provider("c", (async () => new Response(big)) as unknown as typeof fetch);
    expect(code(await byStream.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
    const byHeader = provider(
      "c",
      (async () =>
        new Response("ok", {
          headers: { "content-length": "2000000" },
        })) as unknown as typeof fetch,
    );
    expect(code(await byHeader.fetchOutcomes(CTX, null))).toBe(DDE.UNAVAILABLE);
  });

  it("requires an https base URL without embedded credentials", () => {
    const key = { [EPISODE_ALERT_DDE_API_KEY_ENV]: SECRET };
    for (const url of ["http://vendor.invalid", "https://u:p@vendor.invalid", "not a url"]) {
      expect(() =>
        createEpisodeAlertDdeProviderFromEnv(
          { ...key, [EPISODE_ALERT_DDE_BASE_URL_ENV]: url },
          wireFor("c"),
        ),
      ).toThrow();
    }
    expect(
      createEpisodeAlertDdeProviderFromEnv(
        { ...key, [EPISODE_ALERT_DDE_BASE_URL_ENV]: "https://vendor.invalid/api" },
        wireFor("c"),
      ).vendor,
    ).toBe("episode_alert");
  });
});
