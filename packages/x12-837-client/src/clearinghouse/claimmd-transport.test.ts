import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "./attempt-store";
import {
  type ClaimMdAnomaly,
  ClaimMdTransport,
  claimMdFilename,
  createClaimMdTransportFromEnv,
} from "./claimmd-transport";
import {
  CLEARINGHOUSE_CONFORMANCE_CASES,
  type ClearinghouseHarness,
  type ConformanceCapability,
  type ConformanceScript,
  DEFAULT_SCOPE,
  runConformance,
} from "./conformance";
import { hasList } from "./claimmd-wire";
import { scopeKey } from "./submission-identity";
import {
  CH,
  type ClearinghouseContext,
  type ClearinghouseSubmission,
  type EligibilitySearchFacts,
  isCredentialRejection,
} from "./types";

// The Claim.MD adapter against a fake Claim.MD (one account per key, like the real test/production split) and the
// shared conformance suite. Everything here is synthetic: NPIs are Luhn-valid test values, the member id comes from the
// committed Stedi fixture (compliance/synthetic-identifiers.json).

const TEST_KEY = "claimmd_test_key_do_not_leak";
const PROD_KEY = "claimmd_prod_key_do_not_leak";
const NPI = DEFAULT_SCOPE.billingNpi as string;
const OTHER_NPI = "1245319599";

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");
const BASE = {
  claim: fixture("claim"),
  noe: fixture("NOE_81A"),
  notr: fixture("NOTR_81B"),
  transfer_notice: fixture("TRANSFER_81C"),
};

interface X12Options {
  readonly usage?: "test" | "production";
  readonly npi?: string;
  readonly frequency?: string;
  readonly f8?: string;
}

/** A Claim.MD-shaped interchange: ISA08 CLAIMMD, CLM01 = control number, BHT03 = variant. */
function claimMdX12(
  kind: ClearinghouseSubmission["kind"],
  variant: string,
  controlNumber: string = variant,
  o: X12Options = {},
): string {
  const id = variant.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || "V";
  let x = BASE[kind]
    .replace(/^(ISA(?:\*[^*]*){7}\*)[^*]*/, `$1${"CLAIMMD".padEnd(15, " ")}`)
    .replace(/(\*00501\*[^*]+\*\d\*)[TP](\*)/, `$1${o.usage === "production" ? "P" : "T"}$2`)
    .replace(/(BHT\*0019\*00\*)[^*]+/, `$1${id}`)
    .replace(/CLM\*[^*]+\*/, `CLM*${controlNumber}*`)
    .replace(/(NM1\*85\*2\*[^~]*\*XX\*)\d{10}/, `$1${o.npi ?? NPI}`);
  if (o.frequency) x = x.replace(/(81:A:)[0-9A-Z]/, `$1${o.frequency}`);
  if (o.f8) x = x.replace(/(CLM\*[^~]*~)/, `$1REF*F8*${o.f8}~`);
  return x;
}

interface Account {
  uploads: { filename: string; inboundid: string; date: string }[];
  responses: Record<string, unknown>[];
  eras: { eraid: string; npi: string; x12: string }[];
  claimIds: Map<string, string>;
}

