// @chartwarden/x12-835-client — adapter unit tests (Phase 2). The wire→typed mappers fail closed on malformed
// input (degraded envelope, never throw) and map a well-formed sidecar response into the typed structures;
// the fail-closed default client returns a retryable degraded envelope when no transport is wired.
import { describe, expect, it } from "vitest";
import {
  NO_X12_835_PORT,
  type X12835HttpPort,
  createX12835Client,
  mapParsed277ca,
  mapParsed835,
} from "../src/index";

const WELL_FORMED_835 = {
  interchangeControlNumber: "100000001",
  transactionSetControlNumber: "0001",
  checkOrEftTraceNumber: "EFT-77",
  paymentMethod: "eft",
  totalPaymentAmount: 1234.56,
  productionDate: "2026-06-15T00:00:00Z",
  claims: [
    {
      patientControlNumber: "CCN-1",
      payerIcn: "ICN-123",
      statusCode: 1,
      totalCharge: 1000,
      totalPayment: 800,
      patientResponsibility: 50,
      adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 150 }],
      remarks: [{ kind: "MOA", code: "MA01", text: "appeal rights" }],
      serviceLines: [
        {
          procedureCode: "Q5001",
          chargeAmount: 1000,
          paidAmount: 800,
          adjustments: [{ groupCode: "PR", reasonCode: "1", amount: 50 }],
          remarks: [],
        },
      ],
    },
  ],
};

describe("mapParsed835", () => {
  it("maps a well-formed envelope and stamps the payer program", () => {
    const r = mapParsed835(WELL_FORMED_835, "medicare");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.payerProgram).toBe("medicare");
    expect(r.value.checkOrEftTraceNumber).toBe("EFT-77");
    expect(r.value.claims).toHaveLength(1);
    const claim = r.value.claims[0]!;
    expect(claim.payerIcn).toBe("ICN-123");
    expect(claim.adjustments[0]).toMatchObject({ groupCode: "CO", reasonCode: "45", amount: 150 });
    expect(claim.serviceLines[0]!.adjustments[0]!.groupCode).toBe("PR");
    expect(claim.remarks[0]!.code).toBe("MA01");
  });

  it("drops invalid adjustment group codes but keeps the claim", () => {
    const wire = {
      ...WELL_FORMED_835,
      claims: [
        {
          ...WELL_FORMED_835.claims[0],
          adjustments: [{ groupCode: "ZZ", reasonCode: "1", amount: 5 }],
        },
      ],
    };
    const r = mapParsed835(wire, "medicare");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.claims[0]!.adjustments).toHaveLength(0);
  });

  it("fails closed (non-retryable) on a missing control number", () => {
    const r = mapParsed835({ ...WELL_FORMED_835, interchangeControlNumber: "" }, "medicare");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.code).toBe("X12_835_PARSE_FAILED");
    expect(r.degraded.retryable).toBe(false);
    expect(r.degraded.operation).toBe("parse835");
  });

  it("fails closed on an invalid payment method", () => {
    const r = mapParsed835({ ...WELL_FORMED_835, paymentMethod: "wire-transfer" }, "medicaid");
    expect(r.ok).toBe(false);
  });
});

describe("mapParsed277ca", () => {
  it("maps rejections and skips incomplete ones", () => {
    const r = mapParsed277ca({
      interchangeControlNumber: "1",
      transactionSetControlNumber: "1",
      rejections: [
        { patientControlNumber: "CCN-1", statusCategoryCode: "A3", statusCode: "16" },
        { patientControlNumber: "CCN-2" }, // incomplete → dropped
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rejections).toHaveLength(1);
    expect(r.value.rejections[0]!.statusCode).toBe("16");
  });
});

describe("createX12835Client (fail-closed default)", () => {
  it("returns a retryable transport degrade when no sidecar is wired", async () => {
    const client = createX12835Client(NO_X12_835_PORT);
    const r = await client.parse835({ minioObjectKey: "era/x.835", payerProgram: "medicare" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.code).toBe("X12_835_TRANSPORT");
    expect(r.degraded.retryable).toBe(true);
  });

  it("maps a 2xx sidecar body through the parser", async () => {
    const port: X12835HttpPort = {
      request: () => Promise.resolve({ status: 200, body: WELL_FORMED_835 }),
    };
    const client = createX12835Client(port);
    const r = await client.parse835({ minioObjectKey: "era/x.835", payerProgram: "medicare" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.claims).toHaveLength(1);
  });

  it("treats a 5xx as a retryable transport degrade", async () => {
    const port: X12835HttpPort = {
      request: () => Promise.resolve({ status: 503, body: null }),
    };
    const r = await createX12835Client(port).parse835({
      minioObjectKey: "k",
      payerProgram: "medicare",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.retryable).toBe(true);
  });
});
