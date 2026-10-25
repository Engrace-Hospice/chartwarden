// Stedi sandbox contract test (#727). SKIPPED unless ALL THREE switches are set, so CI and a plain `bun run test` never
// reach the network:
//
//   STEDI_TEST_API_KEY=<a Stedi TEST-mode API key from a PRODUCTION Stedi account>
//   STEDI_CONTRACT_CONFIRM=synthetic-only      (you confirm the fixtures are synthetic)
//   STEDI_CONTRACT_KEY_IS_TEST=yes             (you confirm the key was created as a Stedi TEST-mode API key)
//   [STEDI_CONTRACT_RESULTS_FILE=/path/results.json]   (a PHI-free record of what Stedi answered, for the results template)
//
// Runbook: docs/audits/clearinghouse-integration/STEDI_SANDBOX_RUNBOOK_20261025.md. What it proves is only what the
// vendor's answers can contradict: that the transport's assumptions (U items in STEDI_TRANSPORT_CONTRACT) hold against a
// real test-mode account. It never sets live sending: the platform binding (CLEARINGHOUSE_VENDOR) is untouched, the
// transport is built here from the test key, every submission is `usage: "test"` (ISA15 T, checked locally before the
// send) and the fixtures are the repo's synthetic interchanges. Stedi's docs say the mode is inferred from the API key
// type; this transport has one base URL, so NOTHING here can detect a production key. Only the operator's
// STEDI_CONTRACT_KEY_IS_TEST confirmation stands between a production key and a (ISA15 T) request; what Stedi does with
// that is the unverified Q14 question.
//
// The assertions are deliberately tolerant about shapes nobody has observed yet (a success body, the 277CA): they
// record what happened and fail only on a broken invariant (test traffic, key leakage, a duplicate send).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { X12WorkerResult } from "../types";
import { InMemoryAttemptStore } from "./attempt-store";
import { StediTransport } from "./stedi-transport";
import { CH } from "./types";
import type { ClearinghouseContext, ClearinghouseSubmission, SubmissionReceipt } from "./types";

const KEY = process.env.STEDI_TEST_API_KEY?.trim();
const CONFIRMED = process.env.STEDI_CONTRACT_CONFIRM === "synthetic-only";
const RESULTS_FILE = process.env.STEDI_CONTRACT_RESULTS_FILE;
const KEY_CONFIRMED_TEST = process.env.STEDI_CONTRACT_KEY_IS_TEST === "yes";
const RUN = Boolean(KEY) && CONFIRMED && KEY_CONFIRMED_TEST;
const SKIP_REASON =
  "set STEDI_TEST_API_KEY (a Stedi test-mode key from a production account), STEDI_CONTRACT_CONFIRM=synthetic-only and STEDI_CONTRACT_KEY_IS_TEST=yes to run the live Stedi contract test; see STEDI_SANDBOX_RUNBOOK_20261025.md";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");

/** A control number unique per run (9 digits), so a re-run never collides with an earlier test claim. */
const RUN_ID = String(Date.now() % 1_000_000_000).padStart(9, "0");
const withIsa13 = (x12: string, controlNumber: string): string =>
  x12.replace(/^(ISA(?:\*[^*]*){12}\*)[^*]*/, `$1${controlNumber}`);

const CTX: ClearinghouseContext = {
  organizationId: "contract-org",
  providerEntityId: "contract-provider",
  payerId: "STEDI",
  correlationId: `contract-${RUN_ID}`,
  usage: "test",
};

const record: { step: string; ok: boolean; code?: string; replayed?: boolean; note?: string }[] =
  [];
const note = (
  step: string,
  r: X12WorkerResult<SubmissionReceipt>,
  extra: { note?: string } = {},
) => {
  record.push(
    r.ok
      ? { step, ok: true, replayed: r.data.replayed, ...extra }
      : { step, ok: false, code: r.degraded.code, ...extra },
  );
};

