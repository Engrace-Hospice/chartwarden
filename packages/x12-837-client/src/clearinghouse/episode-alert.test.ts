import { describe, expect, it } from "vitest";
import {
  type ClearinghouseHarness,
  type ConformanceCapability,
  type ConformanceScript,
  DEFAULT_SCOPE,
  SYNTHETIC_MBI,
  runConformance,
} from "./conformance";
import { eligibilityOutcomeFromXml, toIsoDate } from "./episode-alert-eligibility";
import {
  EPISODE_ALERT_API_KEY_ENV,
  EPISODE_ALERT_BASE_URL_ENV,
  EpisodeAlertTransport,
  createEpisodeAlertTransportFromEnv,
} from "./episode-alert-transport";
import { CH } from "./types";

// Fixtures are synthetic and UNVERIFIED: element names come from the public sample report's labels, not a real
// response. Replace them with a recorded trial response when one exists.
const xml = (start: string | null, end: string | null = null): string =>
  `<EligibilityResponse>${start === null ? "" : `<PartAEligibilityStartDate>${start}</PartAEligibilityStartDate>`}${
    end === null ? "" : `<PartAEligibilityEndDate>${end}</PartAEligibilityEndDate>`
  }</EligibilityResponse>`;

describe("eligibilityOutcomeFromXml", () => {
  const day = "2026-10-01";
  it("is active when Part A started on or before the service date and has not ended", () => {
    expect(eligibilityOutcomeFromXml(xml("20240101"), day)).toBe("active");
    expect(eligibilityOutcomeFromXml(xml("2026-10-01", "2027-01-01"), day)).toBe("active");
    expect(eligibilityOutcomeFromXml(xml("01/01/2024", "10/01/2026"), day)).toBe("active");
  });

  it("is inactive when Part A started later or ended earlier", () => {
    expect(eligibilityOutcomeFromXml(xml("20261002"), day)).toBe("inactive");
    expect(eligibilityOutcomeFromXml(xml("20240101", "20260930"), day)).toBe("inactive");
  });

  it("is unknown, never active, when the start date is missing or either date is unreadable", () => {
    expect(eligibilityOutcomeFromXml(xml(null, "20270101"), day)).toBe("unknown");
    expect(eligibilityOutcomeFromXml(xml("soon"), day)).toBe("unknown");
    expect(eligibilityOutcomeFromXml(xml("20240101", "tbd"), day)).toBe("unknown");
    expect(eligibilityOutcomeFromXml("<Error>nope</Error>", day)).toBe("unknown");
    expect(eligibilityOutcomeFromXml("x".repeat(1_000_001), day)).toBe("unknown");
  });

  it("accepts a namespace prefix on the element", () => {
    const prefixed =
      "<ns:R><ns:PartAEligibilityStartDate>20240101</ns:PartAEligibilityStartDate></ns:R>";
    expect(eligibilityOutcomeFromXml(prefixed, day)).toBe("active");
  });
});

describe("toIsoDate", () => {
  it("normalises three formats and rejects impossible dates", () => {
    expect(toIsoDate("20240229")).toBe("2024-02-29");
    expect(toIsoDate("2024-02-29")).toBe("2024-02-29");
    expect(toIsoDate("02/29/2024")).toBe("2024-02-29");
    expect(toIsoDate("20250229")).toBeNull();
    expect(toIsoDate("20241301")).toBeNull();
    expect(toIsoDate("yesterday")).toBeNull();
  });
});

const CTX = {
  ...DEFAULT_SCOPE,
  payerId: "payer",
  correlationId: "corr-1",
  usage: "production",
} as const;
const REQ = { mbi: SYNTHETIC_MBI, serviceDate: "2026-10-01" } as const;
const KEY = "ea_key_do_not_leak";

function transportWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const transport = new EpisodeAlertTransport({
    apiKey: KEY,
    baseUrl: "https://api.example.test/v1/",
    fetch: fetchImpl,
  });
  return { transport, calls };
}