/** A fake Claim.MD. `mode` drives failures; the `respond`/`era` helpers play the clearinghouse and the payer. */
function fakeClaimMd(clock: () => Date) {
  const accounts = new Map<string, Account>([
    [TEST_KEY, { uploads: [], responses: [], eras: [], claimIds: new Map() }],
    [PROD_KEY, { uploads: [], responses: [], eras: [], claimIds: new Map() }],
  ]);
  let mode: "up" | "down" | "unreachable" | "lost_after_upload" | "bad_key" | "garbled_list" | "list_lags" | "gateway_after_upload" | "endless_stream" = "up";
  let seq = 1000;
  const calls: string[] = [];
  let lastEligibility: Record<string, string> = {};

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https:\/\/svc\.claim\.md\/services\//, "").replace(/\/$/, "");
    calls.push(path);
    // Claim.MD's documented block (100 requests a minute) is a 403 before any work: the outage the harness scripts.
    if (mode === "down") return new Response("rate limited", { status: 403 });
    if (mode === "unreachable") throw new TypeError("fetch failed");
    const body = init?.body as URLSearchParams | FormData;
    const key = String(body.get("AccountKey"));
    if (mode === "bad_key") // The observed shape (2026-11-04): HTTP 200, a single error object, code 21.
      return Response.json({ error: { error_code: "21", error_mesg: "Invalid AccountKey." } });
    const acct = accounts.get(key);
    if (!acct)
      return Response.json({ error: { error_code: "21", error_mesg: "Invalid AccountKey." } });
    const f = (name: string) => String(body.get(name) ?? "");
    switch (path) {
      case "upload": {
        const file = await (body.get("File") as Blob).text();
        const json = f("Filename").endsWith(".json") ? (JSON.parse(file).claim[0] as Record<string, string>) : null;
        const pcn = json?.pcn ?? /CLM\*([^*]+)\*/.exec(file)?.[1] ?? "";
        const npi = json?.bill_npi ?? /NM1\*85\*[^~]*\*XX\*(\d{10})/.exec(file)?.[1] ?? "";
        // Observed 2026-11-05: a repeated Filename is refused whole, code 61 as a NUMBER.
        if (acct.uploads.some((u) => u.filename === f("Filename")))
          return Response.json({ error: { error_code: 61, error_mesg: `ERROR File: '${f("Filename")}' is a duplicate.` } });
        const claimid = String(++seq);
        acct.claimIds.set(pcn, claimid);
        acct.uploads.push({ filename: f("Filename"), inboundid: `IN${seq}`, date: clock().toISOString().slice(0, 10) });
        if (mode === "lost_after_upload") throw new TypeError("socket hang up");
        if (mode === "gateway_after_upload") return new Response("bad gateway", { status: 502 });
        // Observed 2026-11-04: the upload answer names our claim (pcn) with a fileid but no claimid.
        return Response.json({ claim: [{ pcn, bill_npi: npi, status: "A", senderid: "CLMMD", fileid: `F${seq}` }] });
      }
      case "uploadlist": {
        if (mode === "garbled_list") return Response.json({ notice: "Service temporarily unavailable" });
        const files = acct.uploads.filter((u) => u.date === f("UploadDate") && mode !== "list_lags");
        // Observed 2026-11-05: a day with no uploads answers `{}`.
        if (files.length === 0) return Response.json({});
        return Response.json({ file: files.map((u) => ({ filename: u.filename, inboundid: u.inboundid })) });
      }
      case "response": {
        const after = Number(f("ResponseID"));
        if (mode === "endless_stream") {
          // Every page full (20,000 other claims): the stream never ends within the status scan.
          const claim = Array.from({ length: 20_000 }, (_, i) => ({ pcn: `OTHER-${after + i}`, bill_npi: OTHER_NPI, status: "A" }));
          return Response.json({ last_responseid: String(after + 20_000), claim });
        }
        const claimId = f("ClaimID");
        const rows = acct.responses.filter(
          (r) => Number(r.rid) > after && (!claimId || r.claimid === claimId),
        );
        // Observed 2026-11-04: nothing new answers `{}` (no claim list, no last_responseid).
        if (rows.length === 0) return Response.json({});
        const last = acct.responses.at(-1)?.rid ?? String(after);
        return Response.json({ last_responseid: claimId ? undefined : last, claim: rows });
      }
      case "eralist": {
        const after = Number(f("ERAID"));
        return Response.json({
          last_eraid: acct.eras.at(-1)?.eraid,
          era: acct.eras
            .filter((e) => Number(e.eraid) > after && e.npi === f("NPI"))
            .map((e) => ({ eraid: e.eraid, prov_npi: e.npi, received_time: "2026-11-04 10:15:00am" })),
        });
      }
      case "era835": {
        const era = acct.eras.find((e) => e.eraid === f("eraid"));
        // Observed 2026-11-05: `data` is a one-element array holding the whole 835; ids are numbers.
        return Response.json({ eraid: Number(era?.eraid), data: era?.x12 === undefined ? undefined : [era.x12] });
      }
      case "eligdata": {
        lastEligibility = Object.fromEntries((body as URLSearchParams).entries());
        delete lastEligibility.AccountKey;
        const coverage = { "ACTIVE-1": "1", "TERM-1": "6", "PEND-1": "5" }[f("ins_number")];
        if (!coverage) return Response.json({ error: { error_code: "75", error_mesg: `Subscriber ${f("ins_name_l")} not found` } });
        return Response.json({
          elig: { eligid: "1", benefit: [{ benefit_code: "30", benefit_coverage_code: coverage }, { benefit_code: "30", benefit_coverage_code: "C" }] },
        });
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }) as typeof fetch;

  const account = (usage: "test" | "production") => accounts.get(usage === "test" ? TEST_KEY : PROD_KEY) as Account;
  return {
    fetchImpl,
    calls,
    lastEligibility: () => lastEligibility,
    setMode: (m: typeof mode) => {
      mode = m;
    },
    account,
    /** One answer in the response stream (a clearinghouse answer when `sender` is CLMMD). */
    respond(
      usage: "test" | "production",
      pcn: string,
      a: { status: string; sender?: string; icn?: string; mesgid?: string; npi?: string },
    ) {
      const acct = account(usage);
      const rid = String(++seq);
      acct.responses.push({
        rid,
        pcn,
        claimid: acct.claimIds.get(pcn) ?? "0",
        bill_npi: a.npi ?? NPI,
        status: a.status,
        senderid: a.sender ?? "CLMMD",
        sender_icn: a.icn ?? "",
        response_time: "2026-11-04 09:05:00pm",
        messages: [{ responseid: rid, status: a.status, mesgid: a.mesgid ?? "ACK", message: "free text never surfaced" }],
      });
    },
    era(usage: "test" | "production", eraid: string, x12: string, npi = NPI) {
      account(usage).eras.push({ eraid, npi, x12 });
    },
  };
}

