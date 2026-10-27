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
import {
  CredentialRejectedError,
  type DirectMacGateway,
  DirectMacTransport,
  UploadNotSentError,
} from "./direct-mac-transport";
import { type AckEvent, CH, type ClearinghouseContext, RETRYABLE_CODES } from "./types";

// The direct-MAC adapter against the shared conformance suite (ADR-0053 D4). Declared capabilities: `submit` only.
// Why not `receive`: the legacy portal has no claim-status inquiry, no 835 delivery on this path (M25's worker port) and
// no signed push, and its pending-file ack list is consumed as it is read, so a cursor restart cannot replay (C08/C17).
// `validate`, `eligibility`, `adjustment`, `enrollment` likewise have no gateway operation. Those cases are skipped BY
// NAME below; fetchAcknowledgments is covered by its own tests here.

const fixture = (name: string): string =>
  readFileSync(join(__dirname, "__fixtures__", `stedi-${name}.x12`), "utf8");
const BASE_X12 = {
  claim: fixture("claim"),
  noe: fixture("NOE_81A"),
  notr: fixture("NOTR_81B"),
  transfer_notice: fixture("TRANSFER_81C"),
};

function x12For(
  kind: "claim" | "noe" | "notr" | "transfer_notice",
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

interface FakeGateway extends DirectMacGateway {
  outage: boolean;
  readonly uploads: string[];
  acks: AckEvent[];
}

function fakeGateway(): FakeGateway {
  const gw: FakeGateway = {
    outage: false,
    uploads: [],
    acks: [],
    // The generator echoes a valid file for the control number it was given (usage test).
    generate: async ({ kind, controlNumber }) => {
      if (gw.outage) throw new UploadNotSentError("down");
      return { x12: x12For(kind, "G", "test", controlNumber) };
    },
    upload: async ({ controlNumber }) => {
      if (gw.outage) throw new UploadNotSentError("down");
      gw.uploads.push(controlNumber);
      return { accepted: true, fileId: `file-${gw.uploads.length}` };
    },
    pullAcknowledgments: async () => {
      if (gw.outage) throw new Error("down");
      return gw.acks;
    },
  };
  return gw;
}

function unsupported(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`the direct_mac harness does not script ${name}`));
}

function createHarness(gw: FakeGateway = fakeGateway()): ClearinghouseHarness {
  let clock = new Date("2026-10-11T10:00:00.000Z");
  const script: ConformanceScript = {
    setOutage: async (down) => {
      if (!down) clock = new Date(clock.getTime() + 120_000);
      gw.outage = down;
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
    transport: new DirectMacTransport({
      attempts: new InMemoryAttemptStore(),
      gateway: gw,
      now: () => clock,
    }),
    script,
    capabilities: new Set<ConformanceCapability>(["submit"]),
    payloads: {
      x12: x12For,
      jsonDocuments: () => [
        { claimId: "c1", claimDocument: { x: { c: 2, d: 3 }, y: 1 } },
        { claimDocument: { y: 1, x: { d: 3, c: 2 } }, claimId: "c1" },
      ],
    },
  };
}

const ctx: ClearinghouseContext = { ...DEFAULT_SCOPE, payerId: "payer", correlationId: "corr" };

describe("DirectMacTransport against the shared conformance suite (submit side)", () => {
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
    const skipped = outcomes.filter((o) => o.status === "skipped").map((o) => o.id);
    expect(skipped).toEqual(
      CLEARINGHOUSE_CONFORMANCE_CASES.map((c) => c.id).filter((id) => !passed.includes(id)),
    );
  });
});

