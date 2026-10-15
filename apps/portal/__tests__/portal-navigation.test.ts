import { describe, expect, it } from "vitest";
import { PORTAL_NAVIGATION, portalNavPath, portalNavTitle } from "../src/navigation";
import { PORTAL_SCREEN_MANIFEST } from "../src/screens/manifest";

describe("PR5 portal navigation and authorization metadata parity", () => {
  const ids = new Set(PORTAL_SCREEN_MANIFEST.map((screen) => screen.id));
  const patientId = "11111111-1111-4111-8111-111111111111";

  it("only includes unique, declared navigation destinations", () => {
    const navigationIds = PORTAL_NAVIGATION.map((item) => item.id);
    expect(new Set(navigationIds).size).toBe(navigationIds.length);
    expect(new Set(PORTAL_SCREEN_MANIFEST.map((screen) => screen.path)).size).toBe(
      PORTAL_SCREEN_MANIFEST.length,
    );
    for (const item of PORTAL_NAVIGATION) {
      expect(ids.has(item.id)).toBe(true);
      const metadata = PORTAL_SCREEN_MANIFEST.find((screen) => screen.id === item.id);
      expect(metadata?.chrome).not.toBe(false);
      expect(metadata?.requiredPermission).toBeTruthy();
      expect(portalNavPath(item.id, patientId).startsWith("/")).toBe(true);
    }
  });

  it("has exactly three fixed mobile destinations and routes account outside the patient path", () => {
    expect(PORTAL_NAVIGATION.filter((item) => item.mobile).map((item) => item.mobile)).toEqual([
      "home", "visits", "messages",
    ]);
    expect(portalNavPath("portal.account", patientId)).toBe("/account");
  });

  it("labels deep visit paths without misidentifying them as the dashboard", () => {
    expect(portalNavTitle(`/p/${patientId}`)).toBe("Home");
    expect(portalNavTitle(`/p/${patientId}/visits`)).toBe("Visits");
    expect(portalNavTitle(`/p/${patientId}/visits/visit-id/telehealth`)).toBe("Visits");
    expect(portalNavTitle("/account")).toBe("Account & security");
  });
});
