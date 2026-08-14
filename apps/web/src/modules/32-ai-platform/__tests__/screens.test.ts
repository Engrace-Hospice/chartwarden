import { allPermissionMirrorRows } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
// apps/web/src/modules/32-ai-platform — GAP-049 tenant screen-registry unit test.
//
// The §5.2-§5.4 half of M32's frontend: the Compliance Officer view, the tenant-admin opt-in board and
// routing panel, and the clinician's personal opt-out. Guards the same wiring the admin slice's test
// does, plus the one boundary decision worth pinning: NONE of these may sit under `/admin/*`. They are
// tenant surfaces in the tenant app, and a path collision with the platform-ops console would be both a
// routing bug and a category error about who the screen is for.
import { AIReportButton } from "../ai-report-button";
import { aiPlatformScreens } from "../screens";

const CATALOG_KEYS = new Set(allPermissionMirrorRows().map((r) => r.key));

describe("M32 §5.2-§5.4 tenant screen registry (GAP-049)", () => {
  it("declares the module as M32 / 32-ai-platform", () => {
    expect(aiPlatformScreens.moduleId).toBe(32);
    expect(aiPlatformScreens.slug).toBe("32-ai-platform");
  });

  it("registers the four tenant screens, each bound to a component", () => {
    expect(aiPlatformScreens.screens).toHaveLength(4);
    for (const s of aiPlatformScreens.screens) {
      expect(s.screen, `${s.id} must bind a component`).toBeTruthy();
    }
  });

  it("has unique screen ids and route paths", () => {
    const ids = aiPlatformScreens.screens.map((s) => s.id);
    const paths = aiPlatformScreens.screens.map((s) => s.path);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gates every screen on a REAL packages/auth permission key", () => {
    for (const s of aiPlatformScreens.screens) {
      expect(s.requiredPermission, `${s.id} must declare a permission`).toBeTruthy();
      expect(
        CATALOG_KEYS.has(s.requiredPermission as string),
        `${s.id} → ${s.requiredPermission}`,
      ).toBe(true);
    }
  });

  it("keeps every tenant screen OUT of the platform-ops /admin tree", () => {
    for (const s of aiPlatformScreens.screens) {
      expect(s.path.startsWith("/admin"), `${s.id} is a tenant surface`).toBe(false);
    }
  });

  it("gates both tenant-admin screens on the opt-in WRITE key", () => {
    // Both exist to perform that write; a read-only visitor has nothing to do on either.
    for (const id of ["ai.opt-in", "ai.routing"]) {
      const screen = aiPlatformScreens.screens.find((s) => s.id === id);
      expect(screen?.requiredPermission).toBe("ai.tenant_opt_in");
    }
  });

  it("exports the §5.5 report widget for consumer modules to embed", () => {
    // The widget is the reason M32 has a web slice at all beyond its own screens — every AI-enhanced
    // surface in another module imports it.
    expect(typeof AIReportButton).toBe("function");
  });
});