describe("DirectMacTransport", () => {
  it("carries a transfer notice as raw X12 and refuses a JSON document for it (typed, nothing uploaded)", async () => {
    const gw = fakeGateway();
    const t = createHarness(gw).transport;
    const sent = await t.submitNotice(ctx, {
      kind: "transfer_notice",
      controlNumber: "000000041",
      idempotencyKey: "idem-41",
      payload: { format: "x12", x12: x12For("transfer_notice", "T", "test", "000000041") },
    });
    expect(sent).toMatchObject({ ok: true, data: { replayed: false } });
    const json = await t.submitNotice(ctx, {
      kind: "transfer_notice",
      controlNumber: "000000042",
      idempotencyKey: "idem-42",
      payload: { format: "json", document: { transferNoticeId: "t" } },
    });
    expect(json).toMatchObject({ ok: false, degraded: { code: CH.INVALID_REQUEST } });
    expect(gw.uploads).toEqual(["000000041"]);
  });

  it("passes a payer partial through fetchAcknowledgments unchanged", async () => {
    const gw = fakeGateway();
    gw.acks = [
      {
        eventId: "277ca:u9:CCN9",
        stage: "payer",
        disposition: "partial",
        controlNumber: "CCN9",
        reasonCodes: ["A7"],
        occurredAt: "2026-10-11",
      },
    ];
    const r = await createHarness(gw).transport.fetchAcknowledgments(ctx, null);
    expect(r).toMatchObject({ ok: true, data: { items: gw.acks } });
  });

  const submission = (x12: string, controlNumber = "000000001") => ({
    kind: "claim" as const,
    controlNumber,
    idempotencyKey: `idem-${controlNumber}`,
    payload: { format: "x12" as const, x12 },
  });

  it("uploads exactly once and replays the receipt", async () => {
    const gw = fakeGateway();
    const t = createHarness(gw).transport;
    const s = submission(x12For("claim", "A", "test", "000000001"));
    const first = await t.submitClaim(ctx, s);
    const second = await t.submitClaim(ctx, s);
    expect(first).toMatchObject({ ok: true, data: { replayed: false } });
    expect(second).toMatchObject({ ok: true, data: { replayed: true } });
    expect(gw.uploads).toEqual(["000000001"]);
  });

  it("renders a JSON submission through the gateway generator before the upload", async () => {
    const gw = fakeGateway();
    const t = createHarness(gw).transport;
    const r = await t.submitClaim(ctx, {
      kind: "claim",
      controlNumber: "000000002",
      idempotencyKey: "idem-2",
      payload: { format: "json", document: { claimId: "c" } },
    });
    expect(r.ok).toBe(true);
    expect(gw.uploads).toEqual(["000000002"]);
  });

  it("a portal refusal is definitive: not retryable, and the key is free again", async () => {
    const gw = fakeGateway();
    gw.upload = async () => ({ accepted: false, fileId: "" });
    const t = createHarness(gw).transport;
    const r = await t.submitClaim(
      ctx,
      submission(x12For("claim", "A", "test", "000000003"), "000000003"),
    );
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.INVALID_REQUEST } });
    gw.upload = async () => ({ accepted: true, fileId: "f" });
    const again = await t.submitClaim(
      ctx,
      submission(x12For("claim", "A", "test", "000000003"), "000000003"),
    );
    expect(again).toMatchObject({ ok: true, data: { replayed: false } });
  });

  it("an upload that fails in doubt is never re-sent under the same key, nor under a new control number's reservation", async () => {
    const gw = fakeGateway();
    let calls = 0;
    gw.upload = async () => {
      calls += 1;
      throw new Error("socket hang up"); // the file may have landed
    };
    const t = createHarness(gw).transport;
    const s = submission(x12For("claim", "A", "test", "000000005"), "000000005");
    const first = await t.submitClaim(ctx, s);
    expect(first).toMatchObject({ ok: false, degraded: { code: CH.IN_DOUBT } });
    expect(RETRYABLE_CODES.has(CH.IN_DOUBT)).toBe(false);
    gw.upload = async () => {
      calls += 1;
      return { accepted: true, fileId: "f" };
    };
    const again = await t.submitClaim(ctx, s);
    expect(again).toMatchObject({ ok: false, degraded: { code: CH.IN_DOUBT } });
    expect(calls).toBe(1);
  });

  it("a record that cannot be completed after the upload is in doubt, not retryable", async () => {
    const attempts = new InMemoryAttemptStore();
    attempts.complete = async () => {
      throw new Error("db down");
    };
    const anomalies: unknown[] = [];
    const t = new DirectMacTransport({
      attempts,
      gateway: fakeGateway(),
      onAnomaly: (a) => anomalies.push(a),
    });
    const r = await t.submitClaim(
      ctx,
      submission(x12For("claim", "A", "test", "000000006"), "000000006"),
    );
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.IN_DOUBT } });
    expect(anomalies).toEqual([expect.objectContaining({ type: "sent_but_unrecorded" })]);
  });

  it("refuses replacement and void", async () => {
    const t = createHarness().transport;
    const r = await t.submitClaim(ctx, {
      ...submission(x12For("claim", "A", "test", "000000004"), "000000004"),
      adjustment: { kind: "void", originalControlNumber: "000000001" },
    });
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.INVALID_REQUEST } });
  });

  it("answers every method it cannot serve with CH_NOT_WIRED, never a throw", async () => {
    const t = createHarness().transport;
    const results = await Promise.all([
      t.checkEligibility(ctx, { mbi: "x", serviceDate: "2026-01-01" }),
      t.validateOnly(ctx, submission("x")),
      t.fetchRemittances(ctx, null),
      t.fetchClaimStatus(ctx, "1"),
      // even with a full inquiry: the MAC portal has no 276 channel and the repo has no 277 status parser
      t.fetchClaimStatus(ctx, "1", {
        billingProvider: { organizationName: "X", npi: "1234567893" },
        subscriber: { memberId: "m", firstName: "a", lastName: "b", dateOfBirth: "1950-01-01" },
        serviceFrom: "2026-01-01",
        serviceTo: "2026-01-31",
      }),
      t.verifyAndParseEvent({ headers: {}, rawBody: "{}" }),
    ]);
    for (const r of results)
      expect(r).toMatchObject({ ok: false, degraded: { code: CH.NOT_WIRED } });
  });

  describe("fetchAcknowledgments", () => {
    const ack: AckEvent = {
      eventId: "999:f1:000000001",
      stage: "clearinghouse",
      disposition: "accepted",
      controlNumber: "000000001",
      reasonCodes: [],
      occurredAt: "2026-10-11",
    };

    it("returns the gateway's pending events", async () => {
      const gw = fakeGateway();
      gw.acks = [ack];
      const r = await createHarness(gw).transport.fetchAcknowledgments(ctx, null);
      expect(r).toMatchObject({ ok: true, data: { items: [ack], hasMore: false } });
    });

    it("refuses a malformed cursor and reports an outage as retryable", async () => {
      const gw = fakeGateway();
      const t = createHarness(gw).transport;
      expect(await t.fetchAcknowledgments(ctx, "garbage")).toMatchObject({
        ok: false,
        degraded: { code: CH.INVALID_REQUEST },
      });
      gw.outage = true;
      expect(await t.fetchAcknowledgments(ctx, null)).toMatchObject({
        ok: false,
        degraded: { code: CH.UNAVAILABLE },
      });
    });
  });
});

