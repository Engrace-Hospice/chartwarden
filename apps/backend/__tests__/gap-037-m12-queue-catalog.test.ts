// GAP-037 — the M12 §4.8 BullMQ queue catalog is accounted for queue by queue. After the close-out round all ten
// spec queues are BUILT; the test pins that the catalog still equals the spec list, that every built entry names
// its worker and its sandbox caveat, that the seven new cron queue names are real catalog entries, and that the
// boot line stays honest about the adapter being unbound without credentials.
import { describe, expect, it } from "vitest";
import {
  M12_DEFERRED_QUEUES,
  M12_QUEUE_CATALOG,
  M12_SPEC_QUEUE_NAMES,
  describeM12AdapterPosture,
} from "../src/modules/12-dosespot/jobs/queue-catalog";
import {
  M12_CRON_QUEUES,
  M12_CRON_QUEUE_PARAMS,
  M12_CRON_SCHEDULES,
} from "../src/modules/12-dosespot/jobs/queues";

describe("M12 §4.8 queue catalog", () => {
  it("accounts for exactly the ten spec queues, once each", () => {
    const names = M12_QUEUE_CATALOG.map((q) => q.queue).sort();
    expect(names).toEqual([...M12_SPEC_QUEUE_NAMES].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("reports all ten as built, none deferred", () => {
    expect(M12_DEFERRED_QUEUES).toHaveLength(0);
    for (const q of M12_QUEUE_CATALOG) {
      expect(q.status).toBe("built");
      if (q.status === "built") {
        expect(q.builtBy.length).toBeGreaterThan(20);
        expect(q.adapterCaveats.length).toBeGreaterThan(0);
      }
    }
  });

  it("every cron queue the worker registers is a spec queue with a schedule and retry policy", () => {
    for (const [key, name] of Object.entries(M12_CRON_QUEUES)) {
      expect(M12_SPEC_QUEUE_NAMES).toContain(name);
      expect(M12_CRON_SCHEDULES[key as keyof typeof M12_CRON_QUEUES]).toBeTruthy();
      expect(M12_CRON_QUEUE_PARAMS[key as keyof typeof M12_CRON_QUEUES].attempts).toBeGreaterThan(
        0,
      );
    }
    expect(Object.keys(M12_CRON_QUEUES)).toHaveLength(7);
  });

  it("discloses the sandbox caveat of the queue that cannot work yet (no RxBenefit endpoint)", () => {
    const prewarm = M12_QUEUE_CATALOG.find((q) => q.queue === "dosespot.rx_benefit_prewarm");
    expect(prewarm?.status === "built" && prewarm.adapterCaveats).toContain("fails closed");
  });

  it("says the adapter is unbound until credentials are configured", () => {
    expect(describeM12AdapterPosture([])).toMatch(/UNBOUND until per-tenant credentials/);
    expect(describeM12AdapterPosture([])).toMatch(/orders keep activating locally/);
    expect(describeM12AdapterPosture(["org-1"])).toMatch(/bound for 1 tenant/);
    expect(describeM12AdapterPosture(["org-1"])).toMatch(/unverified until a sandbox run/);
  });
});