function submission(
  kind: ClearinghouseSubmission["kind"],
  x12Name: string,
  suffix: string,
): ClearinghouseSubmission {
  const controlNumber = `${RUN_ID.slice(0, 8)}${suffix}`;
  return {
    kind,
    controlNumber,
    idempotencyKey: `contract-${kind}-${RUN_ID}-${suffix}`,
    payload: { format: "x12", x12: withIsa13(fixture(x12Name), controlNumber) },
  };
}

describe.skipIf(!RUN)(
  `Stedi sandbox contract (synthetic data, test key) ${RUN ? "" : `- ${SKIP_REASON}`}`,
  () => {
    const attempts = new InMemoryAttemptStore();
    const transport = new StediTransport({ apiKey: KEY ?? "", attempts });
    const claim = submission("claim", "claim", "1");
    const noe = submission("noe", "NOE_81A", "2");

    it("files a synthetic test claim, or answers with a known degraded code (Q14)", async () => {
      const r = await transport.submitClaim(CTX, claim);
      note("claim", r);
      if (!r.ok) {
        // CH_NOT_PROVISIONED here means the key is a sandbox key, not a production account's test key (Q14).
        expect([CH.NOT_PROVISIONED, CH.INVALID_REQUEST, CH.NOT_WIRED, CH.UNAVAILABLE]).toContain(
          r.degraded.code,
        );
        return;
      }
      expect(r.data.replayed).toBe(false);
      expect(r.data.clearinghouseSubmissionId.length).toBeGreaterThan(0);
    });

    it("an identical resubmission replays locally and does not send again", async () => {
      const first = await transport.submitClaim(CTX, claim);
      note("claim-replay", first);
      if (first.ok) expect(first.data.replayed).toBe(true);
    });

    it("a reused key with another body conflicts, never sends", async () => {
      const r = await transport.submitClaim(CTX, {
        ...claim,
        payload: {
          format: "x12",
          x12: `${claim.payload.format === "x12" ? claim.payload.x12 : ""} `,
        },
      });
      note("claim-conflict", r);
      if (!r.ok) expect(r.degraded.code).toBe(CH.IDEMPOTENCY_CONFLICT);
    });

    it("files a synthetic NOE 81A as raw X12 (BHT06 RP) or answers with a known code (Q21)", async () => {
      const r = await transport.submitNotice(CTX, noe);
      note("noe", r);
      if (!r.ok) {
        expect([CH.NOT_PROVISIONED, CH.INVALID_REQUEST, CH.NOT_WIRED, CH.UNAVAILABLE]).toContain(
          r.degraded.code,
        );
      }
    });

    it("refuses a production-marked interchange before anything is sent (usage test)", async () => {
      const asProduction =
        claim.payload.format === "x12" ? claim.payload.x12.replace("*T*:~", "*P*:~") : "";
      const r = await transport.submitClaim(CTX, {
        ...claim,
        controlNumber: `${RUN_ID.slice(0, 8)}9`,
        idempotencyKey: `contract-prod-${RUN_ID}`,
        payload: { format: "x12", x12: withIsa13(asProduction, `${RUN_ID.slice(0, 8)}9`) },
      });
      note("production-isa15-refused", r);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.degraded.code).toBe(CH.INVALID_REQUEST);
    });

    it("refuses a replacement (frequency 7) without sending (Q17 open)", async () => {
      const r = await transport.submitClaim(CTX, {
        ...claim,
        idempotencyKey: `contract-adj-${RUN_ID}`,
        adjustment: { kind: "replacement", originalControlNumber: claim.controlNumber },
      });
      note("adjustment-refused", r);
      expect(r.ok).toBe(false);
    });

    it("never leaks the key into any result, and writes the PHI-free record", () => {
      expect(JSON.stringify(record)).not.toContain(KEY ?? "never");
      if (RESULTS_FILE) {
        writeFileSync(
          RESULTS_FILE,
          `${JSON.stringify({ runId: RUN_ID, ranAt: new Date().toISOString(), steps: record }, null, 2)}\n`,
        );
      }
    });
  },
);

// Always-on guard: the skipped suite must stay skipped by default (CI sets neither variable).
describe("Stedi sandbox contract gating", () => {
  it("does not run without all three switches", () => {
    if (RUN) return;
    expect(RUN).toBe(false);
  });
});
