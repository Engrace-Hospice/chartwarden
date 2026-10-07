// apps/backend/__tests__/m13-iv-overlay-gate.test.ts — GAP-107: M13's consult of M37's IV safety overlay, and
// M13's org-explicit IV-session activity projection M37's watchdog reads. Pure/fake-port; the real-Postgres proof
// is `m37-iv-safety-overlay.live.test.ts`.
import { describe, expect, it, vi } from "vitest";
import {
  type EmarIvOverlayPort,
  UNBOUND_IV_OVERLAY,
  evaluateIvOverlayGate,
} from "../src/modules/13-emar/iv-overlay-gate";
import { ivActivityOf } from "../src/modules/13-emar/seams/iv-session-activity-for-org";

const ORG = "11111111-1111-4111-8111-111111111111";
const ORDER = "22222222-2222-4222-8222-222222222222";
const T0 = "2026-10-05T10:00:00.000Z";

const gateInput = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  medicationOrderId: ORDER,
  mode: "iv_continuous_rate_change",
  administeredAt: "2026-10-05T12:30:00.000Z",
  priorSegments: [
    { mode: "iv_continuous_start" as const, administeredAt: T0 },
    { mode: "iv_continuous_rate_change" as const, administeredAt: "2026-10-05T12:00:00.000Z" },
  ],
  data: { previousRate: 2, newRate: 3, rateUnit: "mg/hr" },
  witnessTokenPresent: false,
  ...over,
});

const portReturning = (
  verdict: Awaited<ReturnType<EmarIvOverlayPort["evaluatePreAdministration"]>>,
) => {
  const evaluatePreAdministration = vi.fn(async () => verdict);
  return { port: { evaluatePreAdministration } as EmarIvOverlayPort, evaluatePreAdministration };
};

describe("evaluateIvOverlayGate (M13 -> M37 overlay)", () => {
  it("assembles the facts the overlay decides on: rate, unit, hours since start, minutes since last segment", async () => {
    const { port, evaluatePreAdministration } = portReturning({
      overlayApplies: true,
      pass: true,
      dualWitnessRequired: false,
    });
    await evaluateIvOverlayGate(port, gateInput());
    expect(evaluatePreAdministration).toHaveBeenCalledWith(ORG, {
      orderId: ORDER,
      proposedRate: 3,
      proposedRateUnit: "mg/hr",
      witnessTokenPresent: false,
      hoursSinceContinuousStart: 2.5,
      minutesSinceLastBedsideCheck: 30,
      isTitration: true,
    });
  });

  it("reads a start's rate from infusionRate and treats it as hour 0 / minute 0", async () => {
    const { port, evaluatePreAdministration } = portReturning({
      overlayApplies: true,
      pass: true,
      dualWitnessRequired: true,
    });
    const out = await evaluateIvOverlayGate(
      port,
      gateInput({ mode: "iv_continuous_start", priorSegments: [], data: { infusionRate: 2 } }),
    );
    expect(out.dualWitnessRequired).toBe(true);
    expect(evaluatePreAdministration).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({
        proposedRate: 2,
        hoursSinceContinuousStart: 0,
        minutesSinceLastBedsideCheck: 0,
        isTitration: false,
      }),
    );
  });

  it("sends a missing/non-numeric rate as null so the overlay can refuse it", async () => {
    const { port, evaluatePreAdministration } = portReturning({
      overlayApplies: true,
      pass: true,
      dualWitnessRequired: false,
    });
    await evaluateIvOverlayGate(port, gateInput({ data: { newRate: "fast" } }));
    expect(evaluatePreAdministration).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ proposedRate: null }),
    );
  });

  it.each([
    "IV_RATE_OUTSIDE_TITRATION_WINDOW",
    "IV_DUAL_WITNESS_REQUIRED",
    "IV_MAX_CONTINUOUS_DURATION_REACHED",
    "IV_BEDSIDE_CHECK_OVERDUE",
  ] as const)("surfaces %s as a 412 carrying that code", async (failureCode) => {
    const { port } = portReturning({
      overlayApplies: true,
      pass: false,
      dualWitnessRequired: true,
      failureCode,
    });
    await expect(evaluateIvOverlayGate(port, gateInput())).rejects.toMatchObject({
      code: failureCode,
      statusCode: 412,
    });
  });

  it("does not consult the overlay for pause / resume / stop (they change no dose)", async () => {
    const { port, evaluatePreAdministration } = portReturning({
      overlayApplies: true,
      pass: false,
      dualWitnessRequired: true,
      failureCode: "IV_BEDSIDE_CHECK_OVERDUE",
    });
    for (const mode of ["iv_continuous_pause", "iv_continuous_resume", "iv_continuous_stop"]) {
      await expect(evaluateIvOverlayGate(port, gateInput({ mode }))).resolves.toEqual({
        dualWitnessRequired: false,
      });
    }
    expect(evaluatePreAdministration).not.toHaveBeenCalled();
  });

  it("lets a seam failure propagate — an unchecked infusion is not a checked one", async () => {
    const port: EmarIvOverlayPort = {
      evaluatePreAdministration: async () => {
        throw new Error("seam down");
      },
    };
    await expect(evaluateIvOverlayGate(port, gateInput())).rejects.toThrow("seam down");
  });

  it("the unbound default applies no overlay", async () => {
    await expect(evaluateIvOverlayGate(UNBOUND_IV_OVERLAY, gateInput())).resolves.toEqual({
      dualWitnessRequired: false,
    });
  });

  it("an overlay that does not apply never widens the witness requirement", async () => {
    const { port } = portReturning({
      overlayApplies: false,
      pass: true,
      dualWitnessRequired: true,
    });
    await expect(evaluateIvOverlayGate(port, gateInput())).resolves.toEqual({
      dualWitnessRequired: false,
    });
  });
});

describe("ivActivityOf (the session state M37's watchdog reads)", () => {
  const row = (ivSessionId: string | null, mode: string, at: string) => ({
    ivSessionId,
    mode,
    administeredAt: new Date(at),
  });

  it("reports no activity for an order with no IV segments", () => {
    expect(ivActivityOf("o", [])).toEqual({
      medicationOrderId: "o",
      state: "none",
      sessionId: null,
      startedAt: null,
      lastSegmentAt: null,
    });
  });

  it("a running session: state running, start = first segment, last = latest segment", () => {
    const a = ivActivityOf("o", [
      row("s1", "iv_continuous_start", T0),
      row("s1", "iv_continuous_rate_change", "2026-10-05T11:00:00.000Z"),
    ]);
    expect(a).toMatchObject({
      state: "running",
      sessionId: "s1",
      startedAt: T0,
      lastSegmentAt: "2026-10-05T11:00:00.000Z",
    });
  });

  it("paused and stopped sessions are not running; only the CURRENT session counts", () => {
    expect(
      ivActivityOf("o", [
        row("s1", "iv_continuous_start", T0),
        row("s1", "iv_continuous_pause", "2026-10-05T11:00:00.000Z"),
      ]).state,
    ).toBe("paused");
    const next = ivActivityOf("o", [
      row("s1", "iv_continuous_start", T0),
      row("s1", "iv_continuous_stop", "2026-10-05T11:00:00.000Z"),
      row("s2", "iv_continuous_start", "2026-10-05T13:00:00.000Z"),
    ]);
    expect(next).toMatchObject({
      state: "running",
      sessionId: "s2",
      startedAt: "2026-10-05T13:00:00.000Z",
    });
  });
});
