// CW-PI-03 — a set that carries a segment the parser does not model is refused whole at receive (nothing stored, a
// content refusal that counts toward the pull's quarantine cap). receiveAdvice returns before it touches the database
// on a refusal, so no live DB is needed (the post-time refusal and the stored-nothing assertion are in m25-835-ingestion).
import { createHash } from "node:crypto";
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import { buildDrizzleM25IngestService, unrecognisedSegmentsReason } from "../service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const RAW =
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *250101*1200*^*00501*000000001*0*P*:~ST*835*0001~";
// Two synthetic, Luhn-valid NPIs: the tenant's own, and another tenant's.
const OWN_NPI = "1234567893";
const OTHER_TENANT_NPI = "1999999984";

function advice(over: Partial<ParsedRemittanceAdvice>): ParsedRemittanceAdvice {
  return {
    payerProgram: "medicare",
    interchangeControlNumber: "000000001",
    transactionSetControlNumber: "0001",
    paymentMethod: "eft",
    totalPaymentAmount: 12.5,
    paymentEffectiveDate: "2026-06-15",
    productionDate: null,
    payee: { name: "Synthetic Hospice", idQualifier: "XX", id: OWN_NPI },
    claims: [],
    ...over,
  };
}

// The same interchange with a second transaction set (ST02 0002).
const RAW_TWO_SETS = `${RAW}SE*1*0001~ST*835*0002~`;

function receive(parsed: ParsedRemittanceAdvice, sets?: ParsedRemittanceAdvice[]) {
  const client: X12835WorkerClient = {
    parse835: async () => ({ ok: true, value: parsed }),
    ...(sets ? { parse835All: async () => ({ ok: true as const, value: sets }) } : {}),
    parse277ca: async () => {
      throw new Error("unused");
    },
  };
  const rawEdi = sets ? RAW_TWO_SETS : RAW;
  // The db is never reached on a refusal; a wrong path would throw on it.
  const service = buildDrizzleM25IngestService({} as never, {
    client,
    payeeNpi: async () => OWN_NPI,
  });
  return service.receiveAdvice(
    { organizationId: ORG },
    {
      providerEntityId: PE,
      payerId: PE,
      payerKind: "medicare",
      objectKey: "k",
      fileSha256: createHash("sha256").update(rawEdi, "utf8").digest("hex"),
      rawEdi,
    },
  );
}

const segment = (segmentId: string) => ({ segmentId, elements: ["SYNTHETIC-VALUE"] });

describe("835 segments the parser does not model, at receive", () => {
  it("refuses the file as malformed content and names the segment ids only", async () => {
    const result = await receive(advice({ unknownSegments: [segment("TS3"), segment("CUR")] }));

    expect(result).toMatchObject({ outcome: "malformed", cause: "content" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("TS3, CUR");
    expect(reason).not.toContain("SYNTHETIC-VALUE");
  });

  it("refuses a zero-dollar advice too: no money moving is not a reason to post what was not understood", async () => {
    const result = await receive(
      advice({
        unknownSegments: [segment("ZZZ")],
        totalPaymentAmount: 0,
        paymentEffectiveDate: null,
      }),
    );

    expect(result).toMatchObject({ outcome: "malformed", cause: "content" });
    expect((result as { reason: string }).reason).toMatch(/does not model \(ZZZ\)/);
  });

  it("does not refuse a set with no unrecognised segment for its content (it is judged on its payee)", async () => {
    const result = await receive(
      advice({
        unknownSegments: [],
        payee: { name: "X", idQualifier: "XX", id: OTHER_TENANT_NPI },
      }),
    );

    expect((result as { reason: string }).reason).toMatch(/payee check/);
  });

  it("judges the payee first: another tenant's file with an unrecognised segment stays an environment refusal (pinned and loud, never quarantined)", async () => {
    const result = await receive(
      advice({
        unknownSegments: [segment("TS3")],
        payee: { name: "X", idQualifier: "XX", id: OTHER_TENANT_NPI },
      }),
    );

    expect(result).toMatchObject({ outcome: "malformed", cause: "environment" });
    expect((result as { reason: string }).reason).toMatch(/not this provider entity's/);
    expect((result as { reason: string }).reason).not.toContain("TS3");
  });
});

describe("an unrecognised segment in one set of a several-set file", () => {
  const own = advice({ unknownSegments: [segment("TS3")] });
  const otherTenants = advice({
    transactionSetControlNumber: "0002",
    payee: { name: "X", idQualifier: "XX", id: OTHER_TENANT_NPI },
  });

  it("still lets a later set's wrong payee decide: the file stays an environment refusal", async () => {
    const result = await receive(own, [own, otherTenants]);

    expect(result).toMatchObject({ outcome: "malformed", cause: "environment" });
    expect((result as { reason: string }).reason).toMatch(/not this provider entity's/);
  });

  it("refuses as content, naming the segment ids, when every set is this payee's", async () => {
    const second = advice({ transactionSetControlNumber: "0002" });
    const result = await receive(own, [own, second]);

    expect(result).toMatchObject({ outcome: "malformed", cause: "content" });
    expect((result as { reason: string }).reason).toMatch(/does not model \(TS3\)/);
  });
});

describe("unrecognisedSegmentsReason", () => {
  it("is null for a set with none", () => {
    expect(unrecognisedSegmentsReason(advice({}))).toBeNull();
    expect(unrecognisedSegmentsReason(advice({ unknownSegments: [] }))).toBeNull();
  });

  it("lists each id once, in file order, and truncates a long list", () => {
    const ids = ["AA1", "AA1", "BB2", "CC3", "DD4", "EE5", "FF6", "GG7", "HH8", "II9"];
    const reason = unrecognisedSegmentsReason(advice({ unknownSegments: ids.map(segment) }));

    expect(reason).toContain("(AA1, BB2, CC3, DD4, EE5, FF6, GG7, HH8, ...)");
  });
});
