import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import {
  CLEARINGHOUSE_CONFORMANCE_CASES,
  type ClearinghouseHarness,
  type ConformanceCapability,
  type ConformanceScript,
  runConformance,
} from "./conformance";
import { StediTransport } from "./stedi-transport";

// The Stedi adapter against the shared conformance suite, on the capabilities it implements (the submit side). The
// receive side (acks, 277CA, status, signed events, remittances), eligibility, dry-run validation, adjustments and
// enrollment are declared absent, so their cases are SKIPPED BY NAME below rather than silently passed; they must
// appear here as the adapter grows.

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");
const BASE_X12 = { claim: fixture("claim"), noe: fixture("NOE_81A"), notr: fixture("NOTR_81B") };

/** A valid interchange per kind whose only difference between variants is the BHT03 originator transaction id. */
function stediX12(
  kind: "claim" | "noe" | "notr",
  variant: string,
  usage: "test" | "production" = "test",
): string {
  const id = variant.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || "V";
  return BASE_X12[kind]
    .replace(/(BHT\*0019\*00\*)[^*]+/, `$1${id}`)
    .replace(/(\*00501\*\d+\*\d\*)[TP](\*)/, `$1${usage === "test" ? "T" : "P"}$2`);
}

function unsupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the Stedi harness does not script ${name}`));
}

function createStediHarness(): ClearinghouseHarness {
  let outage = false;
  let n = 0;
  const fetchImpl = (async () =>
    outage
      ? new Response("{}", { status: 503 })
      : Response.json({
          status: "SUCCESS",
          claimReference: { correlationId: `corr-${++n}` },
        })) as typeof fetch;
  const script: ConformanceScript = {
    setOutage: async (down) => {
      outage = down;
    },
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
    transport: new StediTransport({
      apiKey: "test_key_do_not_leak",
      attempts: new InMemoryAttemptStore(),
      fetch: fetchImpl,
    }),
    script,
    capabilities: new Set<ConformanceCapability>(["submit"]),
    payloads: {
      x12: stediX12,
      jsonDocuments: () => [
        { usageIndicator: "T", x: { c: 2, d: 3 }, y: 1 },
        { y: 1, x: { d: 3, c: 2 }, usageIndicator: "T" },
      ],
    },
  };
}

describe("StediTransport against the shared conformance suite (submit side)", () => {
  it("passes every case it implements and skips the rest by name", async () => {
    const outcomes = await runConformance(async () => createStediHarness());
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    const passed = outcomes.filter((o) => o.status === "passed").map((o) => o.id);
    // Guards against a harness that quietly runs nothing.
    expect(passed).toEqual(
      expect.arrayContaining([
        "C03-notice-kind-routing",
        "C04-idempotent-submission",
        "C18-idempotency-identity",
        "S01-submit-outage-fails-closed",
        "S02-submit-tenant-and-mode-isolation",
      ]),
    );
    const skipped = outcomes.filter((o) => o.status === "skipped").map((o) => o.id);
    expect(skipped.length + passed.length).toBe(CLEARINGHOUSE_CONFORMANCE_CASES.length);
    expect(skipped).toEqual(
      expect.arrayContaining([
        "C01-eligibility-outcome-only",
        "C02-validate-only-has-no-side-effects",
        "C05-clearinghouse-rejection",
        "C10-remittance",
        "C11-push-events",
      ]),
    );
  });
});
