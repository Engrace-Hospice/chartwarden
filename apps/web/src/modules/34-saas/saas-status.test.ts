// apps/web/src/modules/34-saas/saas-status.test.ts — the M34 status→tone presentation helper (R1).
//
// The pure tone-map helper lives here (it imports only the `StatusTone` *type* from @wardenx/ui, erased
// at runtime), so the test is colocated in apps/web — a `packages/` test importing it would create a
// forbidden package→app dependency-cruiser edge. Proves the §6.6 badge taxonomy is applied once:
// every M34 lifecycle/sub-status resolves to the documented Lantern tone, controlled/irreversible acts
// read `critical` (the §10 gold), and unknown values default to neutral.
import { describe, expect, it } from "vitest";
import {
  DSAR_TONE,
  FLAG_KIND_TONE,
  LIFECYCLE_TONE,
  SUPPORT_SESSION_TONE,
  cap,
  lifecycleTone,
  statusLabel,
} from "./saas-status";

describe("M34 saas-status tone map (§5.2 / §6.6)", () => {
  it("maps the eleven-state lifecycle palette onto the Lantern StatusTone vocabulary", () => {
    expect(LIFECYCLE_TONE.signup_intent).toBe("neutral");
    expect(LIFECYCLE_TONE.provisioning).toBe("progress");
    expect(LIFECYCLE_TONE.onboarding).toBe("progress");
    expect(LIFECYCLE_TONE.active).toBe("success");
    expect(LIFECYCLE_TONE.suspended).toBe("warning");
    expect(LIFECYCLE_TONE.at_risk).toBe("warning");
    expect(LIFECYCLE_TONE.offboarding_initiated).toBe("error");
    expect(LIFECYCLE_TONE.final_export_pending).toBe("error");
    expect(LIFECYCLE_TONE.destruction_pending).toBe("warning");
    expect(LIFECYCLE_TONE.destroyed).toBe("neutral");
    // All eleven documented states are covered.
    expect(Object.keys(LIFECYCLE_TONE)).toHaveLength(11);
  });

  it("reads consented break-glass + kill-switch as critical (the §10 gold reserved tone)", () => {
    expect(SUPPORT_SESSION_TONE.active).toBe("critical");
    expect(FLAG_KIND_TONE.kill_switch).toBe("critical");
  });

  it("treats the §164.524 one-time extension as a warning (SLA window being consumed)", () => {
    expect(DSAR_TONE.requested).toBe("progress");
    expect(DSAR_TONE.fulfilled).toBe("success");
    expect(DSAR_TONE.extended).toBe("warning");
    expect(DSAR_TONE.denied).toBe("error");
  });

  it("lifecycleTone() resolves a known status and defaults unknown values to neutral", () => {
    expect(lifecycleTone("active")).toBe("success");
    expect(lifecycleTone("not_a_real_status")).toBe("neutral");
  });

  it("statusLabel/cap title-cases underscore enum values", () => {
    expect(statusLabel("at_risk")).toBe("At Risk");
    expect(cap("final_export_pending")).toBe("Final Export Pending");
  });
});
