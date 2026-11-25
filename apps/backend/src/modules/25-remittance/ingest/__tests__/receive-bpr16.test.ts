// A non-zero 835 payment with no BPR16 is refused at receive (nothing stored): it would be stored with no
// payment date and silently drop out of every net-collections period and the appeal clock. receiveAdvice
// returns before it touches the database on a refusal, so no live DB is needed (live case: m25-835-ingestion).
import { createHash } from "node:crypto";
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it } from "vitest";
import { buildDrizzleM25IngestService } from "../service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE = "22222222-2222-4222-8222-222222222222";
const RAW =
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *250101*1200*^*00501*000000001*0*P*:~ST*835*0001~";

function advice(over: Partial<ParsedRemittanceAdvice>): ParsedRemittanceAdvice {
  return {
    payerProgram: "medicare",
    interchangeControlNumber: "000000001",
    transactionSetControlNumber: "0001",
    paymentMethod: "eft",
    totalPaymentAmount: 12.5,
    paymentEffectiveDate: null,
    productionDate: null,
    payee: { name: "Synthetic Hospice", idQualifier: "XX", id: "1999999984" },
    claims: [],
    ...over,
  };
}

function receive(parsed: ParsedRemittanceAdvice) {
  const client: X12835WorkerClient = {
    parse835: async () => ({ ok: true, value: parsed }),
    parse277ca: async () => {
      throw new Error("unused");
    },
  };
  // The db is never reached on a refusal; a wrong path would throw on it.
  const service = buildDrizzleM25IngestService({} as never, {
    client,
    payeeNpi: async () => "1234567893",
  });
  return service.receiveAdvice(
    { organizationId: ORG },
    {
      providerEntityId: PE,
      payerId: PE,
      payerKind: "medicare",
      objectKey: "k",
      fileSha256: createHash("sha256").update(RAW, "utf8").digest("hex"),
      rawEdi: RAW,
    },
  );
}

describe("835 payment date (BPR16) at receive", () => {
  it("refuses a non-zero payment with no BPR16 as malformed content", async () => {
    const result = await receive(advice({ paymentEffectiveDate: null, totalPaymentAmount: 12.5 }));

    expect(result).toMatchObject({ outcome: "malformed", cause: "content" });
    expect((result as { reason: string }).reason).toMatch(/BPR16/);
  });

  it("refuses a negative (recoupment) payment with no BPR16 too", async () => {
    const result = await receive(advice({ paymentEffectiveDate: null, totalPaymentAmount: -12.5 }));

    expect(result).toMatchObject({ outcome: "malformed", cause: "content" });
    expect((result as { reason: string }).reason).toMatch(/BPR16/);
  });

  it("does not refuse a zero-dollar advice for the missing date (it reaches the payee check)", async () => {
    // The payee NPI mismatches, so the refusal that comes back is the payee one, not BPR16's.
    const result = await receive(advice({ paymentEffectiveDate: null, totalPaymentAmount: 0 }));

    expect(result).toMatchObject({ outcome: "malformed" });
    expect((result as { reason: string }).reason).toMatch(/payee check/);
  });

  it("does not refuse a dated non-zero payment for the date (it reaches the payee check)", async () => {
    const result = await receive(
      advice({ paymentEffectiveDate: "2026-06-15", totalPaymentAmount: 12.5 }),
    );

    expect(result).toMatchObject({ outcome: "malformed" });
    expect((result as { reason: string }).reason).toMatch(/payee check/);
  });
});
