// The MAC's own date for a notice's answer: the 277CA STC02 status effective date; for a 999 (which has none)
// the functional group date GS04, else the interchange date ISA09; else our receipt time — always with its source.
import { describe, expect, it } from "vitest";
import { resolvePayerStatusDate } from "../src/notice";

const receivedAt = new Date("2026-03-09T14:00:00.000Z");

describe("resolvePayerStatusDate", () => {
  it("uses the 277CA STC02 status effective date", () => {
    expect(
      resolvePayerStatusDate({ kind: "ack_277ca", statusEffectiveDate: "2026-03-07", receivedAt }),
    ).toEqual({ date: "2026-03-07", source: "277ca_stc02" });
  });

  it("uses the 999 GS04 functional group date", () => {
    expect(
      resolvePayerStatusDate({
        kind: "ack_999",
        functionalGroupDate: "2026-03-08",
        interchangeDate: "2026-03-01",
        receivedAt,
      }),
    ).toEqual({ date: "2026-03-08", source: "999_gs04" });
  });

  it("falls back to the 999 ISA09 interchange date when GS04 is absent", () => {
    expect(
      resolvePayerStatusDate({ kind: "ack_999", interchangeDate: "2026-03-08", receivedAt }),
    ).toEqual({ date: "2026-03-08", source: "999_isa09" });
  });

  it("ignores a 999 date on a 277CA and vice versa", () => {
    expect(
      resolvePayerStatusDate({ kind: "ack_277ca", functionalGroupDate: "2026-03-08", receivedAt }),
    ).toEqual({ date: "2026-03-09", source: "receipt" });
    expect(
      resolvePayerStatusDate({ kind: "ack_999", statusEffectiveDate: "2026-03-08", receivedAt }),
    ).toEqual({ date: "2026-03-09", source: "receipt" });
  });

  it("falls back to the receipt date when the payer date is missing or malformed", () => {
    expect(resolvePayerStatusDate({ kind: "ack_277ca", receivedAt })).toEqual({
      date: "2026-03-09",
      source: "receipt",
    });
    expect(
      resolvePayerStatusDate({ kind: "ack_277ca", statusEffectiveDate: "20260307", receivedAt }),
    ).toEqual({ date: "2026-03-09", source: "receipt" });
  });

  it("reads our receipt time as an Eastern calendar day (8 pm Eastern on day 5 stays day 5)", () => {
    expect(
      resolvePayerStatusDate({
        kind: "ack_277ca",
        receivedAt: new Date("2026-03-06T01:00:00.000Z"),
      }),
    ).toEqual({ date: "2026-03-05", source: "receipt" });
  });

  it("distrusts a payer date after the day we received the answer", () => {
    expect(
      resolvePayerStatusDate({ kind: "ack_277ca", statusEffectiveDate: "2026-03-11", receivedAt }),
    ).toEqual({ date: "2026-03-09", source: "receipt" });
  });
});