// #714 (S14): a MAC credential the portal REJECTS (401/403) is not an outage: a stable non-retryable code, nothing
// sent, the reservation released so the same submission can go once the credential is fixed.
describe("DirectMacTransport - a rejected MAC credential", () => {
  const SECRET = "mac-secret-sentinel";
  const rejecting = (): FakeGateway => {
    const gw = fakeGateway();
    gw.upload = async () => {
      throw new CredentialRejectedError(`HTTP 401 ${SECRET}`);
    };
    gw.pullAcknowledgments = async () => {
      throw new CredentialRejectedError(`HTTP 403 ${SECRET}`);
    };
    return gw;
  };

  it("submit: CH_NOT_WIRED (not retryable), no secret in the reason, reservation released", async () => {
    const gw = rejecting();
    const t = createHarness(gw).transport;
    const s = {
      kind: "claim" as const,
      controlNumber: "000000077",
      idempotencyKey: "idem-77",
      payload: { format: "x12" as const, x12: x12For("claim", "A", "test", "000000077") },
    };
    const r = await t.submitClaim(ctx, s);
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.NOT_WIRED } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(RETRYABLE_CODES.has(CH.NOT_WIRED)).toBe(false);
    // released, not in doubt: once the credential works the same submission is sent
    gw.upload = async ({ controlNumber }) => {
      gw.uploads.push(controlNumber);
      return { accepted: true, fileId: "f" };
    };
    expect(await t.submitClaim(ctx, s)).toMatchObject({ ok: true });
    expect(gw.uploads).toEqual(["000000077"]);
  });

  it("acknowledgment pull: CH_NOT_WIRED, no secret in the reason", async () => {
    const r = await createHarness(rejecting()).transport.fetchAcknowledgments(ctx, null);
    expect(r).toMatchObject({ ok: false, degraded: { code: CH.NOT_WIRED } });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });
});
