import { allPermissionMirrorRows } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import { numericMetrics } from "../drift";
// apps/admin/src/modules/32-ai-platform — GAP-049 screen-registry + presentation unit tests.
//
// The registry half mirrors the M35 §5.2 precedent (the ADR-0030 substitute for arch:ui-parity, which
// scans apps/web only and is blind to apps/admin): every manifest entry binds a real component, ids and
// paths are unique, and each `requiredPermission` resolves to a REAL key in the packages/auth catalog —
// a typo'd key is a permanently hidden screen with the whole build green, which is exactly the class of
// defect this gap batch keeps finding.
//
// The presentation half covers the decisions that are easy to get quietly wrong: the SLA clock, the
// forecast status (projection vs spend), and the D11 drift bands.
import { duration, summarizeMetrics } from "../evaluations";
import { aiPlatformAdminScreens } from "../screens";
import {
  EDGE_APPROVAL_KIND,
  LIFECYCLE_TONE,
  TRIAGE_COLUMNS,
  driftTone,
  forecastStatus,
  lifecycleTone,
  riskTierTone,
  slaBreach,
} from "../status";

const CATALOG_KEYS = new Set(allPermissionMirrorRows().map((r) => r.key));
const NOW = new Date("2026-08-14T12:00:00.000Z");
const hoursAgo = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("M32 §5.1 admin screen registry (GAP-049)", () => {
  it("declares the module as M32 / 32-ai-platform", () => {
    expect(aiPlatformAdminScreens.moduleId).toBe(32);
    expect(aiPlatformAdminScreens.slug).toBe("32-ai-platform");
  });

  it("registers the eight §5.1 screens, each bound to a component", () => {
    expect(aiPlatformAdminScreens.screens).toHaveLength(8);
    for (const s of aiPlatformAdminScreens.screens) {
      // `lazy()` returns an exotic OBJECT, not a function — asserting `typeof === "function"` here
      // would quietly forbid the code-splitting this slice depends on.
      expect(s.screen, `${s.id} must bind a component`).toBeTruthy();
    }
  });

  it("has unique screen ids and route paths", () => {
    const ids = aiPlatformAdminScreens.screens.map((s) => s.id);
    const paths = aiPlatformAdminScreens.screens.map((s) => s.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gates every screen on a REAL packages/auth permission key", () => {
    for (const s of aiPlatformAdminScreens.screens) {
      expect(s.requiredPermission, `${s.id} must declare a permission`).toBeTruthy();
      expect(
        CATALOG_KEYS.has(s.requiredPermission as string),
        `${s.id} → ${s.requiredPermission}`,
      ).toBe(true);
    }
  });

  it("routes the whole console under /admin/ai-platform", () => {
    for (const s of aiPlatformAdminScreens.screens) {
      expect(s.path.startsWith("/admin/ai-platform/")).toBe(true);
    }
  });

  it("gates the kill-switch board on READ, not ACTIVATE", () => {
    // An operator who may see that a capability is stopped platform-wide but not resume it should
    // still be able to see it — the write is what the server refuses.
    const board = aiPlatformAdminScreens.screens.find((s) => s.id === "admin.ai-kill-switches");
    expect(board?.requiredPermission).toBe("ai.kill_switch.read");
  });
});

describe("§5.1 status presentation", () => {
  it("tones every lifecycle state, with MONITORING as a steady state rather than in-progress", () => {
    for (const state of Object.keys(LIFECYCLE_TONE)) {
      expect(lifecycleTone(state)).toBeTruthy();
    }
    expect(lifecycleTone("MONITORING")).toBe("success");
    expect(lifecycleTone("DEPRECATED")).toBe("warning");
    // An unknown state must not throw or borrow another state's colour.
    expect(lifecycleTone("SOMETHING_NEW")).toBe("neutral");
  });

  it("reads a high risk tier as critical, not as an error", () => {
    expect(riskTierTone("high")).toBe("critical");
    expect(riskTierTone("low")).toBe("neutral");
  });

  it("names an approval kind for every non-terminal edge target", () => {
    for (const state of Object.keys(LIFECYCLE_TONE)) {
      if (state === "PROPOSED") continue; // nothing transitions INTO the initial state
      expect(EDGE_APPROVAL_KIND[state], `no approval kind for → ${state}`).toBeTruthy();
    }
  });

  it("leads the triage board with the clinical-safety escalation column", () => {
    expect(TRIAGE_COLUMNS[0]).toBe("escalated_to_clinical_safety");
    expect(TRIAGE_COLUMNS).toContain("closed");
  });
});

describe("§5.1.5 triage SLA", () => {
  it("is silent inside 48 hours", () => {
    expect(slaBreach(hoursAgo(47), null, NOW)).toBeNull();
  });

  it("warns at 48h and escalates at 72h", () => {
    expect(slaBreach(hoursAgo(49), null, NOW)?.tone).toBe("warning");
    expect(slaBreach(hoursAgo(80), null, NOW)?.tone).toBe("critical");
  });

  it("stops the clock only when the report is CLOSED, not when it is acknowledged", () => {
    // The §5.1.5 clock runs from when a clinician filed the report. A triager moving it to
    // `investigating` has not resolved anything, and a badge that vanished on acknowledgement would
    // let a report sit open indefinitely with a clean-looking board.
    expect(slaBreach(hoursAgo(80), null, NOW)?.tone).toBe("critical");
    expect(slaBreach(hoursAgo(80), hoursAgo(1), NOW)).toBeNull();
  });

  it("returns null for an unparseable timestamp rather than a bogus age", () => {
    expect(slaBreach("not-a-date", null, NOW)).toBeNull();
  });
});

describe("§5.1.6 forecast status", () => {
  it("reads the PROJECTION, not the spend so far", () => {
    // 400 spent of a 1000 cap looks comfortable; a projection of 1200 is not.
    expect(forecastStatus(1200, 900, 1000).tone).toBe("error");
  });

  it("warns on the soft cap and errors on the hard cap", () => {
    expect(forecastStatus(950, 900, 1000).tone).toBe("warning");
    expect(forecastStatus(500, 900, 1000).tone).toBe("success");
  });

  it("is green when no cap is configured — there is nothing to breach", () => {
    expect(forecastStatus(1_000_000, null, null).tone).toBe("success");
  });
});

describe("§D11 drift bands", () => {
  it("bands at 10 / 20 / 30 percent", () => {
    expect(driftTone(0.05)).toBe("success");
    expect(driftTone(0.15)).toBe("warning");
    expect(driftTone(0.25)).toBe("error");
    expect(driftTone(0.4)).toBe("critical");
  });

  it("treats drift in either direction as drift", () => {
    // A refusal rate that COLLAPSED is as much a signal as one that spiked.
    expect(driftTone(-0.4)).toBe("critical");
  });

  it("keeps only numeric metrics — a string entry is provenance, not a measurement", () => {
    expect(numericMetrics({ ece: 0.12, modelPin: "claude-opus-4-7", nan: Number.NaN })).toEqual({
      ece: 0.12,
    });
    expect(numericMetrics(null)).toEqual({});
  });
});

describe("§5.1.7 evaluation-run presentation", () => {
  it("shows a duration only when both ends exist", () => {
    expect(duration(null, null)).toBe("—");
    expect(duration("2026-08-14T10:00:00.000Z", null)).toBe("—");
    expect(duration("2026-08-14T10:00:00.000Z", "2026-08-14T10:00:45.000Z")).toBe("45s");
    expect(duration("2026-08-14T10:00:00.000Z", "2026-08-14T10:30:00.000Z")).toBe("30m");
    expect(duration("2026-08-14T10:00:00.000Z", "2026-08-14T13:00:00.000Z")).toBe("3.0h");
  });

  it("renders an opaque metric bag without assuming precision/recall/F1", () => {
    // Each capability's metric set is its own (§2.5) — mapping onto assumed columns would silently
    // drop whatever a capability actually reports.
    expect(summarizeMetrics({ f1: 0.9123, custom_hospice_metric: 0.5 })).toBe(
      "custom_hospice_metric: 0.500 · f1: 0.912",
    );
    expect(summarizeMetrics({})).toBe("—");
    expect(summarizeMetrics(null)).toBe("—");
  });
});
