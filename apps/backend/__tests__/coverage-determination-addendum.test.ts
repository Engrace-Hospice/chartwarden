// FY2027, 42 CFR 418.24(d)(2) — M6's consumer of the M12 / M21 coverage-determination events decides whether
// the change touches the election addendum's non-covered list (and so opens the 3-day update window).
import type { NonCoveredItemSnapshot } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import type { ElectionAddendumService } from "../src/modules/06-admission/election-addendum/service";
import {
  carrySourceReasons,
  mergeSourceItems,
  sourceItemsDiffer,
} from "../src/modules/06-admission/election-addendum/store";
import {
  M6_COVERAGE_ADDENDUM_EVENTS,
  buildM6CoverageAddendumConsumer,
  decideCoverageAddendum,
} from "../src/modules/06-admission/outbox-consumers/coverage-determination-addendum";

describe("decideCoverageAddendum", () => {
  it("skips an event with no admission", () => {
    expect(decideCoverageAddendum({ hospiceCoverage: "not_covered_unrelated" }).kind).toBe("skip");
  });

  it("skips an item that stays covered", () => {
    const decision = decideCoverageAddendum({
      admissionId: "a1",
      hospiceCoverage: "covered_related",
      previousHospiceCoverage: "covered_related",
    });
    expect(decision.kind).toBe("skip");
  });

  it("updates when an item becomes not covered", () => {
    expect(
      decideCoverageAddendum({
        admissionId: "a1",
        hospiceCoverage: "not_covered_unrelated",
        previousHospiceCoverage: "covered_related",
      }),
    ).toEqual({ kind: "update", admissionId: "a1" });
  });

  it("updates when an excluded item is re-included (it leaves the list)", () => {
    expect(
      decideCoverageAddendum({
        admissionId: "a1",
        hospiceCoverage: "covered_related",
        previousHospiceCoverage: "not_covered_other",
      }).kind,
    ).toBe("update");
  });

  it("updates when the reason of an excluded item changes", () => {
    expect(
      decideCoverageAddendum({
        admissionId: "a1",
        hospiceCoverage: "not_covered_other",
        previousHospiceCoverage: "not_covered_other",
      }).kind,
    ).toBe("update");
  });
});

describe("buildM6CoverageAddendumConsumer", () => {
  it("subscribes to the M12 and M21 events and opens the update window at the event's time", async () => {
    // Arrange
    const openAddendumUpdateWindow = vi.fn().mockResolvedValue(undefined);
    const addendum = { openAddendumUpdateWindow } as unknown as ElectionAddendumService;
    const consumer = buildM6CoverageAddendumConsumer({ addendum: () => addendum });
    const createdAt = new Date("2026-10-05T14:00:00Z");
    const event = {
      eventType: "m21.supply_request.coverage_determination_changed",
      organizationId: "org-1",
      createdAt,
      payload: {
        admissionId: "adm-1",
        hospiceCoverage: "not_covered_unrelated",
        previousHospiceCoverage: "covered_related",
      },
    } as unknown as DispatchableOutboxEvent;

    // Act
    await consumer.handle(event);

    // Assert
    expect(consumer.eventTypes).toEqual(M6_COVERAGE_ADDENDUM_EVENTS);
    expect(openAddendumUpdateWindow).toHaveBeenCalledWith(
      "org-1",
      "adm-1",
      createdAt,
      "m21.supply_request.coverage_determination_changed",
      { requireDiff: true },
    );
  });
});

// Bug 5: a coverage event delivered AFTER the version that already reflects it was furnished must not open
// a version 2 — the consumer asks for a diff against the latest furnished / settled version.
const drug = (
  sourceId: string,
  reason = "Managed by the cardiologist",
): NonCoveredItemSnapshot => ({
  source: "medication",
  sourceId,
  category: "drug",
  description: `Drug ${sourceId}`,
  reason,
  determinedAt: "2026-10-03T00:00:00.000Z",
  determinedByUserId: null,
});
const line = (sourceId: string, reason: string, sourceReason?: string) => ({
  category: "drug" as const,
  description: `Drug ${sourceId}`,
  reasonNotCovered: reason,
  source: "medication" as const,
  sourceId,
  ...(sourceReason !== undefined ? { sourceReason } : {}),
});