describe("EpisodeAlertTransport.checkEligibility", () => {
  it("maps a response to an outcome and keeps the MBI out of the result", async () => {
    const { transport, calls } = transportWith(() => new Response(xml("20240101")));
    const r = await transport.checkEligibility(CTX, REQ);
    expect(r).toEqual({ ok: true, data: { outcome: "active", asOfDate: "2026-10-01" } });
    expect(JSON.stringify(r)).not.toContain("1EG4");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/v1/eligibility");
    expect(calls[0]?.init.redirect).toBe("error");
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("refuses a test-usage call because the vendor has no test mode", async () => {
    const { transport, calls } = transportWith(() => new Response(xml("20240101")));
    const r = await transport.checkEligibility({ ...CTX, usage: "test" }, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.degraded.code).toBe(CH.INVALID_REQUEST);
    expect(calls).toHaveLength(0);
  });

  it("refuses a malformed request before any network call", async () => {
    const { transport, calls } = transportWith(() => new Response(xml("20240101")));
    for (const bad of [
      { mbi: "short", serviceDate: "2026-10-01" },
      { mbi: SYNTHETIC_MBI, serviceDate: "10/01/2026" },
    ]) {
      const r = await transport.checkEligibility(CTX, bad);
      expect(r.ok).toBe(false);
    }
    expect(calls).toHaveLength(0);
  });

  it.each([
    [401, CH.NOT_PROVISIONED],
    [403, CH.NOT_PROVISIONED],
    [422, CH.INVALID_REQUEST],
    [429, CH.UNAVAILABLE],
    [503, CH.UNAVAILABLE],
  ])("maps HTTP %i to %s without echoing the body", async (status, code) => {
    const { transport } = transportWith(() => new Response(`secret ${SYNTHETIC_MBI}`, { status }));
    const r = await transport.checkEligibility(CTX, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.degraded.code).toBe(code);
      expect(r.degraded.reason).not.toContain("1EG4");
    }
  });

  it("answers UNAVAILABLE, never a throw, when the network fails", async () => {
    const { transport } = transportWith(() => {
      throw new Error(`boom ${SYNTHETIC_MBI}`);
    });
    const r = await transport.checkEligibility(CTX, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.degraded.code).toBe(CH.UNAVAILABLE);
      expect(r.degraded.reason).not.toContain("1EG4");
    }
  });

  it("answers every other method CH_NOT_WIRED", async () => {
    const { transport } = transportWith(() => new Response(""));
    const results = await Promise.all([
      transport.fetchAcknowledgments(CTX, null),
      transport.fetchRemittances(CTX, null),
      transport.fetchClaimStatus(CTX, "CCN-1"),
      transport.verifyAndParseEvent({ headers: {}, rawBody: "{}" }),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(CH.NOT_WIRED);
    }
  });
});

describe("createEpisodeAlertTransportFromEnv", () => {
  const good = {
    [EPISODE_ALERT_API_KEY_ENV]: KEY,
    [EPISODE_ALERT_BASE_URL_ENV]: "https://api.example.test",
  };
  it("builds from a complete environment", () => {
    expect(createEpisodeAlertTransportFromEnv(good).vendor).toBe("episode_alert");
  });
  it("throws at boot for a missing key, a missing URL or a non-https URL", () => {
    expect(() =>
      createEpisodeAlertTransportFromEnv({ ...good, [EPISODE_ALERT_API_KEY_ENV]: "" }),
    ).toThrow(EPISODE_ALERT_API_KEY_ENV);
    expect(() => createEpisodeAlertTransportFromEnv({ [EPISODE_ALERT_API_KEY_ENV]: KEY })).toThrow(
      EPISODE_ALERT_BASE_URL_ENV,
    );
    expect(() =>
      createEpisodeAlertTransportFromEnv({
        ...good,
        [EPISODE_ALERT_BASE_URL_ENV]: "http://x.test",
      }),
    ).toThrow(/https/);
  });
});

function unsupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the Episode Alert harness does not script ${name}`));
}

function createHarness(): ClearinghouseHarness {
  const script: ConformanceScript = {
    setOutage: unsupported("setOutage"),
    clearinghouseAccepts: unsupported("clearinghouseAccepts"),
    clearinghouseRejects: unsupported("clearinghouseRejects"),
    payerAccepts: unsupported("payerAccepts"),
    payerRejects: unsupported("payerRejects"),
    deliverRemittance: unsupported("deliverRemittance"),
    setEnrollment: unsupported("setEnrollment"),
    signedEvent: unsupported("signedEvent"),
    tamperedEvent: unsupported("tamperedEvent"),
  };
  return {
    transport: new EpisodeAlertTransport({
      apiKey: KEY,
      baseUrl: "https://api.example.test",
      allowTestUsage: true,
      fetch: (async () => new Response(xml("20240101"))) as unknown as typeof fetch,
    }),
    script,
    capabilities: new Set<ConformanceCapability>(["eligibility"]),
  };
}

describe("EpisodeAlertTransport against the shared conformance suite (eligibility)", () => {
  it("passes every case it implements and skips the rest by name", async () => {
    const outcomes = await runConformance(async () => createHarness());
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    expect(outcomes.filter((o) => o.status === "passed").map((o) => o.id)).toEqual([
      "C01-eligibility-outcome-only",
    ]);
  });
});
