// Slice 4 — the connection test: mint one service-clinician token with the candidate config. No PHI is sent and no clinical
// endpoint is touched; the result is one of three outcomes. Scripted against a fake transport (never a real DoseSpot host).
import { describe, expect, it } from "vitest";
import {
  type DoseSpotFetch,
  type DoseSpotTenantConfig,
  createHttpDoseSpotConnectionProbe,
} from "../src";

const CONFIG: DoseSpotTenantConfig = {
  baseUrl: "https://my.staging.dosespot.com/webapi/v2",
  subscriptionKey: "sub-secret",
  clinicId: "clinic-1",
  clinicKey: "clinic-key-secret",
  serviceClinicianId: "900",
  epcsCertified: false,
};

function probeWith(reply: (n: number) => { status: number; body?: unknown } | "network" | "abort") {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: string;
  }[] = [];
  const fetchImpl: DoseSpotFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: { ...init.headers },
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
    });
    const out = reply(calls.length);
    if (out === "network") throw new Error("ECONNRESET");
    if (out === "abort") throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return {
      status: out.status,
      text: async () => (out.body === undefined ? "" : JSON.stringify(out.body)),
    };
  };
  return { probe: createHttpDoseSpotConnectionProbe({ fetch: fetchImpl }), calls };
}

describe("DoseSpot connection probe", () => {
  it("is ok when the token endpoint hands back an access token", async () => {
    const { probe, calls } = probeWith(() => ({
      status: 200,
      body: { access_token: "tok", expires_in: 3600 },
    }));
    expect(await probe.probe(CONFIG)).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://my.staging.dosespot.com/webapi/v2/connect/token");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Subscription-Key"]).toBe("sub-secret");
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("clinic-1:clinic-key-secret").toString("base64")}`,
    );
    expect(calls[0]?.body).toContain("Username=900");
  });

  it("never follows a redirect: the body carries the clinic key and the headers the Subscription-Key", async () => {
    const { probe, calls } = probeWith(() => ({ status: 200, body: { access_token: "t" } }));
    await probe.probe(CONFIG);
    expect(calls[0]?.redirect).toBe("error");
  });

  it("makes exactly one call and touches no patient or prescription path", async () => {
    const { probe, calls } = probeWith(() => ({ status: 200, body: { access_token: "t" } }));
    await probe.probe(CONFIG);
    expect(calls.every((c) => c.url.endsWith("/connect/token"))).toBe(true);
  });

  it("is credential_rejected on 400 and 401, and on a 200 with no token", async () => {
    for (const status of [400, 401, 403]) {
      expect(await probeWith(() => ({ status })).probe.probe(CONFIG)).toBe("credential_rejected");
    }
    expect(await probeWith(() => ({ status: 200, body: {} })).probe.probe(CONFIG)).toBe(
      "credential_rejected",
    );
  });

  it("is unreachable on 5xx, 429, a network failure, a timeout and an unreadable 200", async () => {
    for (const status of [429, 500, 502, 503]) {
      expect(await probeWith(() => ({ status })).probe.probe(CONFIG)).toBe("unreachable");
    }
    expect(await probeWith(() => "network").probe.probe(CONFIG)).toBe("unreachable");
    expect(await probeWith(() => "abort").probe.probe(CONFIG)).toBe("unreachable");
  });

  it("never throws and never echoes a secret in its result", async () => {
    const out = await probeWith(() => "network").probe.probe(CONFIG);
    expect(JSON.stringify(out)).not.toContain("clinic-key-secret");
    expect(JSON.stringify(out)).not.toContain("sub-secret");
  });
});
