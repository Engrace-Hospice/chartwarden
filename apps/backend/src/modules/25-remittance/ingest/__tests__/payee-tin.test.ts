// #671 — payee TIN compare, the tax-id-only policy, and one-pass receive. No DB: every refusal returns before it.
import { createHash } from "node:crypto";
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import { parsePayeeTinPolicy } from "../payee-tin-policy";
import {
  type PayeeTinLookup,
  type PayeeTinPolicy,
  buildDrizzleM25IngestService,
} from "../service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const PE = "22222222-2222-4222-8222-222222222222";
const RAW =
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *250101*1200*^*00501*000000001*0*P*:~ST*835*0001~";
const NPI = "1234567893";

function advice(payee: ParsedRemittanceAdvice["payee"]): ParsedRemittanceAdvice {
  return {
    payerProgram: "medicaid",
    interchangeControlNumber: "000000001",
    transactionSetControlNumber: "0001",
    paymentMethod: "eft",
    totalPaymentAmount: 0,
    productionDate: "2026-06-15",
    payee,
    claims: [],
  };
}

const noMore = async () => {
  throw new Error("unused");
};

function receive(
  payee: ParsedRemittanceAdvice["payee"],
  tin: PayeeTinLookup | undefined,
  policy?: PayeeTinPolicy,
  payerKind: "medicare" | "medicaid" = "medicaid",
  client?: X12835WorkerClient,
) {
  const service = buildDrizzleM25IngestService({} as never, {
    client: client ?? {
      parse835: async () => ({ ok: true, value: advice(payee) }),
      parse277ca: noMore,
    },
    payeeNpi: async () => NPI,
    ...(tin ? { payeeTin: tin } : {}),
    ...(policy ? { payeeTinPolicy: policy } : {}),
  });
  return service.receiveAdvice(
    { organizationId: ORG },
    {
      providerEntityId: PE,
      payerId: PE,
      payerKind,
      minioObjectKey: "k",
      fileSha256: createHash("sha256").update(RAW, "utf8").digest("hex"),
      rawEdi: RAW,
    },
  );
}

describe("835 payee TIN (#671)", () => {
  const npiPayee = { name: "X", idQualifier: "XX", id: NPI };
  const fiPayee = { name: "X", idQualifier: "FI", id: "123456789" };
  const allowMedicaid = parsePayeeTinPolicy(JSON.stringify({ [ORG]: ["medicaid"] }));

  it("refuses an NPI-matching payee whose REF*TJ is not the tenant's TIN", async () => {
    const r = await receive({ ...npiPayee, taxId: "999-99-9999" }, async () => "12-3456789");
    expect(r).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("tax id is not"),
    });
  });
  it("fails closed, without echoing the TIN, when the sealed TIN cannot be opened", async () => {
    const r = await receive({ ...npiPayee, taxId: "123456789" }, async () => {
      throw new Error("DEK for 123456789 unavailable");
    });
    expect(r).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("could not be read"),
    });
    expect(JSON.stringify(r)).not.toContain("123456789");
  });
  it("refuses a tax-id-only payee by default even with a matching TIN bound", async () => {
    const r = await receive(fiPayee, async () => "123456789");
    expect(r).toMatchObject({ outcome: "malformed", reason: expect.stringContaining("no NPI") });
  });
  it("refuses a tax-id-only payee when the policy does not cover this payer program", async () => {
    const r = await receive(fiPayee, async () => "123456789", allowMedicaid, "medicare");
    expect(r).toMatchObject({ outcome: "malformed", reason: expect.stringContaining("no NPI") });
  });
  it("on an allowed program refuses a wrong or unreadable TIN", async () => {
    expect(await receive(fiPayee, async () => "987654321", allowMedicaid)).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("tax id is not"),
    });
    const unreadable = await receive(
      fiPayee,
      async () => {
        throw new Error("x");
      },
      allowMedicaid,
    );
    expect(unreadable).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("could not be read"),
    });
  });
  it("on an allowed program an exact TIN match passes the payee check (proceeds to the db)", async () => {
    // The db stub is `{}`: reaching it throws, which proves the payee check let the file through.
    await expect(receive(fiPayee, async () => "12-3456789", allowMedicaid)).rejects.toThrow();
  });
  it("policy is tenant-scoped and default-deny", () => {
    const policy = parsePayeeTinPolicy(JSON.stringify({ [OTHER_ORG]: ["medicaid"] }));
    expect(policy(ORG, "medicaid")).toBe(false);
    expect(policy(OTHER_ORG, "medicaid")).toBe(true);
    expect(policy(OTHER_ORG, "medicare")).toBe(false);
    expect(parsePayeeTinPolicy(undefined)(ORG, "medicaid")).toBe(false);
  });
  it("rejects a malformed policy loudly", () => {
    expect(() => parsePayeeTinPolicy("{")).toThrow();
    expect(() => parsePayeeTinPolicy(JSON.stringify({ nope: ["medicaid"] }))).toThrow();
    expect(() => parsePayeeTinPolicy(JSON.stringify({ [ORG]: ["cash"] }))).toThrow();
  });
});

describe("receive parses once per file (#671)", () => {
  it("uses parse835All instead of one parse835 per ST02", async () => {
    let singles = 0;
    let alls = 0;
    const client: X12835WorkerClient = {
      parse835: async () => {
        singles += 1;
        return { ok: true, value: advice({ name: "X", idQualifier: "XX", id: NPI }) };
      },
      parse835All: async () => {
        alls += 1;
        return { ok: true, value: [advice({ name: "X", idQualifier: "XX", id: "1999999984" })] };
      },
      parse277ca: noMore,
    };
    const r = await receive(undefined, undefined, undefined, "medicare", client);
    expect(r).toMatchObject({ outcome: "malformed" });
    expect([singles, alls]).toEqual([0, 1]);
  });
});
