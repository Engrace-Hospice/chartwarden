import { describe, expect, it, vi } from "vitest";
import { LocalFakeHttpClient, type LocalFakeHttpResponse } from "../testing/local-fake-http-client";
import {
  type ClearinghouseHarness,
  type ConformanceCapability,
  type ConformanceScript,
  DEFAULT_SCOPE,
  SYNTHETIC_MBI,
  runConformance,
} from "./conformance";
import {
  parseEpisodeAlertEligibilityXml,
  toIsoDate,
  unverifiedFixtureEligibilityOutcome,
} from "./episode-alert-eligibility";
import {
  EPISODE_ALERT_API_KEY_ENV,
  EPISODE_ALERT_BASE_URL_ENV,
  EpisodeAlertTransport,
  createEpisodeAlertTransportFromEnv,
} from "./episode-alert-transport";
import type { EpisodeAlertTransportOptions } from "./episode-alert-transport";
import { CH } from "./types";

// These synthetic fixtures exercise a guessed mapping only. They are not Episode Alert schema or vendor evidence.
const xml = (start: string | null, end: string | null = null): string =>
  `<EligibilityResponse>${start === null ? "" : `<PartAEligibilityStartDate>${start}</PartAEligibilityStartDate>`}${
    end === null ? "" : `<PartAEligibilityEndDate>${end}</PartAEligibilityEndDate>`
  }</EligibilityResponse>`;

describe("Episode Alert eligibility XML fixture parser (local evidence only)", () => {
  const day = "2026-10-01";
  it("evaluates the existing synthetic Part A date fixtures", () => {
    expect(unverifiedFixtureEligibilityOutcome(xml("20240101"), day)).toBe("active");
    expect(unverifiedFixtureEligibilityOutcome(xml("20261002"), day)).toBe("inactive");
    expect(unverifiedFixtureEligibilityOutcome(xml("20240101", "20260930"), day)).toBe("inactive");
  });

  it.each([
    "",
    "<EligibilityResponse><PartAStartDate>20240101</EligibilityResponse>",
    "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate></NotTheSame>",
    "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate>",
    "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate></EligibilityResponse><Extra/>",
    "<EligibilityResponse><x:PartAStartDate>20240101</x:PartAStartDate></EligibilityResponse>",
  ])("rejects malformed XML or an invalid root (%j)", (input) => {
    expect(parseEpisodeAlertEligibilityXml(input, day).kind).toBe("malformed");
    expect(unverifiedFixtureEligibilityOutcome(input, day)).not.toBe("active");
  });

  it("marks a structurally valid but unrecognized root as unsupported", () => {
    expect(
      parseEpisodeAlertEligibilityXml("<PartAStartDate>20240101</PartAStartDate>", day).kind,
    ).toBe("unsupported");
    expect(
      parseEpisodeAlertEligibilityXml(
        "<UnverifiedResponse><PartAStartDate>20240101</PartAStartDate></UnverifiedResponse>",
        day,
      ),
    ).toEqual({ kind: "unsupported" });
    expect(
      unverifiedFixtureEligibilityOutcome(
        "<UnverifiedResponse><PartAStartDate>20240101</PartAStartDate></UnverifiedResponse>",
        day,
      ),
    ).toBe("unknown");
  });

  it("does not match field fragments outside a valid document element", () => {
    expect(
      unverifiedFixtureEligibilityOutcome("<PartAStartDate>20240101</PartAStartDate>", day),
    ).toBe("unknown");
    expect(
      unverifiedFixtureEligibilityOutcome("text <PartAStartDate>20240101</PartAStartDate>", day),
    ).toBe("unknown");
  });

  it("rejects duplicate, conflicting, nested and attributed date fields conservatively", () => {
    const cases = [
      "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate><PartAEndDate>20250101</PartAEndDate><PartAEndDate>20270101</PartAEndDate></EligibilityResponse>",
      "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate><PartAEligibilityStartDate>20240201</PartAEligibilityStartDate></EligibilityResponse>",
      "<EligibilityResponse><PartAStartDate><Date>20240101</Date></PartAStartDate></EligibilityResponse>",
      '<EligibilityResponse><PartAStartDate format="date">20240101</PartAStartDate></EligibilityResponse>',
      "<EligibilityResponse><PartAStartDate>20240101</PartAStartDate><PartAEndDate>20230101</PartAEndDate></EligibilityResponse>",
    ];
    for (const input of cases) {
      expect(parseEpisodeAlertEligibilityXml(input, day).kind).toBe("malformed");
      expect(unverifiedFixtureEligibilityOutcome(input, day)).toBe("unknown");
    }
  });

  it("rejects invalid dates and treats unknown fields or missing starts as unknown", () => {
    expect(parseEpisodeAlertEligibilityXml(xml("2026-99-99"), day).kind).toBe("malformed");
    expect(unverifiedFixtureEligibilityOutcome(xml(null), day)).toBe("unknown");
    expect(
      unverifiedFixtureEligibilityOutcome(
        "<EligibilityResponse><FutureField>active</FutureField></EligibilityResponse>",
        day,
      ),
    ).toBe("unknown");
  });

  it("rejects DTD/entity declarations and over-limit input without expansion", () => {
    const entity =
      '<!DOCTYPE x [<!ENTITY e "20240101">]><EligibilityResponse><PartAStartDate>&e;</PartAStartDate></EligibilityResponse>';
    const external =
      '<!DOCTYPE x SYSTEM "file:///not-read"><EligibilityResponse><PartAStartDate>20240101</PartAStartDate></EligibilityResponse>';
    expect(parseEpisodeAlertEligibilityXml(entity, day).kind).toBe("malformed");
    expect(parseEpisodeAlertEligibilityXml(external, day).kind).toBe("malformed");
    expect(unverifiedFixtureEligibilityOutcome("x".repeat(1_000_001), day)).toBe("unknown");
  });

  it("bounds XML nesting and node counts", () => {
    const tooDeep = `<EligibilityResponse>${"<n>".repeat(65)}x${"</n>".repeat(65)}</EligibilityResponse>`;
    const tooManyNodes = `<EligibilityResponse>${"<n/>".repeat(10_001)}</EligibilityResponse>`;
    expect(parseEpisodeAlertEligibilityXml(tooDeep, day).kind).toBe("malformed");
    expect(parseEpisodeAlertEligibilityXml(tooManyNodes, day).kind).toBe("malformed");
  });

  it("does not treat comment or CDATA fragments as XML elements", () => {
    expect(
      unverifiedFixtureEligibilityOutcome(
        "<EligibilityResponse><!-- <PartAStartDate>20240101</PartAStartDate> --></EligibilityResponse>",
        day,
      ),
    ).toBe("unknown");
    expect(
      unverifiedFixtureEligibilityOutcome(
        "<EligibilityResponse><![CDATA[<PartAStartDate>20240101</PartAStartDate>]]></EligibilityResponse>",
        day,
      ),
    ).toBe("unknown");
  });

  it("accepts a declared namespace prefix in local fixtures but rejects undeclared prefixes", () => {
    const prefixed =
      '<ns:EligibilityResponse xmlns:ns="urn:synthetic"><ns:PartAStartDate>20240101</ns:PartAStartDate></ns:EligibilityResponse>';
    expect(unverifiedFixtureEligibilityOutcome(prefixed, day)).toBe("active");
    expect(
      unverifiedFixtureEligibilityOutcome(
        "<ns:EligibilityResponse><ns:PartAStartDate>20240101</ns:PartAStartDate></ns:EligibilityResponse>",
        day,
      ),
    ).toBe("unknown");
  });
});

