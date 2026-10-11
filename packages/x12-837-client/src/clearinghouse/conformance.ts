// @wardenx/x12-837-client — the ClearinghouseTransport CONFORMANCE cases (ADR-0053 D4).
//
// Framework-free on purpose: a case is `{ id, stage, title, run(harness) }` and fails by throwing, so the same
// list runs under vitest (see conformance.test.ts), in a live-sandbox smoke script, or in a CI job, and this
// source file never imports a test runner. An adapter is "done" only when EVERY case passes against it; the
// in-memory reference transport is the executable specification.
//
// An adapter's test supplies a {@link ClearinghouseHarness}: the transport under test plus a
// {@link ConformanceScript} that drives the far side (a stubbed HTTP server for a real vendor, in-process state
// for the reference). The cases assert behaviour, never wire format. Stages refer to the 16-stage table in
// docs/audits/clearinghouse-integration/ADAPTER_EXPANSION_PLAN_20261011.md §2.
import type { X12WorkerResult } from "../types";
import {
  type AckEvent,
  CH,
  type ClearinghouseContext,
  type ClearinghouseEventKind,
  type ClearinghouseScope,
  type ClearinghouseSubmission,
  type ClearinghouseTransport,
  type Page,
  RETRYABLE_CODES,
  type RawWebhook,
} from "./types";

/** The scope every case uses unless it names another. */
export const DEFAULT_SCOPE: ClearinghouseScope = {
  organizationId: "org-conf",
  providerEntityId: "pe-conf",
  usage: "test",
  // A synthetic, Luhn-valid NPI; a transport that reads the billing provider out of the payload checks it against this.
  billingNpi: "1234567893",
};

/**
 * Drives the far side of the transport. Every method resolves once the state is in place. `scope` selects whose
 * state is changed (default {@link DEFAULT_SCOPE}); isolation cases use it to act for another tenant or mode.
 */
export interface ConformanceScript {
  clearinghouseAccepts(controlNumber: string, scope?: ClearinghouseScope): Promise<void>;
  clearinghouseRejects(
    controlNumber: string,
    reasonCodes: readonly string[],
    scope?: ClearinghouseScope,
  ): Promise<void>;
  payerAccepts(
    controlNumber: string,
    payerClaimNumber: string,
    scope?: ClearinghouseScope,
  ): Promise<void>;
  payerRejects(
    controlNumber: string,
    reasonCodes: readonly string[],
    scope?: ClearinghouseScope,
  ): Promise<void>;
  deliverRemittance(
    remittanceId: string,
    rawX12: string,
    scope?: ClearinghouseScope,
  ): Promise<void>;
  /** false = this provider is not enrolled with the payer for any transaction. */
  setEnrollment(enrolled: boolean, scope?: ClearinghouseScope): Promise<void>;
  /** true = the vendor is unreachable / the breaker is open (platform-wide). */
  setOutage(down: boolean): Promise<void>;
  /** A correctly signed push. */
  signedEvent(
    kind: ClearinghouseEventKind,
    reference: string,
    eventId: string,
  ): Promise<RawWebhook>;
  /** The same push with an invalid signature. */
  tamperedEvent(
    kind: ClearinghouseEventKind,
    reference: string,
    eventId: string,
  ): Promise<RawWebhook>;
}

/**
 * What a transport can honestly answer. A case lists what it `requires`; a harness that does not declare a capability
 * has that case SKIPPED BY NAME (never silently passed), so an adapter is judged on everything it implements and the
 * rest stays visible as a to-do. The reference transport declares them all.
 */
export type ConformanceCapability =
  | "submit" // submitClaim / submitNotice
  | "validate" // validateOnly
  | "eligibility" // checkEligibility
  | "receive" // acknowledgments, remittances, claim status, signed events
  | "adjustment" // replacement / void claims
  | "enrollment"; // a provider-not-enrolled outcome

export const ALL_CONFORMANCE_CAPABILITIES: ReadonlySet<ConformanceCapability> = new Set([
  "submit",
  "validate",
  "eligibility",
  "receive",
  "adjustment",
  "enrollment",
]);

/**
 * Payloads the transport under test will accept. The default is a synthetic string the in-memory reference takes; a
 * vendor adapter supplies VALID documents (its preflight checks real X12 / JSON). `variant` is any short string: two
 * variants must produce different payloads, one variant the same payload.
 */
export interface ConformancePayloads {
  x12(
    kind: ClearinghouseSubmission["kind"],
    variant: string,
    usage?: ClearinghouseScope["usage"],
    /** The submission's control number; a transport that binds it to the interchange (ISA13) needs it. Defaults to `variant`. */
    controlNumber?: string,
  ): string;
  /** Two key-order permutations of one JSON claim document that the transport accepts. */
  jsonDocuments?(): readonly [Record<string, unknown>, Record<string, unknown>];
}

