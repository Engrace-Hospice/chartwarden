// #659 — an 835 addressed to another provider is refused before anything is stored. receiveAdvice returns
// before it touches the database, so the refusal needs no live DB (the post-time refusal is in the live suite).
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import { buildDrizzleM25IngestService } from "../service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const RAW =
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *250101*1200*^*00501*000000001*0*P*:~ST*835*0001~";

function advice(payee: ParsedRemittanceAdvice["payee"]): ParsedRemittanceAdvice {
  return {
    payerProgram: "medicare",
    interchangeControlNumber: "000000001",
    transactionSetControlNumber: "0001",
    paymentMethod: "eft",
    totalPaymentAmount: 0,
    productionDate: "2026-06-15",
    payee,
    claims: [],
  };
}

function receive(payee: ParsedRemittanceAdvice["payee"], tenantNpi: string | null) {
  const client: X12835WorkerClient = {
    parse835: async () => ({ ok: true, value: advice(payee) }),
    parse277ca: async () => {
      throw new Error("unused");
    },
  };
  // The db is never reached on a refusal; a wrong refusal path would throw on it.
  const service = buildDrizzleM25IngestService({} as never, {
    client,
    payeeNpi: async () => tenantNpi,
  });
  return service.receiveAdvice(
    { organizationId: ORG },
    {
      providerEntityId: PE,
      payerId: PE,
      payerKind: "medicare",
      minioObjectKey: "k",
      fileSha256: "a".repeat(64),
      rawEdi: RAW,
    },
  );
}

describe("835 payee identity (#659)", () => {
  it("refuses a payee NPI that is not the provider entity's", async () => {
    const r = await receive({ name: "OTHER", idQualifier: "XX", id: "1999999984" }, "1234567893");
    expect(r).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("not this provider"),
    });
  });
  it("refuses a payee with no NPI (tax-id qualifier only)", async () => {
    const r = await receive({ name: "X", idQualifier: "FI", id: "123456789" }, "1234567893");
    expect(r).toMatchObject({ outcome: "malformed", reason: expect.stringContaining("no NPI") });
  });
  it("refuses a file with no payee loop", async () => {
    const r = await receive(undefined, "1234567893");
    expect(r).toMatchObject({ outcome: "malformed" });
  });
  it("refuses when the provider entity has no NPI on file", async () => {
    const r = await receive({ name: "X", idQualifier: "XX", id: "1234567893" }, null);
    expect(r).toMatchObject({
      outcome: "malformed",
      reason: expect.stringContaining("no NPI on file"),
    });
  });
});