describe("toIsoDate", () => {
  it("normalizes the fixture formats and rejects impossible dates", () => {
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
  payerId: "synthetic-payer",
  correlationId: "corr-1",
  usage: "production",
} as const;
const REQ = { mbi: SYNTHETIC_MBI, serviceDate: "2026-10-01" } as const;
const KEY = "synthetic-ea-key-not-a-credential";

function localTransport(responses: readonly LocalFakeHttpResponse[]) {
  const local = new LocalFakeHttpClient(responses);
  const transport = new EpisodeAlertTransport(
    { apiKey: KEY, baseUrl: "https://api.example.test/v1/" },
    local,
  );
  return { transport, local };
}

describe("EpisodeAlertTransport.checkEligibility", () => {
  it("runs a synthetic test-usage request only through the response-only local fake", async () => {
    const { transport, local } = localTransport([{ body: xml("20240101") }]);
    const r = await transport.checkEligibility({ ...CTX, usage: "test" }, REQ);
    expect(r).toEqual({ ok: true, data: { outcome: "active", asOfDate: "2026-10-01" } });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0]).toMatchObject({
      url: "https://api.example.test/v1/eligibility",
      method: "POST",
      redirect: "error",
    });
    expect(String(local.requests[0]?.body)).toContain(SYNTHETIC_MBI);
    expect(JSON.stringify(r)).not.toContain(SYNTHETIC_MBI);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("refuses test usage with the default fetch client even when an obsolete bypass flag is supplied", async () => {
    const fetchSpy = vi.fn(async () => new Response(xml("20240101")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const transport = new EpisodeAlertTransport({
        apiKey: KEY,
        baseUrl: "https://api.example.test",
        allowTestUsage: true,
      } as EpisodeAlertTransportOptions);
      const r = await transport.checkEligibility({ ...CTX, usage: "test" }, REQ);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(CH.INVALID_REQUEST);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed on the unverified production wire before global fetch", async () => {
    const fetchSpy = vi.fn(async () => new Response(xml("20240101")));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const transport = new EpisodeAlertTransport({
        apiKey: KEY,
        baseUrl: "https://api.example.test",
      });
      const r = await transport.checkEligibility(CTX, REQ);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(CH.NOT_WIRED);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses malformed requests before calling the local fake", async () => {
    const { transport, local } = localTransport([]);
    for (const bad of [
      { mbi: "short", serviceDate: "2026-10-01" },
      { mbi: SYNTHETIC_MBI, serviceDate: "10/01/2026" },
      { mbi: SYNTHETIC_MBI, serviceDate: "2026-99-99" },
      { memberId: "SYNTHETIC-MEMBER-77", serviceDate: "2026-10-01" },
    ]) {
      const r = await transport.checkEligibility(CTX, bad);
      expect(r.ok).toBe(false);
    }
    expect(local.requests).toHaveLength(0);
  });

  it.each([
    [401, CH.NOT_PROVISIONED],
    [403, CH.NOT_PROVISIONED],
    [422, CH.INVALID_REQUEST],
    [429, CH.UNAVAILABLE],
    [503, CH.UNAVAILABLE],
  ])("maps HTTP %i to %s without echoing the body", async (status, code) => {
    const { transport } = localTransport([{ body: `synthetic error ${SYNTHETIC_MBI}`, status }]);
    const r = await transport.checkEligibility(CTX, REQ);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.degraded.code).toBe(code);
      expect(r.degraded.reason).not.toContain(SYNTHETIC_MBI);
    }
  });

  it("treats oversized, malformed and unsupported responses as unavailable, never inactive", async () => {
    const cases = [
      { body: xml("20240101"), headers: { "content-length": "2000000" } },
      { body: "<EligibilityResponse><PartAStartDate>20240101</EligibilityResponse>" },
      { body: "<Unverified><PartAStartDate>20240101</PartAStartDate></Unverified>" },
    ];
    for (const response of cases) {
      const { transport } = localTransport([response]);
      const r = await transport.checkEligibility(CTX, REQ);
      expect(r.ok).toBe(false);
      if (!r.ok) expect([CH.UNAVAILABLE, CH.NOT_WIRED]).toContain(r.degraded.code);
    }
  });

  it("refuses unsafe base URLs", () => {
    for (const baseUrl of [
      "http://api.example.test",
      "https://user:pass@api.example.test",
      "https://api.example.test/v1?token=synthetic",
      "https://api.example.test/v1#fragment",
      "https://api.example.test\\@evil.example.test",
    ]) {
      expect(() => new EpisodeAlertTransport({ apiKey: KEY, baseUrl })).toThrow();
    }
  });

  it("keeps the key out of the URL and result; unimplemented methods remain CH_NOT_WIRED", async () => {
    const { transport, local } = localTransport([{ body: xml("20240101") }]);
    const r = await transport.checkEligibility(CTX, REQ);
    expect(local.requests[0]?.url).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
    const results = await Promise.all([
      transport.fetchAcknowledgments(CTX, null),
      transport.fetchRemittances(CTX, null),
      transport.fetchClaimStatus(CTX, "SYNTHETIC-CCN"),
      transport.verifyAndParseEvent({ headers: {}, rawBody: "{}" }),
    ]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.degraded.code).toBe(CH.NOT_WIRED);
    }
  });
});

describe("createEpisodeAlertTransportFromEnv", () => {
  it("refuses the configured production factory even when credentials and URL are present", () => {
    expect(() =>
      createEpisodeAlertTransportFromEnv({
        [EPISODE_ALERT_API_KEY_ENV]: KEY,
        [EPISODE_ALERT_BASE_URL_ENV]: "https://api.example.test",
        EPISODE_ALERT_ALLOW_TEST_USAGE: "yes",
      }),
    ).toThrow(/wire and approved API destination are unverified/);
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
    payerPartiallyAccepts: unsupported("payerPartiallyAccepts"),
    deliverRemittance: unsupported("deliverRemittance"),
    setEnrollment: unsupported("setEnrollment"),
    signedEvent: unsupported("signedEvent"),
    tamperedEvent: unsupported("tamperedEvent"),
  };
  return {
    transport: new EpisodeAlertTransport(
      { apiKey: KEY, baseUrl: "https://api.example.test" },
      new LocalFakeHttpClient([{ body: xml("20240101") }]),
    ),
    script,
    capabilities: new Set<ConformanceCapability>(["eligibility"]),
  };
}

describe("EpisodeAlertTransport against the shared conformance suite (eligibility)", () => {
  it("passes the local fixture case and labels the rest unsupported", async () => {
    const outcomes = await runConformance(async () => createHarness());
    expect(outcomes.filter((outcome) => outcome.status === "failed")).toEqual([]);
    expect(
      outcomes.filter((outcome) => outcome.status === "passed").map((outcome) => outcome.id),
    ).toEqual(["C01-eligibility-outcome-only"]);
  });
});