export interface ClearinghouseHarness {
  readonly transport: ClearinghouseTransport;
  readonly script: ConformanceScript;
  /** Defaults to every capability. */
  readonly capabilities?: ReadonlySet<ConformanceCapability>;
  readonly payloads?: ConformancePayloads;
}

/** Builds a fresh, empty harness. Called once per case so cases never share state. */
export type HarnessFactory = () => Promise<ClearinghouseHarness>;

export interface ConformanceCase {
  readonly id: string;
  /** The claim-cycle stage(s) this case guards (plan §2). */
  readonly stage: string;
  readonly title: string;
  /** Capabilities the transport must declare for this case to apply. */
  readonly requires: readonly ConformanceCapability[];
  run(harness: ClearinghouseHarness): Promise<void>;
}

// ─── Fixtures (synthetic) ───────────────────────────────────────────────────────────────────────

/** A fake MBI-shaped string. The suite proves it never escapes the eligibility call. */
export const SYNTHETIC_MBI = "1EG4-TE5-MK73";

const OTHER_ORG: ClearinghouseScope = { ...DEFAULT_SCOPE, organizationId: "org-other" };
const OTHER_PROVIDER: ClearinghouseScope = { ...DEFAULT_SCOPE, providerEntityId: "pe-other" };
const PRODUCTION: ClearinghouseScope = { ...DEFAULT_SCOPE, usage: "production" };

function ctxFor(scope: ClearinghouseScope = DEFAULT_SCOPE): ClearinghouseContext {
  return { ...scope, payerId: "payer-conf", correlationId: "corr-conf" };
}

const DEFAULT_PAYLOADS: ConformancePayloads = {
  x12: (_kind, variant) => `ST*837*${variant}~SE*1*${variant}~`,
};

function supports(h: ClearinghouseHarness, cap: ConformanceCapability): boolean {
  return (h.capabilities ?? ALL_CONFORMANCE_CAPABILITIES).has(cap);
}

/** Builds submissions whose payloads the harness's transport accepts. */
function submissionFor(h: ClearinghouseHarness) {
  const payloads = h.payloads ?? DEFAULT_PAYLOADS;
  return (
    kind: ClearinghouseSubmission["kind"],
    controlNumber: string,
    overrides: Partial<ClearinghouseSubmission> = {},
  ): ClearinghouseSubmission => ({
    kind,
    controlNumber,
    idempotencyKey: `idem-${controlNumber}`,
    payload: { format: "x12", x12: payloads.x12(kind, controlNumber) },
    ...overrides,
  });
}