describe("sourceItemsDiffer — (source, sourceId) + patient-facing reason, order-insensitive", () => {
  it("is false when the furnished version already lists the same determinations in another order", () => {
    const version = {
      items: [
        line("m2", "Managed by the cardiologist", "Managed by the cardiologist"),
        line("m1", "Managed by the cardiologist", "Managed by the cardiologist"),
      ],
    };
    expect(sourceItemsDiffer(version, [drug("m1"), drug("m2")])).toBe(false);
  });

  it("is true when the source's reason changed since the version was filled", () => {
    const version = {
      items: [line("m1", "Managed by the cardiologist", "Managed by the cardiologist")],
    };
    expect(sourceItemsDiffer(version, [drug("m1", "Comfort-unrelated; PCP manages")])).toBe(true);
  });

  it("is false when only the clinician's wording of the reason differs (the source did not change)", () => {
    const version = {
      items: [line("m1", "Your heart doctor manages this", "Managed by the cardiologist")],
    };
    expect(sourceItemsDiffer(version, [drug("m1")])).toBe(false);
  });

  it("is true when an item is added or withdrawn", () => {
    const version = {
      items: [line("m1", "Managed by the cardiologist", "Managed by the cardiologist")],
    };
    expect(sourceItemsDiffer(version, [drug("m1"), drug("m2")])).toBe(true);
    expect(sourceItemsDiffer(version, [])).toBe(true);
  });

  it("compares a line filled before the source reason was tracked by key only", () => {
    expect(sourceItemsDiffer({ items: [line("m1", "Edited long ago")] }, [drug("m1")])).toBe(false);
  });

  it("ignores clinician-typed lines", () => {
    const version = {
      items: [{ category: "item" as const, description: "Manual", reasonNotCovered: "x" }],
    };
    expect(sourceItemsDiffer(version, [])).toBe(false);
  });
});

describe("mergeSourceItems — tracks the source's reason", () => {
  it("stamps the source reason on a newly reported line", () => {
    expect(mergeSourceItems([], [drug("m1")])).toEqual([
      line("m1", "Managed by the cardiologist", "Managed by the cardiologist"),
    ]);
  });

  it("keeps a clinician-edited reason while the source's reason is unchanged", () => {
    const merged = mergeSourceItems(
      [line("m1", "Your heart doctor manages this", "Managed by the cardiologist")],
      [drug("m1")],
    );
    expect(merged[0]?.reasonNotCovered).toBe("Your heart doctor manages this");
  });

  it("takes the source's new reason when the determination's reason changed", () => {
    const merged = mergeSourceItems(
      [line("m1", "Your heart doctor manages this", "Managed by the cardiologist")],
      [drug("m1", "Now managed by the PCP")],
    );
    expect(merged[0]).toMatchObject({
      reasonNotCovered: "Now managed by the PCP",
      sourceReason: "Now managed by the PCP",
    });
    // …and the merged version no longer differs from the source (no follow-up version on redelivery).
    expect(sourceItemsDiffer({ items: merged }, [drug("m1", "Now managed by the PCP")])).toBe(
      false,
    );
  });

  it("stamps a legacy line (no tracked reason) and keeps its text", () => {
    const merged = mergeSourceItems([line("m1", "Edited long ago")], [drug("m1")]);
    expect(merged[0]).toMatchObject({
      reasonNotCovered: "Edited long ago",
      sourceReason: "Managed by the cardiologist",
    });
  });
});

describe("carrySourceReasons — the tracked reason is server-owned across a draft edit", () => {
  it("restores the tracked reason the client did not echo back and ignores one it invented", () => {
    const previous = [line("m1", "Managed by the cardiologist", "Managed by the cardiologist")];
    const edited = [
      { ...line("m1", "Your heart doctor manages this") },
      { ...line("m9", "Typed", "forged") },
      { category: "item" as const, description: "Manual", reasonNotCovered: "x" },
    ];
    expect(carrySourceReasons(previous, edited)).toEqual([
      line("m1", "Your heart doctor manages this", "Managed by the cardiologist"),
      line("m9", "Typed"),
      { category: "item", description: "Manual", reasonNotCovered: "x" },
    ]);
  });
});
