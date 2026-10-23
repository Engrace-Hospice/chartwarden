// @chartwarden/x12-835-client — adapter unit tests (Phase 2). The wire→typed mappers fail closed on malformed
// input (degraded envelope, never throw) and map a well-formed sidecar response into the typed structures;
// the 277CA path still fails closed when no transport is wired. 835 parsing is covered in parse-x12-835.test.ts.
import { describe, expect, it } from "vitest";
import {
  NO_X12_835_PORT,
  type X12835HttpPort,
  createX12835Client,
  mapParsed277ca,
} from "../src/index";

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

describe("createX12835Client (277CA sidecar port, fail-closed default)", () => {
  it("returns a retryable transport degrade for 277CA when no sidecar is wired", async () => {
    const r = await createX12835Client({ port: NO_X12_835_PORT }).parse277ca({
      minioObjectKey: "era/x.277",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.code).toBe("X12_277CA_TRANSPORT");
    expect(r.degraded.retryable).toBe(true);
  });

  it("treats a 5xx as a retryable transport degrade", async () => {
    const port: X12835HttpPort = { request: () => Promise.resolve({ status: 503, body: null }) };
    const r = await createX12835Client({ port }).parse277ca({ minioObjectKey: "k" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.retryable).toBe(true);
  });
});
