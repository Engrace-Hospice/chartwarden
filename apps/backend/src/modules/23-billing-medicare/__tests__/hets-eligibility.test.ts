// M23 §4.4 — the bound HETS 270/271 port: MBI unlock → 270 → transport → 271 parse → hospice history, plus
// the env configuration. Uses the fixture-backed sandbox transport (no network) and a fake M5 unlock seam.
import type { EligibilitySubscriberIdentity, MbiUnlockReader } from "@wardenx/types";
import {
  type HetsTransport,
  HetsTransportError,
  createSandboxHetsTransport,
} from "@wardenx/x12-837-client";
import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY_FRESHNESS_DAYS,
  buildHetsEligibilityPort,
  m23HetsConfigFromEnv,
} from "../jobs/hets-eligibility";

const MBI = "1EG4TE5MK73";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const INPUT = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  patientId: "22222222-2222-4222-8222-222222222222",
  providerEntityId: "33333333-3333-4333-8333-333333333333",
  asOfServiceDate: "2026-10-06",
  eligibilityCheckId: "55555555-5555-4555-8555-555555555555",
};

const identity = (lastName = "DOE"): EligibilitySubscriberIdentity => ({
  patientPayerId: "44444444-4444-4444-8444-444444444444",
  mbi: MBI,
  lastName,
  firstName: "JANE",
  dateOfBirth: "1940-04-01",
});

function harness(opts: {
  subscriber?: EligibilitySubscriberIdentity | null;
  transport?: HetsTransport;
  provider?: { npi: string; organizationName: string } | null;
}) {
  const sent: string[] = [];
  const base = opts.transport ?? createSandboxHetsTransport();
  const transport: HetsTransport = {
    kind: base.kind,
    exchange: async (req) => {
      sent.push(req.x12);
      return base.exchange(req);
    },
  };
  const unlockCalls: unknown[] = [];
  const unlock: MbiUnlockReader = {
    unlockForEligibility: async (input) => {
      unlockCalls.push(input);
      return opts.subscriber === undefined ? identity() : opts.subscriber;
    },
  };
  const port = buildHetsEligibilityPort({
    transport,
    submitterId: "A123456",
    usage: "T",
    mbiUnlock: () => unlock,
    providers: {
      providerForEligibility: async () =>
        opts.provider === undefined
          ? { npi: "1234567893", organizationName: "Engrace Hospice" }
          : opts.provider,
    },
    now: () => NOW,
  });
  return { port, sent, unlockCalls };
}

describe("buildHetsEligibilityPort", () => {
  it("runs the 270/271 round-trip and returns the hospice history without the MBI", async () => {
    const { port, sent, unlockCalls } = harness({});
    const result = await port.check(INPUT);

    expect(unlockCalls).toEqual([
      {
        organizationId: INPUT.organizationId,
        patientId: INPUT.patientId,
        onDate: "2026-10-06",
        disclosure: { purpose: "hets_270_eligibility", subjectId: INPUT.eligibilityCheckId },
      },
    ]);
    // The MBI went into the 270 (and only there).
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`*MI*${MBI}~`);
    expect(sent[0]).toContain("EQ*30^45~");

    expect(result.outcome).toBe("active_part_a");
    expect(result.reason).toBeNull();
    expect(result.transport).toBe("sandbox");
    expect(result.partAEffectiveDate).toBe("2005-04-01");
    expect(result.hospiceElectionOnFile).toBe(true);
    expect(result.hospice).toMatchObject({
      electionOpen: false,
      nextPeriodNumber: 4,
      nextPeriodBasis: "computed",
    });
    expect(result.responseFileUri).toBeNull();
    expect(result.correlationId).toMatch(/^[0-9a-f]{30}$/);
    expect(result.staleAt.getTime() - NOW.getTime()).toBe(ELIGIBILITY_FRESHNESS_DAYS * 86_400_000);
    expect(JSON.stringify(result)).not.toContain(MBI);
    expect(JSON.stringify(result)).not.toContain("1940");
  });

  it("flags an open election at another hospice", async () => {
    const { port } = harness({ subscriber: identity("OPENELECTION") });
    const result = await port.check(INPUT);
    expect(result.hospice).toMatchObject({ electionOpen: true, nextPeriodNumber: null });
  });

  it("records mbi_invalid without calling HETS when no Medicare MBI is on file", async () => {
    const { port, sent } = harness({ subscriber: null });
    const result = await port.check(INPUT);
    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({
      outcome: "mbi_invalid",
      reason: "mbi_not_on_file",
      hospice: null,
    });
    expect(result.staleAt).toEqual(NOW);
  });

  it("records mbi_invalid without calling HETS when the MBI is malformed", async () => {
    const { port, sent } = harness({ subscriber: { ...identity(), mbi: "NOT-AN-MBI" } });
    const result = await port.check(INPUT);
    expect(sent).toHaveLength(0);
    expect(result).toMatchObject({ outcome: "mbi_invalid", reason: "subscriber_identity_invalid" });
  });

  it("maps HETS AAA 72 to mbi_invalid with the rejection code and no hospice history", async () => {
    const { port } = harness({ subscriber: identity("NOTFOUND") });
    const result = await port.check(INPUT);
    expect(result).toMatchObject({
      outcome: "mbi_invalid",
      rejectionCodes: ["2100C:72"],
      hospice: null,
      reason: "hets_271_mbi_invalid",
    });
    expect(result.staleAt).toEqual(NOW);
  });

  it("maps a transport failure to error, stale immediately, with a PHI-free reason", async () => {
    const { port } = harness({
      transport: {
        kind: "core_mime",
        exchange: async () => {
          throw new HetsTransportError("HETS_TIMEOUT", "HETS request timed out");
        },
      },
    });
    const result = await port.check(INPUT);
    expect(result).toMatchObject({
      outcome: "error",
      reason: "HETS_TIMEOUT",
      transport: "core_mime",
    });
    expect(result.staleAt).toEqual(NOW);
  });

  it("maps a 999 rejection to error and a non-X12 reply to indeterminate", async () => {
    const reject = await harness({ subscriber: identity("REJECT999") }).port.check(INPUT);
    expect(reject).toMatchObject({ outcome: "error", reason: "hets_999_hets_error" });
    const junk = await harness({
      transport: { kind: "core_mime", exchange: async () => ({ x12: "<html>oops</html>" }) },
    }).port.check(INPUT);
    expect(junk).toMatchObject({ outcome: "indeterminate", reason: "response_not_x12" });
  });

  it("stays MBI-free when an upstream echoes the MBI into an unexpected 271 element", async () => {
    const sandbox = createSandboxHetsTransport();
    const { port } = harness({
      transport: {
        kind: "core_mime",
        // A buggy upstream that echoes the MBI as the TRN trace number (which the parser reads).
        exchange: async (req) => {
          const res = await sandbox.exchange(req);
          return { x12: res.x12.replace(/TRN\*2\*[^*~]+/, `TRN*2*${MBI}`) };
        },
      },
    });
    // The parsed trace number never reaches the port result (the correlation id is our own), so it stays clean.
    const result = await port.check(INPUT);
    expect(result.outcome).toBe("active_part_a");
    expect(JSON.stringify(result)).not.toContain(MBI);
  });

  it("returns error when the provider entity cannot be resolved (no 2100B NPI)", async () => {
    const { port, sent } = harness({ provider: null });
    expect(await port.check(INPUT)).toMatchObject({
      outcome: "error",
      reason: "provider_entity_not_found",
    });
    expect(sent).toHaveLength(0);
  });
});

