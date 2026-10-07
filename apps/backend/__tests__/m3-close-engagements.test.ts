// GAP-011 — the authz.close_engagements transition rule (M3 spec §2.3.3 / §4.5.1).
import { describe, expect, it } from "vitest";
import { planEngagementTransition } from "../src/modules/03-authorization/jobs/close-engagements";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("planEngagementTransition", () => {
  it("activates a scheduled engagement whose window has opened", () => {
    expect(
      planEngagementTransition(
        {
          status: "scheduled",
          startAt: at("2026-10-05T00:00:00Z"),
          endAt: at("2026-11-01T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("activate");
  });

  it("leaves a scheduled engagement in the future alone", () => {
    expect(
      planEngagementTransition(
        {
          status: "scheduled",
          startAt: at("2026-10-06T00:00:00Z"),
          endAt: at("2026-11-01T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("none");
  });

  it("closes an active engagement at end_at (inclusive)", () => {
    expect(
      planEngagementTransition(
        {
          status: "active",
          startAt: at("2026-09-01T00:00:00Z"),
          endAt: at("2026-10-05T12:00:00Z"),
        },
        NOW,
      ),
    ).toBe("close");
  });

  it("closes a scheduled engagement that was never activated before its window ended", () => {
    expect(
      planEngagementTransition(
        {
          status: "scheduled",
          startAt: at("2026-09-01T00:00:00Z"),
          endAt: at("2026-09-02T00:00:00Z"),
        },
        NOW,
      ),
    ).toBe("close");
  });

  it("never touches a closed or cancelled engagement (idempotent)", () => {
    for (const status of ["closed", "cancelled"] as const) {
      expect(
        planEngagementTransition(
          { status, startAt: at("2026-01-01T00:00:00Z"), endAt: at("2026-02-01T00:00:00Z") },
          NOW,
        ),
      ).toBe("none");
    }
  });
});
