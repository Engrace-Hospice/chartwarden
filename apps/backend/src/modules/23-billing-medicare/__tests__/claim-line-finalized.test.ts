// GAP-077 — the m23.claim.line_finalized producer: only paid inpatient (0655/0656) lines, with the field
// set M26's `handleInpatientDay` reads, and a payload that validates against the catalog schema.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { M23_OUTBOX_EVENTS } from "../events-by-m23";
import { buildClaimLineFinalizedEmissions } from "../outbox-consumers/claim-line-finalized";

const line = (id: string, revenueCode: string, unitCount: number) =>
  ({
    id,
    revenueCode,
    serviceDateFrom: "2026-01-05",
    serviceDateTo: "2026-01-07",
    unitCount,
  }) as never;

describe("buildClaimLineFinalizedEmissions", () => {
  const base = {
    organizationId: "o1",
    claimId: "c1",
    patientId: "p1",
    finalizedAt: "2026-02-01T00:00:00.000Z",
  };

  it("emits one event per 0655/0656 line and skips every other revenue code", () => {
    const out = buildClaimLineFinalizedEmissions({
      ...base,
      lines: [line("l1", "0651", 30), line("l2", "0656", 3), line("l3", "0655", 2)],
    });
    expect(out.map((e) => e.aggregateId)).toEqual(["l2", "l3"]);
    expect(out[0]?.payload).toMatchObject({
      claimId: "c1",
      claimLineId: "l2",
      revenueCode: "0656",
      patientId: "p1",
      serviceFrom: "2026-01-05",
      serviceTo: "2026-01-07",
      days: 3,
    });
  });

  it("skips a zero-day line", () => {
    expect(buildClaimLineFinalizedEmissions({ ...base, lines: [line("l1", "0656", 0)] })).toEqual(
      [],
    );
  });

  it("produces a payload the catalogued schema accepts", () => {
    const entry = M23_OUTBOX_EVENTS.find((e) => e.eventName === "m23.claim.line_finalized");
    const [emission] = buildClaimLineFinalizedEmissions({
      ...base,
      lines: [line("l2", "0656", 3)],
    });
    expect(entry).toBeDefined();
    expect(Value.Check(entry?.payloadSchema as never, emission?.payload)).toBe(true);
  });
});