function setup() {
  let now = new Date("2026-11-04T17:00:00.000Z");
  const server = fakeClaimMd(() => now);
  const anomalies: ClaimMdAnomaly[] = [];
  const attempts = new InMemoryAttemptStore();
  const transport = new ClaimMdTransport({
    keys: { test: TEST_KEY, production: PROD_KEY },
    attempts,
    fetch: server.fetchImpl,
    now: () => now,
    onAnomaly: (a) => anomalies.push(a),
  });
  return {
    server,
    transport,
    attempts,
    anomalies,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

const ctx = (over: Partial<ClearinghouseContext> = {}): ClearinghouseContext => ({
  ...DEFAULT_SCOPE,
  payerId: "15004",
  correlationId: "corr-1",
  ...over,
});
const claim = (cn: string, over: Partial<ClearinghouseSubmission> = {}, o: X12Options = {}): ClearinghouseSubmission => ({
  kind: "claim",
  controlNumber: cn,
  idempotencyKey: `idem-${cn}`,
  payload: { format: "x12", x12: claimMdX12("claim", cn, cn, o) },
  ...over,
});

function unsupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the Claim.MD harness does not script ${name}`));
}

function createHarness(): ClearinghouseHarness {
  const s = setup();
  const script: ConformanceScript = {
    setOutage: async (down) => {
      s.server.setMode(down ? "down" : "up");
      // The outage answers 403 (Claim.MD's block before any work), so the reservation is released and the retry sends.
    },
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
    transport: s.transport,
    script,
    // `receive` is proven by the Claim.MD cases below instead: the shared receive cases give every tenant the SAME NPI,
    // which provider_entity.npi's platform-wide unique index makes impossible, and NPI is this adapter's tenant filter.
    capabilities: new Set<ConformanceCapability>(["submit"]),
    payloads: {
      x12: (kind, variant, usage, controlNumber) =>
        claimMdX12(kind, variant, controlNumber ?? variant, { usage: usage ?? "test" }),
      jsonDocuments: () => [
        { claim: [{ pcn: "CCN-0018j", bill_npi: NPI, claim_form: "UB", total_charge: "10.00" }] },
        { claim: [{ total_charge: "10.00", claim_form: "UB", bill_npi: NPI, pcn: "CCN-0018j" }] },
      ],
    },
  };
}

describe("ClaimMdTransport against the shared conformance suite (submit side)", () => {
  it("passes every case it implements and skips the rest by name", async () => {
    const outcomes = await runConformance(async () => createHarness());
    expect(outcomes.filter((o) => o.status === "failed")).toEqual([]);
    const passed = outcomes.filter((o) => o.status === "passed").map((o) => o.id);
    expect(passed).toEqual([
      "C03-notice-kind-routing",
      "C04-idempotent-submission",
      "C18-idempotency-identity",
      "S01-submit-outage-fails-closed",
      "S02-submit-tenant-and-mode-isolation",
    ]);
    expect(outcomes.filter((o) => o.status === "skipped").map((o) => o.id)).toEqual(
      CLEARINGHOUSE_CONFORMANCE_CASES.map((c) => c.id).filter((id) => !passed.includes(id)),
    );
  });
});

describe("ClaimMdTransport submission", () => {
  it("uploads one claim under a PHI-free filename and records Claim.MD's file id (its answer carries no claim id)", async () => {
    const s = setup();
    const r = await s.transport.submitClaim(ctx(), claim("CCN-1"));
    expect(r.ok && r.data.clearinghouseSubmissionId).toMatch(/^file:F\d+$/);
    const upload = s.server.account("test").uploads[0];
    expect(upload?.filename).toBe(claimMdFilename(scopeKey(ctx()), "idem-CCN-1"));
    expect(upload?.filename).toMatch(/^cw-[0-9a-f]{40}\.837$/);
    const again = await s.transport.submitClaim(ctx(), claim("CCN-1"));
    expect(again.ok && again.data.replayed).toBe(true);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it.each([
    ["the receiver is not CLAIMMD", (x: string) => x.replace("CLAIMMD        ", "STEDI          "), "ISA08"],
    ["CLM01 is not the control number", (x: string) => x.replace("CLM*CCN-2*", "CLM*OTHER*"), "CLM01"],
    ["the billing NPI is another provider's", (x: string) => x.replace(`XX*${NPI}`, `XX*${OTHER_NPI}`), "NPI"],
    ["the usage is production", (x: string) => x.replace(/\*T\*:~/, "*P*:~"), "ISA15"],
  ])("refuses before any call when %s", async (_label, mutate, reason) => {
    const s = setup();
    const sub = claim("CCN-2");
    const x12 = mutate((sub.payload as { x12: string }).x12);
    const r = await s.transport.submitClaim(ctx(), { ...sub, payload: { format: "x12", x12 } });
    expect(!r.ok && r.degraded.code).toBe(CH.INVALID_REQUEST);
    expect(!r.ok && r.degraded.reason).toContain(reason);
    expect(s.server.calls).toEqual([]);
  });

  it("refuses without a billing NPI, and a usage with no account key is not wired", async () => {
    const s = setup();
    const noNpi = await s.transport.submitClaim(ctx({ billingNpi: undefined }), claim("CCN-3"));
    expect(!noNpi.ok && noNpi.degraded.code).toBe(CH.INVALID_REQUEST);
    const testOnly = new ClaimMdTransport({ keys: { test: TEST_KEY }, attempts: new InMemoryAttemptStore() });
    const prod = await testOnly.submitClaim(ctx({ usage: "production" }), claim("CCN-3", {}, { usage: "production" }));
    expect(!prod.ok && prod.degraded.code).toBe(CH.NOT_WIRED);
  });

  it("never re-uploads blind after an unconfirmed upload: it finds the file in the upload list", async () => {
    const s = setup();
    s.server.setMode("lost_after_upload");
    const first = await s.transport.submitClaim(ctx(), claim("CCN-4"));
    expect(!first.ok && first.degraded.code).toBe(CH.IN_DOUBT);
    s.server.setMode("up");
    const early = await s.transport.submitClaim(ctx(), claim("CCN-4"));
    expect(!early.ok && early.degraded.reason).toContain("in flight");
    s.advance(16 * 60_000);
    const reconciled = await s.transport.submitClaim(ctx(), claim("CCN-4"));
    expect(reconciled.ok && reconciled.data.clearinghouseSubmissionId).toMatch(/^file:IN\d+$/);
    expect(s.server.account("test").uploads).toHaveLength(1);
    expect(s.anomalies).toContainEqual({ type: "reconciled_from_upload_list", idempotencyKey: "idem-CCN-4" });
  });

  it("re-uploads a stale reservation only when the upload list proves the file never arrived", async () => {
    const s = setup();
    s.server.setMode("unreachable");
    const first = await s.transport.submitClaim(ctx(), claim("CCN-5"));
    expect(!first.ok && first.degraded.code).toBe(CH.IN_DOUBT);
    s.server.setMode("up");
    s.advance(16 * 60_000);
    const resent = await s.transport.submitClaim(ctx(), claim("CCN-5"));
    expect(resent.ok && resent.data.replayed).toBe(false);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it("never concludes 'absent' from an upload-list answer it cannot read", async () => {
    const s = setup();
    s.server.setMode("lost_after_upload");
    await s.transport.submitClaim(ctx(), claim("CCN-5B"));
    s.server.setMode("garbled_list");
    s.advance(16 * 60_000);
    const again = await s.transport.submitClaim(ctx(), claim("CCN-5B"));
    expect(!again.ok && again.degraded.code).toBe(CH.UNAVAILABLE);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it("a duplicate-file refusal (code 61) proves an earlier upload landed: in doubt, never released or re-sent", async () => {
    const s = setup();
    s.server.setMode("lost_after_upload");
    await s.transport.submitClaim(ctx(), claim("CCN-5D"));
    // The upload list lags behind the upload, so reconciliation wrongly sees nothing and re-sends.
    s.server.setMode("list_lags");
    s.advance(16 * 60_000);
    const again = await s.transport.submitClaim(ctx(), claim("CCN-5D"));
    expect(!again.ok && again.degraded.code).toBe(CH.IN_DOUBT);
    expect(JSON.stringify(again)).not.toContain("duplicate");
    s.server.setMode("up");
    s.advance(16 * 60_000);
    const settled = await s.transport.submitClaim(ctx(), claim("CCN-5D"));
    expect(settled.ok && settled.data.clearinghouseSubmissionId).toMatch(/^file:IN\d+$/);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it("a 502 after Claim.MD filed the upload is in doubt: kept, then reconciled, never sent twice", async () => {
    const s = setup();
    s.server.setMode("gateway_after_upload");
    const first = await s.transport.submitClaim(ctx(), claim("CCN-5E"));
    expect(!first.ok && first.degraded.code).toBe(CH.IN_DOUBT);
    s.server.setMode("up");
    s.advance(16 * 60_000);
    const reconciled = await s.transport.submitClaim(ctx(), claim("CCN-5E"));
    expect(reconciled.ok && reconciled.data.clearinghouseSubmissionId).toMatch(/^file:IN\d+$/);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it("the 403 rate block releases the reservation: refused before any work, so the retry sends at once", async () => {
    const s = setup();
    s.server.setMode("down");
    const first = await s.transport.submitClaim(ctx(), claim("CCN-5C"));
    expect(!first.ok && first.degraded.code).toBe(CH.UNAVAILABLE);
    s.server.setMode("up");
    const resent = await s.transport.submitClaim(ctx(), claim("CCN-5C"));
    expect(resent.ok).toBe(true);
    expect(s.server.account("test").uploads).toHaveLength(1);
  });

  it("maps a rejected key to the fixed credential reason and releases the reservation", async () => {
    const s = setup();
    s.server.setMode("bad_key");
    const r = await s.transport.submitClaim(ctx(), claim("CCN-6"));
    expect(isCredentialRejection(r)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(TEST_KEY);
    expect(JSON.stringify(r)).not.toContain("Invalid AccountKey");
    s.server.setMode("up");
    const retry = await s.transport.submitClaim(ctx(), claim("CCN-6"));
    expect(retry.ok && retry.data.replayed).toBe(false);
  });

  it("sends a replacement only for a known original, with CLM05-3 7 and the payer ICN in REF*F8", async () => {
    const s = setup();
    const adjustment = { kind: "replacement", originalControlNumber: "CCN-7", originalPayerClaimNumber: "ICN-77" } as const;
    const replacement = claim("CCN-7R", { adjustment }, { frequency: "7", f8: "ICN-77" });
    const unknown = await s.transport.submitClaim(ctx(), replacement);
    expect(!unknown.ok && unknown.degraded.code).toBe(CH.UNKNOWN_ORIGINAL);
    expect((await s.transport.submitClaim(ctx(), claim("CCN-7"))).ok).toBe(true);
    expect((await s.transport.submitClaim(ctx(), replacement)).ok).toBe(true);
    const wrongF8 = claim("CCN-7V", { adjustment: { ...adjustment, kind: "void" } }, { frequency: "8", f8: "ICN-OTHER" });
    const refused = await s.transport.submitClaim(ctx(), wrongF8);
    expect(!refused.ok && refused.degraded.reason).toContain("REF*F8");
    const plainSeven = await s.transport.submitClaim(ctx(), claim("CCN-8", {}, { frequency: "7" }));
    expect(!plainSeven.ok && plainSeven.degraded.code).toBe(CH.INVALID_REQUEST);
  });

  it("sends NOE, NOTR and transfer notices through submitNotice only", async () => {
    const s = setup();
    for (const kind of ["noe", "notr", "transfer_notice"] as const) {
      const cn = `N-${kind}`.replace("_", "");
      const sub = { ...claim(cn), kind, payload: { format: "x12" as const, x12: claimMdX12(kind, cn) } };
      expect((await s.transport.submitNotice(ctx(), sub)).ok).toBe(true);
      expect((await s.transport.submitClaim(ctx(), sub)).ok).toBe(false);
    }
  });
});

describe("ClaimMdTransport acknowledgments, status and remittance", () => {
  async function submitted(s: ReturnType<typeof setup>, cn: string, over: Partial<ClearinghouseContext> = {}) {
    const npi = over.billingNpi ?? NPI;
    const r = await s.transport.submitClaim(ctx(over), claim(cn, {}, { npi, usage: over.usage }));
    expect(r.ok).toBe(true);
  }

  it("splits the clearinghouse stage (sender CLMMD) from the payer stage and carries codes, never text", async () => {
    const s = setup();
    await submitted(s, "CCN-10");
    s.server.respond("test", "CCN-10", { status: "A" });
    s.server.respond("test", "CCN-10", { status: "R", sender: "15004", mesgid: "A7:562" });
    const page = await s.transport.fetchAcknowledgments(ctx(), null);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.data.items.map((a) => [a.stage, a.disposition, a.reasonCodes])).toEqual([
      ["clearinghouse", "accepted", []],
      ["payer", "rejected", ["A7:562"]],
    ]);
    // The day only (zone unstated): M41's ack validator accepts a bare YYYY-MM-DD, not a zoneless time.
    expect(page.data.items[0]?.occurredAt).toBe("2026-11-04");
    expect(JSON.stringify(page)).not.toContain("free text");
    const resumed = await s.transport.fetchAcknowledgments(ctx(), page.data.nextCursor);
    expect(resumed.ok && resumed.data.items).toEqual([]);
  });

  it("shows another provider nothing from the shared account stream", async () => {
    const s = setup();
    await submitted(s, "CCN-11");
    s.server.respond("test", "CCN-11", { status: "A" });
    s.server.era("test", "501", "ST*835*0001~SE*2*0001~");
    const other = ctx({ organizationId: "org-other", providerEntityId: "pe-other", billingNpi: OTHER_NPI });
    const acks = await s.transport.fetchAcknowledgments(other, null);
    expect(acks.ok && acks.data.items).toEqual([]);
    const status = await s.transport.fetchClaimStatus(other, "CCN-11");
    expect(status.ok && status.data.state).toBe("not_found");
    const rem = await s.transport.fetchRemittances(other, null);
    expect(rem.ok && rem.data.items).toEqual([]);
  });

  it("keeps test and production apart: each usage reads only its own Claim.MD account", async () => {
    const s = setup();
    await submitted(s, "CCN-12");
    s.server.respond("test", "CCN-12", { status: "A" });
    const prod = await s.transport.fetchAcknowledgments(ctx({ usage: "production" }), null);
    expect(prod.ok && prod.data.items).toEqual([]);
  });

  it("reports status by the highest stage reached, with the payer claim number", async () => {
    const s = setup();
    await submitted(s, "CCN-13");
    s.server.respond("test", "CCN-13", { status: "A", sender: "15004", icn: "ICN-913" });
    s.server.respond("test", "CCN-13", { status: "A" });
    const status = await s.transport.fetchClaimStatus(ctx(), "CCN-13");
    expect(status.ok && status.data.state).toBe("payer_accepted");
    expect(status.ok && status.data.latest?.payerClaimNumber).toBe("ICN-913");
    const unknown = await s.transport.fetchClaimStatus(ctx(), "CCN-NONE");
    expect(unknown.ok && unknown.data.state).toBe("not_found");
  });

  it("skips and flags an unknown status letter instead of guessing", async () => {
    const s = setup();
    await submitted(s, "CCN-14");
    s.server.respond("test", "CCN-14", { status: "Q" });
    const page = await s.transport.fetchAcknowledgments(ctx(), null);
    expect(page.ok && page.data.items).toEqual([]);
    expect(s.anomalies).toContainEqual({ type: "unmapped_status", stage: "clearinghouse", status: "Q", controlNumber: "CCN-14" });
  });

  it("a status scan that runs out of pages is unavailable, never 'no answer yet'", async () => {
    const s = setup();
    await submitted(s, "CCN-14B");
    s.server.setMode("endless_stream");
    const status = await s.transport.fetchClaimStatus(ctx(), "CCN-14B");
    expect(!status.ok && status.degraded.code).toBe(CH.UNAVAILABLE);
  });

  it("never moves a cursor backwards, and treats a read-side error as retryable (no cursor reset)", async () => {
    const s = setup();
    await s.transport.submitClaim(ctx(), claim("CCN-13"));
    s.server.respond("test", "CCN-13", { status: "A" });
    s.server.era("test", "700", "ST*835*0001~SE*2*0001~");
    const acks = await s.transport.fetchAcknowledgments(ctx(), "999999");
    expect(acks.ok && acks.data.nextCursor).toBe("999999");
    const eras = await s.transport.fetchRemittances(ctx(), "999999");
    expect(eras.ok && eras.data).toMatchObject({ items: [], nextCursor: "999999" });
    s.server.setMode("unreachable");
    const down = await s.transport.fetchAcknowledgments(ctx(), "5");
    expect(!down.ok && down.degraded.code).toBe(CH.UNAVAILABLE);
  });

  it("refuses a malformed cursor rather than restarting from the beginning", async () => {
    const s = setup();
    for (const bad of ["garbage", "-1", "2abc", "1.5"]) {
      const r = await s.transport.fetchAcknowledgments(ctx(), bad);
      expect(!r.ok && r.degraded.code).toBe(CH.INVALID_REQUEST);
      const e = await s.transport.fetchRemittances(ctx(), bad);
      expect(!e.ok && e.degraded.code).toBe(CH.INVALID_REQUEST);
    }
  });

  it("delivers each ERA's 835 byte-for-byte once per cursor chain, filtered to the provider's NPI", async () => {
    const s = setup();
    const raw = "ISA*00*...~ST*835*0001~BPR*I*0~SE*2*0001~";
    s.server.era("test", "601", raw);
    s.server.era("test", "602", "ST*835*0002~SE*1*0002~", OTHER_NPI);
    const first = await s.transport.fetchRemittances(ctx(), null);
    expect(first.ok && first.data.items.map((r) => [r.remittanceId, r.rawX12])).toEqual([["claimmd-601", raw]]);
    if (!first.ok) return;
    const rest = await s.transport.fetchRemittances(ctx(), first.data.nextCursor);
    expect(rest.ok && rest.data.items).toEqual([]);
    s.server.era("test", "603", raw);
    const resumed = await s.transport.fetchRemittances(ctx(), first.data.nextCursor);
    expect(resumed.ok && resumed.data.items.map((r) => r.remittanceId)).toEqual(["claimmd-603"]);
  });

  it("answers every method with a degraded envelope during an outage, never a throw", async () => {
    const s = setup();
    s.server.setMode("down");
    const results = await Promise.all([
      s.transport.fetchAcknowledgments(ctx(), null),
      s.transport.fetchRemittances(ctx(), null),
      s.transport.checkEligibility(ctx(), elig("ACTIVE-1")),
      s.transport.verifyAndParseEvent(),
    ]);
    for (const r of results) expect(r.ok).toBe(false);
  });
});

const elig = (memberId: string, over: Partial<EligibilitySearchFacts> = {}) => ({
  memberId,
  serviceDate: "2026-11-01",
  subscriber: { firstName: "Jane", lastName: "Doe", dateOfBirth: "1940-03-15" },
  billingProviderTaxId: "99-9999999",
  ...over,
});

describe("ClaimMdTransport eligibility (eligdata) and the local dry run", () => {
  it("maps Claim.MD's benefit coverage codes to active / inactive / unknown, as of the service date", async () => {
    const s = setup();
    const answers = await Promise.all(
      ["ACTIVE-1", "TERM-1", "PEND-1"].map((m) => s.transport.checkEligibility(ctx(), elig(m))),
    );
    expect(answers.map((a) => a.ok && a.data)).toEqual([
      { outcome: "active", asOfDate: "2026-11-01" },
      { outcome: "inactive", asOfDate: "2026-11-01" },
      { outcome: "unknown", asOfDate: "2026-11-01" },
    ]);
  });

  it("sends the search the docs require: name, DOB, member id, payer, NPI, EIN, service date, self", async () => {
    const s = setup();
    await s.transport.checkEligibility(ctx(), elig("ACTIVE-1"));
    expect(s.server.lastEligibility()).toEqual({
      ins_name_l: "Doe",
      ins_name_f: "Jane",
      ins_number: "ACTIVE-1",
      ins_dob: "19400315",
      pat_rel: "18",
      payerid: "15004",
      service_code: "30",
      fdos: "20261101",
      prov_npi: NPI,
      prov_taxid: "999999999",
      prov_taxid_type: "E",
    });
  });

  it("sends nothing without the subscriber's name or the provider's tax id", async () => {
    const s = setup();
    const noName = await s.transport.checkEligibility(ctx(), { memberId: "ACTIVE-1", serviceDate: "2026-11-01" });
    const noTin = await s.transport.checkEligibility(ctx(), elig("ACTIVE-1", { billingProviderTaxId: undefined }));
    for (const r of [noName, noTin]) expect(!r.ok && r.degraded.code).toBe(CH.INVALID_REQUEST);
    expect(s.server.calls).toEqual([]);
  });

  it("reduces a Claim.MD eligibility error to its code: no name, member id or vendor text in the answer", async () => {
    const s = setup();
    const r = await s.transport.checkEligibility(ctx(), elig("UNKNOWN-9"));
    expect(!r.ok && r.degraded).toMatchObject({ code: CH.INVALID_REQUEST });
    const text = JSON.stringify(r);
    for (const leak of ["Doe", "Jane", "UNKNOWN-9", "not found", "1940"]) expect(text).not.toContain(leak);
  });

  it("validateOnly runs the pre-upload checks locally and never calls Claim.MD", async () => {
    const s = setup();
    const good = await s.transport.validateOnly(ctx(), claim("CCN-20"));
    expect(good.ok && good.data).toEqual({ valid: true, issues: [] });
    const bad = await s.transport.validateOnly(ctx({ billingNpi: OTHER_NPI }), claim("CCN-21"));
    expect(bad.ok && bad.data.valid).toBe(false);
    expect(bad.ok && bad.data.issues[0]?.code).toBe("CLAIMMD_PRECHECK");
    expect(s.server.calls).toEqual([]);
  });
});

describe("createClaimMdTransportFromEnv", () => {
  const store = new InMemoryAttemptStore();
  it("needs the key and which account it opens", () => {
    expect(() => createClaimMdTransportFromEnv({}, store)).toThrow(/CLAIMMD_ACCOUNT_KEY/);
    expect(() => createClaimMdTransportFromEnv({ CLAIMMD_ACCOUNT_KEY: "k" }, store)).toThrow(/CLAIMMD_ACCOUNT_USAGE/);
    const t = createClaimMdTransportFromEnv({ CLAIMMD_ACCOUNT_KEY: "k", CLAIMMD_ACCOUNT_USAGE: "test" }, store);
    expect(t.vendor).toBe("claimmd");
  });
});

describe("Claim.MD answer shapes (observed 2026-11-05)", () => {
  it("an empty `{}` is an empty list; any other shape without the list is unknown", () => {
    expect(hasList({}, "file")).toBe(true);
    expect(hasList({ file: [] }, "file")).toBe(true);
    expect(hasList({ notice: "busy" }, "file")).toBe(false);
  });
});
