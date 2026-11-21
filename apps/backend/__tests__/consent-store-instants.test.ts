// The two instants M39's DB store hands the evaluator for a `historical` read ("what was on file at that instant"): when the record came to be on
// file (`recordedAtMs`) and when it stopped being active (`endedAtMs`). Both come from the row's own server-set columns, never from the caller's
// payload. A draft created before a visit and signed after it was NOT on file at the visit, so the entry instant is the later of the row's
// creation and its signature (ADR-0114 S2b, VN-D36).
import { describe, expect, it } from "vitest";
import { endedAtMsOf, recordedAtMsOf } from "../src/modules/39-consent/consent-store-db";

const at = (iso: string) => new Date(iso);
const row = (over: Record<string, unknown>) => over as never;

describe("recordedAtMsOf (when the consent came to be on file)", () => {
  it("is the signature when the draft was created earlier and signed later", () => {
    expect(
      recordedAtMsOf(
        row({ createdAt: at("2026-01-15T09:00:00Z"), signedAt: at("2026-01-18T10:00:00Z") }),
      ),
    ).toBe(at("2026-01-18T10:00:00Z").getTime());
  });

  it("is the creation when it is the later of the two (an entry made after its recorded signature)", () => {
    expect(
      recordedAtMsOf(
        row({ createdAt: at("2026-01-20T09:00:00Z"), signedAt: at("2026-01-10T10:00:00Z") }),
      ),
    ).toBe(at("2026-01-20T09:00:00Z").getTime());
  });

  it("is unknown (null, so a historical read fails closed) when the row was never signed", () => {
    expect(
      recordedAtMsOf(row({ createdAt: at("2026-01-15T09:00:00Z"), signedAt: null })),
    ).toBeNull();
  });
});

describe("endedAtMsOf (when the consent stopped being active)", () => {
  it("is the revocation, the supersession, or the earlier of expiry and last update; null while active", () => {
    expect(endedAtMsOf(row({ status: "revoked", revokedAt: at("2026-02-01T00:00:00Z") }))).toBe(
      at("2026-02-01T00:00:00Z").getTime(),
    );
    expect(
      endedAtMsOf(row({ status: "superseded", supersededAt: at("2026-03-01T00:00:00Z") })),
    ).toBe(at("2026-03-01T00:00:00Z").getTime());
    expect(
      endedAtMsOf(
        row({
          status: "expired",
          expiresAt: at("2027-01-01T00:00:00Z"),
          updatedAt: at("2026-04-01T00:00:00Z"),
        }),
      ),
    ).toBe(at("2026-04-01T00:00:00Z").getTime());
    expect(endedAtMsOf(row({ status: "active" }))).toBeNull();
  });
});
