// C11 - a narrative that carries a Part 2 derived section is never handed to Layer 2 (ADR-0114 VN-D13). Layer 2 is a deny-stub behind a flag
// that is off, so today nothing leaves the process either way; the guard is what keeps SUD content out of the dispatch the day M32 binds it.
import { describe, expect, it, vi } from "vitest";
import { layer2OutcomeFor } from "../src/modules/08-encounters/layer2";

const NARRATIVE = "Pain controlled on the current regimen.";

describe("layer2OutcomeFor", () => {
  it("never calls Layer 2 for a narrative with a Part 2 derived section, and pins it verbatim with the ladder's own verdict", () => {
    const enhance = vi.fn();
    const outcome = layer2OutcomeFor(NARRATIVE, true, enhance);
    expect(enhance).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      enhanced: false,
      reason: "kill_switch_active",
      layer1: NARRATIVE,
      final: NARRATIVE,
    });
  });

  it("hands any other narrative to Layer 2 with the platform flag and the fail-closed tenant facts", () => {
    const enhance = vi.fn(() => ({
      enhanced: false as const,
      reason: "kill_switch_active" as const,
      layer1: NARRATIVE,
      final: NARRATIVE,
    }));
    layer2OutcomeFor(NARRATIVE, false, enhance);
    expect(enhance).toHaveBeenCalledTimes(1);
    expect(enhance).toHaveBeenCalledWith({
      layer1: NARRATIVE,
      flags: { layer2: false },
      eligibility: {
        tenantEnabled: false,
        clinicianOptedOut: true,
        encounterTypeOptedIn: false,
        baaExecuted: false,
        tokenBudgetAvailable: false,
      },
    });
  });

  it("with no injected enhancer, the real deny-stub gives the same pinned outcome for a plain narrative", () => {
    expect(layer2OutcomeFor(NARRATIVE, false)).toMatchObject({
      enhanced: false,
      reason: "kill_switch_active",
      final: NARRATIVE,
    });
  });
});
