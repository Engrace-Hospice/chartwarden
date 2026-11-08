import { createHash } from "node:crypto";
import type { ParsedRemittanceAdvice, X12835WorkerClient } from "@chartwarden/x12-835-client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _context: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(_db),
}));

import { buildDrizzleM25IngestService } from "../service-drizzle";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROVIDER = "22222222-2222-4222-8222-222222222222";
const RAW =
  "ISA*00*          *00*          *ZZ*SENDERID       *ZZ*RECEIVERID     *250101*1200*^*00501*000000001*0*P*:~ST*835*0001~";

function advice(): ParsedRemittanceAdvice {
  return {
    payerProgram: "medicare",
    interchangeControlNumber: "000000001",
    transactionSetControlNumber: "0001",
    paymentMethod: "eft",
    totalPaymentAmount: 10,
    productionDate: "2026-06-15",
    checkOrEftTraceNumber: "SYNTH-TRACE-1",
    payee: { name: "SYNTHETIC", idQualifier: "XX", id: "1999999999" },
    claims: [],
  };
}

describe("M25 legacy intake vs Claim.MD stage identity", () => {
  it("refuses to create a posting-capable advice/event when a Claim.MD stage owns the identity", async () => {
    const outbox = { publish: vi.fn(async () => undefined) };
    const query = {
      from: () => query,
      where: () => query,
      limit: async () => [{ id: "00000000-0000-4000-8000-000000000104" }],
    };
    const tx = { execute: vi.fn(async () => undefined), select: vi.fn(() => query) };
    const db = Object.assign(tx, {
      transaction: async (fn: (value: any) => Promise<unknown>) => fn(tx),
    });
    const client: X12835WorkerClient = {
      parse835: async () => ({ ok: true, value: advice() }),
      parse277ca: async () => {
        throw new Error("unused");
      },
    };
    const service = buildDrizzleM25IngestService(db as never, {
      client,
      outbox,
      payeeNpi: async () => "1999999999",
    });
    const result = await service.receiveAdvice(
      { organizationId: ORG },
      {
        providerEntityId: PROVIDER,
        payerId: PROVIDER,
        payerKind: "medicare",
        minioObjectKey: "synthetic-key",
        fileSha256: createHash("sha256").update(RAW).digest("hex"),
        rawEdi: RAW,
      },
    );
    expect(result).toEqual({
      outcome: "review_required",
      stageId: "00000000-0000-4000-8000-000000000104",
      reason: "CLAIMMD_ERA_STAGE_MATCH",
    });
    expect(tx.execute).toHaveBeenCalledOnce();
    expect(outbox.publish).not.toHaveBeenCalled();
  });
});
