// GAP-037 — the M12 §4.8 BullMQ queue catalog is accounted for queue by queue: every one of the ten spec queues
// is either BUILT (and names the live worker) or DEFERRED with the exact upstream the build is gated on. A
// deferred queue is never silently absent, and the boot warning lists them so a status matrix that says
// "Implemented" cannot be read as "e-prescribing transmits".
import { describe, expect, it } from "vitest";
import {
  M12_DEFERRED_QUEUES,
  M12_QUEUE_CATALOG,
  M12_SPEC_QUEUE_NAMES,
  describeM12DeferredQueues,
} from "../src/modules/12-dosespot/jobs/queue-catalog";

describe("M12 §4.8 queue catalog", () => {
  it("accounts for exactly the ten spec queues, once each", () => {
    const names = M12_QUEUE_CATALOG.map((q) => q.queue).sort();
    expect(names).toEqual([...M12_SPEC_QUEUE_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("marks the two vendor-I/O drains that exist as built and names their worker", () => {
    const built = M12_QUEUE_CATALOG.filter((q) => q.status === "built").map((q) => q.queue);
    expect(built.sort()).toEqual([
      "dosespot.dispatch_webhook",
      "dosespot.fetch_medhx",
      "dosespot.patient_sync",
    ]);
    for (const q of M12_QUEUE_CATALOG.filter((x) => x.status === "built")) {
      expect(q.builtBy.length).toBeGreaterThan(0);
    }
  });

  it("defers transmission, the recovery drain, the benefit prewarm and the four SLA crons", () => {
    expect(M12_DEFERRED_QUEUES.map((q) => q.queue).sort()).toEqual([
      "dosespot.epcs_attempt_expiry_sweep",
      "dosespot.ial2_expiry_warn",
      "dosespot.refill_sla",
      "dosespot.rx_benefit_prewarm",
      "dosespot.transmission_timeout_sweep",
      "dosespot.transmit_newrx",
      "dosespot.transmit_queued_on_recovery",
    ]);
  });

  it("gives every deferral a blocker, an unblock condition and the data it would read", () => {
    for (const q of M12_DEFERRED_QUEUES) {
      expect(q.blockedOn.length).toBeGreaterThan(20);
      expect(q.unblockedBy.length).toBeGreaterThan(20);
      expect(q.upstreamData.length).toBeGreaterThan(0);
    }
  });

  it("renders a boot warning that names every deferred queue", () => {
    const text = describeM12DeferredQueues();
    for (const q of M12_DEFERRED_QUEUES) expect(text).toContain(q.queue);
    expect(text).toMatch(/not_required/);
  });
});
