// ADR-0113 D5 — M8's closure alert payloads are bound at boot (08-encounters/closure/closure-alert-catalog.ts): the catalog is asserted valid, and the
// emitter the M8 workers use checks every closure payload against it. The REAL producer (planClosureAlerts) feeds the wrapper, so the
// test fails if the sweep's payload and the catalog's schema drift apart; other alert types (the cosignature crons) pass through.
import { type AlertEmitter, createAlertPayloadRegistry } from "@chartwarden/messaging";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it, vi } from "vitest";
import {
  CLOSURE_ALERT_PAYLOAD_INVALID_CODE,
  registerClosureAlertCatalog,
  withClosureAlertCatalog,
} from "../src/modules/08-encounters/closure/closure-alert-catalog";
import { planClosureAlerts } from "../src/modules/08-encounters/closure/closure-sweep";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const CLOCK_START = new Date("2026-03-10T12:00:00.000Z");
const HOURS = 3_600_000;
const WARN_24 = { mode: "warn", thresholdHours: 24, enforceFrom: null } as const;

function recordingEmitter() {
  const emit = vi.fn(async () => ({ alertId: "alert-1", resolvedRecipientCount: 1 }));
  return { emitter: { emit } as AlertEmitter, emit };
}

const plannedAt = (elapsedHours: number) =>
  planClosureAlerts(
    [
      {
        encounterId: "00000000-0000-4000-8000-0000000000e1",
        clockStartedAt: CLOCK_START,
        authorUserId: "00000000-0000-4000-8000-0000000000b1",
        providerEntityId: "00000000-0000-4000-8000-0000000000d1",
      },
    ],
    WARN_24,
    new Date(CLOCK_START.getTime() + elapsedHours * HOURS),
  );

describe("registerClosureAlertCatalog", () => {
  it("registers exactly the three closure payload types and asserts them valid", () => {
    const catalog = registerClosureAlertCatalog(createAlertPayloadRegistry());
    expect([...catalog.keys()].sort()).toEqual([
      "m8.encounter.closure_at_risk",
      "m8.encounter.closure_escalated",
      "m8.encounter.closure_overdue",
    ]);
  });
});

describe("withClosureAlertCatalog", () => {
  it.each([18.5, 24.5, 36.5])(
    "lets the sweep's real alert through at %sh, unchanged",
    async (elapsed) => {
      const { emitter, emit } = recordingEmitter();
      const wrapped = withClosureAlertCatalog(
        emitter,
        registerClosureAlertCatalog(createAlertPayloadRegistry()),
      );
      const [alert] = plannedAt(elapsed);
      expect(alert).toBeDefined();
      if (!alert) return;
      await wrapped.emit(ORG, alert);
      expect(emit).toHaveBeenCalledExactlyOnceWith(ORG, alert);
    },
  );

  it("refuses a closure payload that fails its schema, names the paths and never reaches the emitter", async () => {
    const { emitter, emit } = recordingEmitter();
    const wrapped = withClosureAlertCatalog(
      emitter,
      registerClosureAlertCatalog(createAlertPayloadRegistry()),
    );
    const [alert] = plannedAt(24.5);
    if (!alert) throw new Error("fixture produced no alert");
    const { stage: _dropped, ...withoutStage } = alert.payload;
    const failure = await wrapped
      .emit(ORG, { ...alert, payload: withoutStage })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ChartWardenError);
    expect((failure as ChartWardenError).code).toBe(CLOSURE_ALERT_PAYLOAD_INVALID_CODE);
    expect((failure as ChartWardenError).message).toContain("/stage");
    expect(emit).not.toHaveBeenCalled();
  });

  it("passes an alert of another type through untouched (the cosignature crons share the emitter)", async () => {
    const { emitter, emit } = recordingEmitter();
    const wrapped = withClosureAlertCatalog(
      emitter,
      registerClosureAlertCatalog(createAlertPayloadRegistry()),
    );
    const input = {
      eventType: "m8.encounter.cosignature_overdue",
      severity: "warn" as const,
      correlationId: "m8:cosign-overdue:1",
      payload: { anything: "goes" },
    };
    await wrapped.emit(ORG, input);
    expect(emit).toHaveBeenCalledExactlyOnceWith(ORG, input);
  });
});