// ─── Assertion helpers ──────────────────────────────────────────────────────────────────────────

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`);
}

function ok<T>(result: X12WorkerResult<T>, what: string): T {
  if (!result.ok) {
    throw new Error(`conformance: ${what} expected ok, got degraded ${result.degraded.code}`);
  }
  return result.data;
}

function degradedCode<T>(result: X12WorkerResult<T>, what: string): string {
  if (result.ok) throw new Error(`conformance: ${what} expected degraded, got ok`);
  return result.degraded.code;
}

/** True if `text` contains the MBI in any common reformatting (case, separators). */
function leaksMbi(text: string): boolean {
  const squash = (v: string): string => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  return squash(text).includes(squash(SYNTHETIC_MBI));
}

async function submitClaimOk(
  h: ClearinghouseHarness,
  controlNumber: string,
  scope: ClearinghouseScope = DEFAULT_SCOPE,
  overrides: Partial<ClearinghouseSubmission> = {},
): Promise<void> {
  ok(
    await h.transport.submitClaim(
      ctxFor(scope),
      submissionFor(h)("claim", controlNumber, overrides),
    ),
    `submitClaim ${controlNumber}`,
  );
}

async function allAcks(
  h: ClearinghouseHarness,
  scope: ClearinghouseScope = DEFAULT_SCOPE,
): Promise<readonly AckEvent[]> {
  const out: AckEvent[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const p: Page<AckEvent> = ok(
      await h.transport.fetchAcknowledgments(ctxFor(scope), cursor),
      "fetchAcknowledgments",
    );
    out.push(...p.items);
    if (!p.hasMore) return out;
    cursor = p.nextCursor;
  }
  throw new Error("conformance: fetchAcknowledgments never reported hasMore=false");
}

const ELIGIBILITY_REQUEST = { mbi: SYNTHETIC_MBI, serviceDate: "2026-10-01" } as const;

// ─── The cases ──────────────────────────────────────────────────────────────────────────────────

export const CLEARINGHOUSE_CONFORMANCE_CASES: readonly ConformanceCase[] = [
  {
    id: "C01-eligibility-outcome-only",
    requires: ["eligibility"],
    stage: "1 eligibility",
    title: "returns an outcome and as-of date, and the MBI appears nowhere in the result",
    async run(h) {
      const r = ok(
        await h.transport.checkEligibility(ctxFor(), ELIGIBILITY_REQUEST),
        "checkEligibility",
      );
      check(["active", "inactive", "unknown"].includes(r.outcome), "outcome is a known value");
      check(r.asOfDate.length > 0, "asOfDate present");
      check(!leaksMbi(JSON.stringify(r)), "result must not contain the MBI (in any formatting)");
    },
  },
  {
    id: "C02-validate-only-has-no-side-effects",
    requires: ["validate"],
    stage: "2 validation",
    title:
      "a dry-run reports issues, creates no submission and does not consume the idempotency key",
    async run(h) {
      const sub = submissionFor(h);
      const bad = sub("claim", "CCN-0002", { payload: { format: "x12", x12: "" } });
      const report = ok(await h.transport.validateOnly(ctxFor(), bad), "validateOnly(bad)");
      check(!report.valid, "an empty payload is invalid");
      check(
        report.issues.some((i) => i.severity === "error"),
        "an invalid report carries an error issue",
      );
      check(!leaksMbi(JSON.stringify(report)), "a validation report is PHI-free");
      const good = sub("claim", "CCN-0002");
      const goodReport = ok(await h.transport.validateOnly(ctxFor(), good), "validateOnly(good)");
      check(goodReport.valid, "a well-formed payload validates");
      const status = ok(
        await h.transport.fetchClaimStatus(ctxFor(), "CCN-0002"),
        "fetchClaimStatus",
      );
      check(status.state === "not_found", "validateOnly must not create a submission");
      const receipt = ok(
        await h.transport.submitClaim(ctxFor(), good),
        "submitClaim after dry-run",
      );
      check(!receipt.replayed, "the dry-run must not have consumed the idempotency key");
    },
  },
  {
    id: "C03-notice-kind-routing",
    requires: ["submit"],
    stage: "3 NOE / 14 NOTR",
    title:
      "submitNotice accepts noe and notr and refuses a claim or an adjustment; submitClaim refuses a notice",
    async run(h) {
      const sub = submissionFor(h);
      const noe = ok(await h.transport.submitNotice(ctxFor(), sub("noe", "NOE-0003")), "noe");
      const notr = ok(await h.transport.submitNotice(ctxFor(), sub("notr", "NTR-0003")), "notr");
      check(
        noe.clearinghouseSubmissionId !== notr.clearinghouseSubmissionId,
        "distinct submissions",
      );
      const noticeAsClaim = await h.transport.submitNotice(ctxFor(), sub("claim", "CCN-0003"));
      check(
        degradedCode(noticeAsClaim, "submitNotice(claim)") === CH.INVALID_REQUEST,
        "submitNotice refuses kind=claim",
      );
      const claimAsNotice = await h.transport.submitClaim(ctxFor(), sub("noe", "NOE-0003b"));
      check(
        degradedCode(claimAsNotice, "submitClaim(noe)") === CH.INVALID_REQUEST,
        "submitClaim refuses kind=noe",
      );
      const adjustedNotice = await h.transport.submitNotice(
        ctxFor(),
        sub("noe", "NOE-0003c", {
          adjustment: { kind: "void", originalControlNumber: "NOE-0003" },
        }),
      );
      check(
        degradedCode(adjustedNotice, "notice with adjustment") === CH.INVALID_REQUEST,
        "a notice cannot carry a claim adjustment",
      );
    },
  },
  {
    id: "C04-idempotent-submission",
    requires: ["submit"],
    stage: "4 claim",
    title:
      "the same key + payload replays the receipt; the same key + a different payload conflicts",
    async run(h) {
      const sub = submissionFor(h);
      const s = sub("claim", "CCN-0004");
      const first = ok(await h.transport.submitClaim(ctxFor(), s), "first");
      const second = ok(await h.transport.submitClaim(ctxFor(), s), "second");
      check(!first.replayed && second.replayed, "second send is flagged as a replay");
      check(
        first.clearinghouseSubmissionId === second.clearinghouseSubmissionId,
        "a replay returns the original submission id",
      );
      const changed = sub("claim", "CCN-0004", {
        payload: {
          format: "x12",
          x12: (h.payloads ?? DEFAULT_PAYLOADS).x12("claim", "CHANGED", "test", "CCN-0004"),
        },
      });
      const conflict = await h.transport.submitClaim(ctxFor(), changed);
      check(
        degradedCode(conflict, "changed payload") === CH.IDEMPOTENCY_CONFLICT,
        "a changed payload under the same key is a conflict",
      );
      check(
        !RETRYABLE_CODES.has(CH.IDEMPOTENCY_CONFLICT),
        "an idempotency conflict is never retryable",
      );
    },
  },
  {
    id: "C05-clearinghouse-rejection",
    requires: ["submit", "receive"],
    stage: "5-6 acknowledgment",
    title:
      "a clearinghouse rejection is a clearinghouse-stage event and the claim never reaches the payer",
    async run(h) {
      await submitClaimOk(h, "CCN-0005");
      await h.script.clearinghouseRejects("CCN-0005", ["EDIT-CL102"]);
      const acks = (await allAcks(h)).filter((a) => a.controlNumber === "CCN-0005");
      check(acks.length === 1, "exactly one ack");
      const a = acks[0];
      check(
        a !== undefined && a.stage === "clearinghouse" && a.disposition === "rejected",
        "stage=clearinghouse, rejected",
      );
      check(a.reasonCodes.includes("EDIT-CL102"), "reason codes are carried");
      const status = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0005"), "status");
      check(status.state === "clearinghouse_rejected", "status reflects the rejection");
      check(
        !(await allAcks(h)).some((x) => x.stage === "payer"),
        "no payer-stage event exists for a claim the clearinghouse rejected",
      );
    },
  },
  {
    id: "C06-two-stage-acceptance",
    requires: ["submit", "receive"],
    stage: "5-6 acknowledgment",
    title:
      "clearinghouse-accepted is not payer-accepted; both stages are distinct, uniquely identified events",
    async run(h) {
      await submitClaimOk(h, "CCN-0006");
      await h.script.clearinghouseAccepts("CCN-0006");
      const mid = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0006"), "status mid");
      check(
        mid.state === "clearinghouse_accepted",
        "after the vendor accepts, the state is clearinghouse_accepted",
      );
      await h.script.payerAccepts("CCN-0006", "ICN-9006");
      const done = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0006"), "status done");
      check(
        done.state === "payer_accepted",
        "after the payer accepts, the state is payer_accepted",
      );
      check(done.latest?.payerClaimNumber === "ICN-9006", "the payer claim number is surfaced");
      const acks = (await allAcks(h)).filter((a) => a.controlNumber === "CCN-0006");
      check(acks.length === 2, "two acknowledgments");
      check(
        acks.some((a) => a.stage === "clearinghouse") && acks.some((a) => a.stage === "payer"),
        "one event per stage",
      );
      check(new Set(acks.map((a) => a.eventId)).size === 2, "event ids are unique");
    },
  },
  {
    id: "C07-payer-rejection",
    requires: ["submit", "receive"],
    stage: "6-7 rejection",
    title: "a payer rejection is a payer-stage event with its reason codes",
    async run(h) {
      await submitClaimOk(h, "CCN-0007");
      await h.script.clearinghouseAccepts("CCN-0007");
      await h.script.payerRejects("CCN-0007", ["A7:562"]);
      const status = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0007"), "status");
      check(status.state === "payer_rejected", "state is payer_rejected");
      check(
        status.latest?.reasonCodes.includes("A7:562") === true,
        "payer reason codes are carried",
      );
    },
  },
  {
    id: "C08-ack-paging",
    requires: ["submit", "receive"],
    stage: "5-6 acknowledgment",
    title: "cursor paging neither repeats nor skips events, and a restart from null is stable",
    async run(h) {
      for (const n of ["CCN-0081", "CCN-0082", "CCN-0083", "CCN-0084"]) {
        await submitClaimOk(h, n);
        await h.script.clearinghouseAccepts(n);
      }
      const first = ok(await h.transport.fetchAcknowledgments(ctxFor(), null), "page 1");
      check(first.items.length >= 1, "first page has items");
      const ids = (await allAcks(h)).map((a) => a.eventId);
      check(new Set(ids).size === ids.length, "no event is delivered twice across pages");
      check(ids.length === 4, "all four acknowledgments arrive");
      const again = (await allAcks(h)).map((a) => a.eventId);
      check(
        JSON.stringify(again) === JSON.stringify(ids),
        "restarting from a null cursor yields the same ordered ids",
      );
    },
  },
  {
    id: "C09-adjustment",
    requires: ["submit", "adjustment", "receive"],
    stage: "8 replacement / 9 void",
    title:
      "a replacement or void must name an original the clearinghouse has seen, and a refusal burns nothing",
    async run(h) {
      const sub = submissionFor(h);
      const unknown = sub("claim", "CCN-0009R", {
        adjustment: { kind: "replacement", originalControlNumber: "CCN-0009" },
      });
      const refused = await h.transport.submitClaim(ctxFor(), unknown);
      check(
        degradedCode(refused, "unknown original") === CH.UNKNOWN_ORIGINAL,
        "an unknown original is refused",
      );
      await submitClaimOk(h, "CCN-0009");
      const replacement = ok(await h.transport.submitClaim(ctxFor(), unknown), "replacement");
      check(!replacement.replayed, "the refused attempt did not consume its idempotency key");
      const voided = ok(
        await h.transport.submitClaim(
          ctxFor(),
          sub("claim", "CCN-0009V", {
            adjustment: { kind: "void", originalControlNumber: "CCN-0009" },
          }),
        ),
        "void",
      );
      check(
        replacement.clearinghouseSubmissionId !== voided.clearinghouseSubmissionId,
        "distinct submissions",
      );
    },
  },
  {
    id: "C10-remittance",
    requires: ["submit", "receive"],
    stage: "10 remittance",
    title: "an 835 is delivered once, with its raw X12 intact, even if the far side repeats it",
    async run(h) {
      const raw = "ST*835*0001~BPR*I*0~SE*2*0001~";
      await h.script.deliverRemittance("ERA-0010", raw);
      await h.script.deliverRemittance("ERA-0010", raw);
      const first = ok(await h.transport.fetchRemittances(ctxFor(), null), "page 1");
      check(
        first.items.length === 1 && first.items[0]?.remittanceId === "ERA-0010",
        "the remittance arrives exactly once",
      );
      check(first.items[0]?.rawX12 === raw, "raw X12 is byte-for-byte");
      const rest = ok(
        await h.transport.fetchRemittances(ctxFor(), first.nextCursor),
        "after cursor",
      );
      check(rest.items.length === 0, "it is not delivered again after the cursor");
      await h.script.deliverRemittance("ERA-0010b", raw);
      const resumed = ok(await h.transport.fetchRemittances(ctxFor(), first.nextCursor), "resumed");
      check(
        resumed.items.length === 1 && resumed.items[0]?.remittanceId === "ERA-0010b",
        "a persisted cursor resumes and returns only what arrived since",
      );
    },
  },
  {
    id: "C11-push-events",
    requires: ["submit", "receive"],
    stage: "16 events",
    title:
      "a signed event reduces to references only; a tampered one is refused; duplicates share an id",
    async run(h) {
      const hook = await h.script.signedEvent("acknowledgment_available", "CCN-0011", "evt-11");
      const ev = ok(await h.transport.verifyAndParseEvent(hook), "signed");
      check(
        JSON.stringify(Object.keys(ev).sort()) ===
          JSON.stringify(["eventId", "kind", "occurredAt", "reference"]),
        "an event carries references only (eventId, kind, reference, occurredAt)",
      );
      const dup = ok(await h.transport.verifyAndParseEvent(hook), "duplicate");
      check(dup.eventId === ev.eventId, "a duplicate delivery has the same eventId");
      const bad = await h.script.tamperedEvent("acknowledgment_available", "CCN-0011", "evt-11");
      check(
        degradedCode(await h.transport.verifyAndParseEvent(bad), "tampered") ===
          CH.INVALID_SIGNATURE,
        "a tampered event is refused",
      );
    },
  },
  {
    id: "C12-not-enrolled",
    requires: ["submit", "enrollment", "eligibility", "receive"],
    stage: "all (payer enrollment)",
    title:
      "an un-enrolled provider gets a terminal CH_NOT_ENROLLED on every send, never a throw or a silent success",
    async run(h) {
      const sub = submissionFor(h);
      await h.script.setEnrollment(false);
      const claim = await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-0012"));
      check(
        degradedCode(claim, "submitClaim") === CH.NOT_ENROLLED,
        "submitClaim -> CH_NOT_ENROLLED",
      );
      const notice = await h.transport.submitNotice(ctxFor(), sub("noe", "NOE-0012"));
      check(
        degradedCode(notice, "submitNotice") === CH.NOT_ENROLLED,
        "submitNotice -> CH_NOT_ENROLLED",
      );
      const elig = await h.transport.checkEligibility(ctxFor(), ELIGIBILITY_REQUEST);
      check(
        degradedCode(elig, "checkEligibility") === CH.NOT_ENROLLED,
        "checkEligibility -> CH_NOT_ENROLLED",
      );
      check(
        !RETRYABLE_CODES.has(CH.NOT_ENROLLED),
        "not-enrolled is terminal until enrollment changes",
      );
      if (!claim.ok) check(!leaksMbi(claim.degraded.reason), "reason is PHI-free");
      const status = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0012"), "status");
      check(status.state === "not_found", "a refused submission leaves nothing behind");
      const other = await h.transport.submitClaim(
        ctxFor(OTHER_PROVIDER),
        sub("claim", "CCN-0012o"),
      );
      ok(other, "another provider that IS enrolled is unaffected");
    },
  },
  {
    id: "C13-outage-fails-closed",
    requires: ["submit", "validate", "eligibility", "receive"],
    stage: "all (resilience)",
    title:
      "during an outage every method returns a retryable degraded envelope, never throws, records nothing, and recovers",
    async run(h) {
      const sub = submissionFor(h);
      await h.script.setOutage(true);
      const t = h.transport;
      const results: ReadonlyArray<readonly [string, X12WorkerResult<unknown>]> = [
        ["checkEligibility", await t.checkEligibility(ctxFor(), ELIGIBILITY_REQUEST)],
        ["validateOnly", await t.validateOnly(ctxFor(), sub("claim", "CCN-0013"))],
        ["submitNotice", await t.submitNotice(ctxFor(), sub("noe", "NOE-0013"))],
        ["submitClaim", await t.submitClaim(ctxFor(), sub("claim", "CCN-0013"))],
        ["fetchAcknowledgments", await t.fetchAcknowledgments(ctxFor(), null)],
        ["fetchRemittances", await t.fetchRemittances(ctxFor(), null)],
        ["fetchClaimStatus", await t.fetchClaimStatus(ctxFor(), "CCN-0013")],
      ];
      for (const [name, r] of results) {
        const code = degradedCode(r, name);
        check(
          code === CH.UNAVAILABLE && RETRYABLE_CODES.has(code),
          `${name} -> retryable CH_UNAVAILABLE`,
        );
        if (!r.ok) check(!leaksMbi(r.degraded.reason), `${name} reason is PHI-free`);
      }
      await h.script.setOutage(false);
      const after = ok(
        await t.submitClaim(ctxFor(), sub("claim", "CCN-0013")),
        "submitClaim after recovery",
      );
      check(!after.replayed, "nothing was recorded while the vendor was down");
    },
  },
  {
    id: "C14-test-production-isolation",
    requires: ["submit", "receive"],
    stage: "all (usage)",
    title:
      "test-mode submissions, acknowledgments and remittances are invisible to production, and the reverse",
    async run(h) {
      const sub = submissionFor(h);
      // The SAME control number and idempotency key are used in both modes: neither table may be shared.
      await submitClaimOk(h, "CCN-0014");
      await h.script.clearinghouseAccepts("CCN-0014");
      await h.script.deliverRemittance("ERA-0014", "ST*835*0014~SE*1*0014~");
      const prodReceipt = ok(
        await h.transport.submitClaim(ctxFor(PRODUCTION), sub("claim", "CCN-0014")),
        "production submit with the same key",
      );
      check(!prodReceipt.replayed, "production must not replay a test-mode receipt");
      await h.script.clearinghouseRejects("CCN-0014", ["EDIT-PROD"], PRODUCTION);
      await h.script.deliverRemittance("ERA-0014p", "ST*835*0015~SE*1*0015~", PRODUCTION);

      const fromProd = ok(
        await h.transport.fetchClaimStatus(ctxFor(PRODUCTION), "CCN-0014"),
        "status from prod",
      );
      const fromTest = ok(
        await h.transport.fetchClaimStatus(ctxFor(), "CCN-0014"),
        "status from test",
      );
      check(
        fromProd.state === "clearinghouse_rejected" && fromTest.state === "clearinghouse_accepted",
        "each mode keeps its own state for the same control number",
      );
      const prodAcks = await allAcks(h, PRODUCTION);
      const testAcks = await allAcks(h);
      check(
        prodAcks.length === 1 && prodAcks[0]?.disposition === "rejected",
        "production sees only its own acknowledgments",
      );
      check(
        testAcks.length === 1 && testAcks[0]?.disposition === "accepted",
        "test sees only its own acknowledgments",
      );
      const prodRem = ok(await h.transport.fetchRemittances(ctxFor(PRODUCTION), null), "prod 835");
      const testRem = ok(await h.transport.fetchRemittances(ctxFor(), null), "test 835");
      check(
        prodRem.items.map((r) => r.remittanceId).join() === "ERA-0014p" &&
          testRem.items.map((r) => r.remittanceId).join() === "ERA-0014",
        "each mode sees only its own remittances",
      );
    },
  },
  {
    id: "C15-tenant-isolation",
    requires: ["submit", "receive"],
    stage: "all (tenancy)",
    title:
      "one platform credential, many tenants: another org or provider never sees, replays or collides with your state",
    async run(h) {
      const sub = submissionFor(h);
      await submitClaimOk(h, "CCN-0015");
      await h.script.clearinghouseAccepts("CCN-0015");
      await h.script.deliverRemittance("ERA-0015", "ST*835*0015~SE*1*0015~");

      for (const [label, scope] of [
        ["another org", OTHER_ORG],
        ["another provider", OTHER_PROVIDER],
      ] as const) {
        const status = ok(
          await h.transport.fetchClaimStatus(ctxFor(scope), "CCN-0015"),
          `status (${label})`,
        );
        check(status.state === "not_found", `${label} must not see the submission`);
        check((await allAcks(h, scope)).length === 0, `${label} must not see acknowledgments`);
        const rem = ok(await h.transport.fetchRemittances(ctxFor(scope), null), `835 (${label})`);
        check(rem.items.length === 0, `${label} must not see remittances`);
        // Same idempotency key + same control number, entirely independent for the other tenant.
        const theirs = ok(
          await h.transport.submitClaim(ctxFor(scope), sub("claim", "CCN-0015")),
          `submit (${label})`,
        );
        check(!theirs.replayed, `${label} must not replay your receipt`);
      }
      const mine = ok(
        await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-0015")),
        "my replay",
      );
      check(mine.replayed, "my own state is intact");
    },
  },
  {
    id: "C16-out-of-order-acks",
    requires: ["submit", "receive"],
    stage: "5-6 acknowledgment",
    title: "a late clearinghouse ack never regresses a claim the payer already answered",
    async run(h) {
      await submitClaimOk(h, "CCN-0016");
      await h.script.payerAccepts("CCN-0016", "ICN-9016");
      await h.script.clearinghouseAccepts("CCN-0016");
      const status = ok(await h.transport.fetchClaimStatus(ctxFor(), "CCN-0016"), "status");
      check(
        status.state === "payer_accepted",
        "state follows the highest stage reached, not the last event delivered",
      );
      check(status.latest?.stage === "payer", "latest is the payer acknowledgment");
    },
  },
  {
    id: "C17-cursor-validation",
    requires: ["submit", "receive"],
    stage: "5-6, 10 (polling)",
    title: "a malformed cursor is refused, never treated as the start; a stored cursor resumes",
    async run(h) {
      for (const bad of ["garbage", "-1", "2abc", "1.5"]) {
        const r = await h.transport.fetchAcknowledgments(ctxFor(), bad);
        check(
          degradedCode(r, `cursor '${bad}'`) === CH.INVALID_REQUEST,
          `cursor '${bad}' -> CH_INVALID_REQUEST (a poller must not silently reprocess everything)`,
        );
      }
      await submitClaimOk(h, "CCN-0017");
      await h.script.clearinghouseAccepts("CCN-0017");
      const end = ok(await h.transport.fetchAcknowledgments(ctxFor(), null), "drain");
      check(!end.hasMore, "drained");
      await h.script.payerAccepts("CCN-0017", "ICN-9017");
      const resumed = ok(
        await h.transport.fetchAcknowledgments(ctxFor(), end.nextCursor),
        "resume",
      );
      check(
        resumed.items.length === 1 && resumed.items[0]?.stage === "payer",
        "the persisted end-of-chain cursor returns only what arrived afterwards",
      );
    },
  },
  {
    id: "C18-idempotency-identity",
    requires: ["submit"],
    stage: "4 claim",
    title:
      "an idempotency key binds the whole submission (kind, control number, adjustment, payload), not just the payload",
    async run(h) {
      const sub = submissionFor(h);
      ok(await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-0018")), "first");
      const otherNumber = sub("claim", "CCN-0018x", { idempotencyKey: "idem-CCN-0018" });
      // Same key and the payload text is different only through the control number; make the payload identical.
      const sameBytes = {
        ...otherNumber,
        payload: sub("claim", "CCN-0018").payload,
      };
      // A transport that binds the control number to the interchange may refuse the mismatch outright; either way it
      // must never answer with the first receipt.
      const otherCode = degradedCode(
        await h.transport.submitClaim(ctxFor(), sameBytes),
        "same key, other number",
      );
      check(
        otherCode === CH.IDEMPOTENCY_CONFLICT || otherCode === CH.INVALID_REQUEST,
        "the same key with a different control number is a conflict or a refusal, never a replay",
      );
      const reusedNumber = sub("claim", "CCN-0018", { idempotencyKey: "idem-new" });
      check(
        degradedCode(await h.transport.submitClaim(ctxFor(), reusedNumber), "reused number") ===
          CH.IDEMPOTENCY_CONFLICT,
        "reusing a control number under a new key is a conflict",
      );
      const asNotice = await h.transport.submitNotice(
        ctxFor(),
        sub("noe", "CCN-0018", { idempotencyKey: "idem-CCN-0018" }),
      );
      check(
        degradedCode(asNotice, "same key, other kind") === CH.IDEMPOTENCY_CONFLICT,
        "the same key with a different kind is a conflict",
      );
      if (supports(h, "adjustment")) {
        const withAdjustment = sub("claim", "CCN-0018", {
          adjustment: { kind: "void", originalControlNumber: "CCN-0018" },
        });
        check(
          degradedCode(
            await h.transport.submitClaim(ctxFor(), withAdjustment),
            "same key, added adjustment",
          ) === CH.IDEMPOTENCY_CONFLICT,
          "the same key with an adjustment added is a conflict",
        );
      }
      const [first, second] = h.payloads?.jsonDocuments?.() ?? [
        { a: 1, b: { c: 2, d: 3 } },
        { b: { d: 3, c: 2 }, a: 1 },
      ];
      const doc1 = sub("claim", "CCN-0018j", { payload: { format: "json", document: first } });
      const doc2 = sub("claim", "CCN-0018j", { payload: { format: "json", document: second } });
      ok(await h.transport.submitClaim(ctxFor(), doc1), "json first");
      const replay = ok(await h.transport.submitClaim(ctxFor(), doc2), "json same content");
      check(replay.replayed, "JSON key order does not change a submission's identity");
    },
  },
  {
    id: "S01-submit-outage-fails-closed",
    requires: ["submit"],
    stage: "4 claim / 3 NOE (resilience)",
    title:
      "during an outage submissions return a retryable envelope, never throw, are not remembered as sent, and send once the vendor recovers",
    async run(h) {
      const sub = submissionFor(h);
      await h.script.setOutage(true);
      for (const [name, r] of [
        ["submitNotice", await h.transport.submitNotice(ctxFor(), sub("noe", "NOE-S01"))],
        ["submitClaim", await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-S01"))],
      ] as const) {
        const code = degradedCode(r, name);
        check(
          code === CH.UNAVAILABLE && RETRYABLE_CODES.has(code),
          `${name} -> retryable CH_UNAVAILABLE`,
        );
      }
      await h.script.setOutage(false);
      const after = ok(
        await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-S01")),
        "submitClaim after recovery",
      );
      check(!after.replayed, "an outage must not leave a submission recorded as sent");
    },
  },
  {
    id: "S02-submit-tenant-and-mode-isolation",
    requires: ["submit"],
    stage: "4 claim (tenancy, usage)",
    title:
      "the same key in another org, provider or usage mode never replays or collides (a control number is platform-unique per mode), and your own state is intact",
    async run(h) {
      const sub = submissionFor(h);
      ok(await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-S02")), "first");
      for (const [label, scope] of [
        ["another org", OTHER_ORG],
        ["another provider", OTHER_PROVIDER],
        ["production", PRODUCTION],
      ] as const) {
        // The vendor sender is the platform's, so a control number is unique across tenants within one usage mode;
        // only the other usage mode may reuse it. The idempotency KEY is what must never cross a boundary.
        const number =
          scope.usage === DEFAULT_SCOPE.usage ? `CCN-S02-${label.split(" ")[1]}` : "CCN-S02";
        const theirs = ok(
          await h.transport.submitClaim(
            ctxFor(scope),
            sub("claim", number, {
              idempotencyKey: "idem-CCN-S02",
              payload: {
                format: "x12",
                x12: (h.payloads ?? DEFAULT_PAYLOADS).x12("claim", number, scope.usage),
              },
            }),
          ),
          `submit (${label})`,
        );
        check(!theirs.replayed, `${label} must not replay your receipt`);
      }
      const mine = ok(
        await h.transport.submitClaim(ctxFor(), sub("claim", "CCN-S02")),
        "my replay",
      );
      check(mine.replayed, "my own state is intact");
    },
  },
];

export type ConformanceOutcome =
  | { readonly id: string; readonly status: "passed" }
  | { readonly id: string; readonly status: "failed"; readonly error: string }
  | {
      readonly id: string;
      readonly status: "skipped";
      readonly missing: readonly ConformanceCapability[];
    };

/**
 * Run every case against a fresh harness each. A case whose required capabilities the harness does not declare is
 * reported `skipped` with the missing capabilities — visible, never counted as a pass.
 */
export async function runConformance(
  factory: HarnessFactory,
): Promise<readonly ConformanceOutcome[]> {
  const out: ConformanceOutcome[] = [];
  for (const c of CLEARINGHOUSE_CONFORMANCE_CASES) {
    const harness = await factory();
    const have = harness.capabilities ?? ALL_CONFORMANCE_CAPABILITIES;
    const missing = c.requires.filter((cap) => !have.has(cap));
    if (missing.length > 0) {
      out.push({ id: c.id, status: "skipped", missing });
      continue;
    }
    try {
      await c.run(harness);
      out.push({ id: c.id, status: "passed" });
    } catch (e) {
      out.push({ id: c.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

/** The failures only (empty = conformant for every capability the harness declares). */
export async function runClearinghouseConformance(
  factory: HarnessFactory,
): Promise<readonly { readonly id: string; readonly error: string }[]> {
  return (await runConformance(factory)).flatMap((o) =>
    o.status === "failed" ? [{ id: o.id, error: o.error }] : [],
  );
}
