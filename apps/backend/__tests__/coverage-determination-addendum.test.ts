// FY2027, 42 CFR 418.24(d)(2) — M6's consumer of the M12 / M21 coverage-determination events decides whether
// the change touches the election addendum's non-covered list (and so opens the 3-day update window).
import { describe, expect, it, vi } from "vitest";
import type { DispatchableOutboxEvent } from "../src/bootstrap/outbox-dispatcher";
import type { ElectionAddendumService } from "../src/modules/06-admission/election-addendum/service";
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
      { requireDiff: false },
    );
  });
});
