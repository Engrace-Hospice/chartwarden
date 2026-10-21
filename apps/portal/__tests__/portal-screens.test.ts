import { describe, expect, it } from "vitest";
// @chartwarden/portal — M31-T08 screen-registry unit test. Guards the wiring the portal SPA depends on: every
// §5.1 manifest entry binds to a real component, ids and routes are unique (a collision would silently
// shadow a screen), and each nav-gating permission key is well-formed (a typo'd key would hide a screen).
import { PORTAL_SCREEN_MANIFEST } from "../src/screens/manifest";
import { createPortalRegistry, portalScreens } from "../src/screens/registry";

const KEY = /^[a-z_]+\.[a-z_]+(?:\.[a-z_]+)?$/;

describe("portal screen registry (M31 §5.1)", () => {
  it("binds every manifest entry to a component", () => {
    expect(portalScreens.screens).toHaveLength(PORTAL_SCREEN_MANIFEST.length);
    for (const s of portalScreens.screens) {
      expect(typeof s.screen).toBe("function");
    }
  });

  it("declares the module as M31 / 31-portal", () => {
    expect(portalScreens.moduleId).toBe(31);
    expect(portalScreens.slug).toBe("31-portal");
  });

  it("has unique screen ids", () => {
    const ids = portalScreens.screens.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has unique route paths", () => {
    const paths = portalScreens.screens.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("gates every chromed screen on a well-formed permission key", () => {
    for (const s of portalScreens.screens) {
      if (s.chrome === false) continue; // sign-in is a pre-session, ungated surface
      expect(s.requiredPermission, `${s.id} must name a permission key`).toBeDefined();
      expect(s.requiredPermission).toMatch(KEY);
    }
  });

  it("exposes exactly the chromeless pre-session surfaces (sign-in, accept-invitation, signed-in, the two secure-link redemptions and the funeral case)", () => {
    const chromeless = portalScreens.screens.filter((s) => s.chrome === false);
    expect(chromeless.map((s) => s.path).sort()).toEqual([
      "/",
      "/accept-invitation",
      "/collaborator/redeem",
      "/funeral/case",
      "/funeral/redeem",
      "/signed-in",
    ]);
  });

  it("rejects a duplicate screen id at registration", () => {
    const registry = createPortalRegistry();
    registry.register(portalScreens);
    expect(() => registry.register(portalScreens)).toThrow(/duplicate portal screen id/);
  });
});
