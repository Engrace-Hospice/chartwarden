import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import {
  CLEARINGHOUSE_CONFORMANCE_CASES,
  type ClearinghouseHarness,
  type ConformanceCapability,
  type ConformanceScript,
  DEFAULT_SCOPE,
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
  controlNumber: string = variant,
): string {
  const id = variant.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || "V";
  return BASE_X12[kind]
    .replace(/^(ISA(?:\*[^*]*){12}\*)[^*]*/, `$1${controlNumber}`)
    .replace(/(BHT\*0019\*00\*)[^*]+/, `$1${id}`)
    .replace(/(\*00501\*[^*]+\*\d\*)[TP](\*)/, `$1${usage === "test" ? "T" : "P"}$2`);
}

function unsupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the Stedi harness does not script ${name}`));
}

function createStediHarness(): ClearinghouseHarness {
  let outage = false;
  let clock = new Date("2026-10-11T10:00:00.000Z");
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
      // Recovery takes longer than the transport's settle delay after an ambiguous failure.
      if (!down) clock = new Date(clock.getTime() + 120_000);
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
      now: () => clock,
    }),
    script,
    capabilities: new Set<ConformanceCapability>(["submit"]),
    payloads: {
      x12: stediX12,
      jsonDocuments: () => [
        { usageIndicator: "T", billing: { npi: "1234567893" }, x: { c: 2, d: 3 }, y: 1 },
        { y: 1, x: { d: 3, c: 2 }, billing: { npi: "1234567893" }, usageIndicator: "T" },
      ],
    },
  };
}

describe("StediTransport against the shared conformance suite (submit side)", () => {
  it("passes every case it implements and skips the rest by name", async () => {
    const outcomes = await runConformance(async () => createStediHarness());
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    const passed = outcomes.filter((o) => o.status === "passed").map((o) => o.id);
    // Pinned exactly: a capability tag that drifts moves a case between these lists and fails here.
    expect(passed).toEqual([
      "C03-notice-kind-routing",
      "C04-idempotent-submission",
      "C18-idempotency-identity",
      "S01-submit-outage-fails-closed",
      "S02-submit-tenant-and-mode-isolation",
    ]);
    const skipped = outcomes.filter((o) => o.status === "skipped").map((o) => o.id);
    expect(skipped).toEqual(
      CLEARINGHOUSE_CONFORMANCE_CASES.map((c) => c.id).filter((id) => !passed.includes(id)),
    );
    expect(skipped).toHaveLength(15);
  });

  it("answers every unimplemented method with a degraded envelope during an outage, never a throw", async () => {
    const h = createStediHarness();
    await h.script.setOutage(true);
    const ctx = { ...DEFAULT_SCOPE, payerId: "payer", correlationId: "corr" };
    const results = await Promise.all([
      h.transport.fetchAcknowledgments(ctx, null),
      h.transport.fetchRemittances(ctx, null),
      h.transport.fetchClaimStatus(ctx, "CCN-1"),
      h.transport.verifyAndParseEvent({ headers: {}, body: "{}" } as never),
    ]);
    for (const r of results) expect(r.ok).toBe(false);
  });
});
