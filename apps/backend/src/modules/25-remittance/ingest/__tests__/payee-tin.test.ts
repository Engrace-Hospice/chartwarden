// #671 — payee TIN compare, the tax-id-only policy, and one-pass receive. No DB: every refusal returns before it.
import { createHash } from "node:crypto";
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import {
  type PayeeNpiLookup,
  type PayeeTinLookup,
  buildDrizzleM25IngestService,
  normaliseTin,
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
    paymentEffectiveDate: "2026-06-15",
    adjudicationCutoffDate: null,
    functionalGroupCreationDate: "2026-06-16",
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
  payerKind: "medicare" | "medicaid" = "medicaid",
  client?: X12835WorkerClient,
  npiLookup: PayeeNpiLookup = async () => NPI,
  organizationId = ORG,
  providerEntityId = PE,
) {
  const service = buildDrizzleM25IngestService({} as never, {
    client: client ?? {
      parse835: async () => ({ ok: true, value: advice(payee) }),
      parse277ca: noMore,
    },
    payeeNpi: npiLookup,
    ...(tin ? { payeeTin: tin } : {}),
  });
  return service.receiveAdvice(
    { organizationId },
    {
      providerEntityId,
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
  it("rejects TIN-only identity even when the TIN matches; no approved payer-program policy exists", async () => {
    const r = await receive(fiPayee, async () => "12-3456789", "medicaid");
    expect(r).toMatchObject({ outcome: "malformed", reason: expect.stringContaining("no NPI") });
  });

  it("normalizes only bare nine-digit, EIN, or SSN forms", () => {
    expect(normaliseTin("123456789")).toBe("123456789");
    expect(normaliseTin("12-3456789")).toBe("123456789");
    expect(normaliseTin("123-45-6789")).toBe("123456789");
    expect(normaliseTin("12/3456789")).toBeNull();
    expect(normaliseTin("TIN:123456789")).toBeNull();
    expect(normaliseTin("1-23456789")).toBeNull();
  });

  it("rejects malformed NPIs and refuses REF*TJ when no secure TIN seam is bound", async () => {
    expect(await receive({ ...npiPayee, id: "1234567890" }, async () => NPI)).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("NPI is invalid"),
    });
    expect(await receive({ ...npiPayee, taxId: "123456789" }, undefined)).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("no tax id lookup"),
    });
    expect(
      await receive(npiPayee, undefined, "medicaid", undefined, async () => "1234567890"),
    ).toMatchObject({ outcome: "malformed", reason: expect.stringContaining("no valid NPI") });
  });

  it("queries authoritative NPI using the authenticated organization and selected provider", async () => {
    let seen: readonly [string, string] | undefined;
    await expect(
      receive(
        npiPayee,
        undefined,
        "medicaid",
        undefined,
        async (organizationId, providerEntityId) => {
          seen = [organizationId, providerEntityId];
          return NPI;
        },
        OTHER_ORG,
        "44444444-4444-4444-8444-444444444444",
      ),
    ).rejects.toThrow();
    expect(seen).toEqual([OTHER_ORG, "44444444-4444-4444-8444-444444444444"]);
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
    const r = await receive(undefined, undefined, "medicare", client);
    expect(r).toMatchObject({ outcome: "malformed" });
    expect([singles, alls]).toEqual([0, 1]);
  });
});