describe("m23HetsConfigFromEnv", () => {
  it("is null (UNBOUND) when M23_HETS_TRANSPORT is unset", () => {
    expect(m23HetsConfigFromEnv({})).toBeNull();
  });

  it("binds the sandbox outside production and refuses it in production", () => {
    expect(m23HetsConfigFromEnv({ M23_HETS_TRANSPORT: "sandbox" })).toMatchObject({
      transport: "sandbox",
      usage: "T",
    });
    expect(() =>
      m23HetsConfigFromEnv({ M23_HETS_TRANSPORT: "sandbox", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);
    expect(() =>
      m23HetsConfigFromEnv({ M23_HETS_TRANSPORT: "sandbox", M23_HETS_SANDBOX_SCENARIO: "nope" }),
    ).toThrow();
  });

  it("requires an https endpoint, a submitter id and a credential for core_mime", () => {
    const env = {
      M23_HETS_TRANSPORT: "core_mime",
      M23_HETS_ENDPOINT_URL: "https://hets.example.test/core",
      M23_HETS_SUBMITTER_ID: "A123456",
      M23_HETS_AUTH_TOKEN: "token",
    };
    expect(m23HetsConfigFromEnv(env)).toMatchObject({
      transport: "core_mime",
      usage: "P",
      timeoutMs: 60_000,
      bearerToken: "token",
    });
    expect(() => m23HetsConfigFromEnv({ ...env, M23_HETS_ENDPOINT_URL: "http://x" })).toThrow();
    expect(() => m23HetsConfigFromEnv({ ...env, M23_HETS_SUBMITTER_ID: "" })).toThrow();
    expect(() => m23HetsConfigFromEnv({ ...env, M23_HETS_AUTH_TOKEN: "" })).toThrow(/needs/);
    expect(() => m23HetsConfigFromEnv({ ...env, M23_HETS_TRANSPORT: "soap" })).toThrow();
  });

  it("reads the mutual-TLS client certificate files for direct CMS connectivity", () => {
    const files: Record<string, string> = { "/c.pem": "CERT", "/k.pem": "KEY" };
    const cfg = m23HetsConfigFromEnv(
      {
        M23_HETS_TRANSPORT: "core_mime",
        M23_HETS_ENDPOINT_URL: "https://hets.example.test/core",
        M23_HETS_SUBMITTER_ID: "A123456",
        M23_HETS_CLIENT_CERT_FILE: "/c.pem",
        M23_HETS_CLIENT_KEY_FILE: "/k.pem",
      },
      (path) => files[path] ?? "",
    );
    expect(cfg).toMatchObject({ clientCertificate: { certPem: "CERT", keyPem: "KEY" } });
  });
});
