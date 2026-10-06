// GAP-075 — every remittance topic M26 binds is one M25 catalogues with m26 as a declared consumer. Lives
// here (not in 26-cap/__tests__) because reading another module's catalog is a cross-module import.
import { describe, expect, it } from "vitest";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/events-by-m25";
import { BOUND_TOPICS } from "../src/modules/26-cap/consumers/outbox-binding";

describe("M26 bound topics vs the M25 catalog (GAP-075)", () => {
  it("every bound remittance topic is one M25 catalogues with m26 as a declared consumer", () => {
    const remittanceTopics = BOUND_TOPICS.filter((t) => t.startsWith("m25."));
    expect(remittanceTopics.length).toBeGreaterThan(0);
    for (const topic of remittanceTopics) {
      const entry = M25_OUTBOX_EVENTS.find((e) => e.eventName === topic);
      expect(entry?.declaredConsumers).toContain("m26");
    }
  });
});
