// GAP-032 - the wording of the emergency-terminus status lines (pure, DOM-free).
import { describe, expect, it } from "vitest";
import { describeTerminus } from "./terminus-status";

const row = (
  actionKind: string,
  status: string,
  outcomeCode: string | null,
  loopIteration = 0,
  attemptNo = 0,
) => ({ actionKind, status, outcomeCode, loopIteration, attemptNo });

describe("describeTerminus", () => {
  it("says 'not yet recorded' for an effect with no row", () => {
    const lines = describeTerminus([]);
    expect(lines.map((l) => l.text)).toEqual([
      "not yet recorded",
      "not yet recorded",
      "not yet recorded",
    ]);
  });

  it("reports success plainly", () => {
    const lines = describeTerminus([
      row("page_ops", "succeeded", "ok"),
      row("dial_contact", "succeeded", "ok"),
      row("resolve_psap", "succeeded", "ok"),
    ]);
    expect(lines.every((l) => l.tone === "ok")).toBe(true);
    expect(lines[1]?.text).toBe("call placed to the emergency contact");
  });

  it("gives the honest reason when an effect did not happen", () => {
    const lines = describeTerminus([
      row("page_ops", "skipped", "pager_unbound"),
      row("dial_contact", "skipped", "consent_absent"),
      row("resolve_psap", "skipped", "jurisdiction_none"),
    ]);
    expect(lines.map((l) => l.tone)).toEqual(["problem", "problem", "problem"]);
    expect(lines[0]?.text).toContain("no ops pager is configured");
    expect(lines[1]?.text).toContain("has not consented");
    expect(lines[2]?.text).toContain("no PSAP line is on file");
  });

  it("uses the newest iteration and attempt of each effect", () => {
    const lines = describeTerminus([
      row("page_ops", "failed", "receiver_non_2xx", 0),
      row("page_ops", "succeeded", "ok", 2),
      row("dial_contact", "failed", "vendor_refused", 0, 0),
      row("dial_contact", "pending", null, 2, 1),
    ]);
    expect(lines[0]?.tone).toBe("ok");
    expect(lines[1]?.tone).toBe("pending");
  });

  it("never prints a raw code it does not know as an empty string", () => {
    expect(describeTerminus([row("page_ops", "failed", "brand_new_code")])[0]?.text).toContain(
      "brand_new_code",
    );
  });
});
