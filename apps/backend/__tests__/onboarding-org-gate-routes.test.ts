// The not-yet-live organization's allowlist is a list of exact `METHOD + route template` pairs (bootstrap/onboarding-org-gate.ts).
// A hand-written list drifts from the real route table in two ways, and this walks the REAL table (the same static route scan
// that feeds the OpenAPI document) to catch both:
//   * an entry that names a route that does not exist (a typo, a renamed parameter, a route since removed) would silently
//     allow nothing and hide a broken onboarding screen;
//   * a route that SHOULD stay closed (the export downloads, consent grants, care-team staff, credentials, user provisioning
//     the security review found reachable through the old root prefixes) must never become allowed by accident.
import { describe, expect, it } from "vitest";
import { scanRoutes } from "../../../scripts/openapi/scan-routes";
import {
  PRE_ACTIVATION_ALLOWED_ROUTES,
  preActivationMayCall,
} from "../src/bootstrap/onboarding-org-gate";

const routes = scanRoutes();
const registered = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
const allowed = (method: string, path: string) =>
  preActivationMayCall({ method, routeTemplate: path, rawUrl: path });

describe("the onboarding-org allowlist against the registered route table", () => {
  it("scans a plausible route table (the guard against an empty scan passing everything vacuously)", () => {
    expect(routes.length).toBeGreaterThan(500);
    expect(registered.has("GET /api/v1/tenant/onboarding")).toBe(true);
  });

  it("every allowlisted entry names a route that exists", () => {
    const missing = [...PRE_ACTIVATION_ALLOWED_ROUTES].filter((entry) => !registered.has(entry));
    expect(missing).toEqual([]);
  });

  it.each([
    ["GET", "/api/v1/tenant/dsar-export-jobs"],
    ["GET", "/api/v1/tenant/dsar-export-jobs/:id/download"],
    ["POST", "/api/v1/tenant/dsar-export-jobs/:id/fulfill"],
    ["GET", "/api/v1/tenant/tenant-export-jobs"],
    ["GET", "/api/v1/tenant/tenant-export-jobs/:id/download"],
    ["POST", "/api/v1/tenant/support-consent-grants"],
    ["POST", "/api/v1/tenant/support-consent-grants/:id/revoke"],
    ["GET", "/api/v1/tenant/feature-flags"],
    ["GET", "/api/v1/orgs/:id/care-team-staff"],
    ["GET", "/api/v1/memberships/:membershipId/credentials"],
    ["POST", "/api/v1/memberships/:membershipId/credentials"],
    ["DELETE", "/api/v1/memberships/:membershipId/credentials/:credentialId"],
    ["POST", "/api/v1/orgs/:orgId/users"],
    ["POST", "/api/v1/orgs/:orgId/users/:userId/password-reset"],
  ])("%s %s exists and stays refused", (method, path) => {
    expect(
      registered.has(`${method} ${path}`),
      "the route this refusal is about must be real",
    ).toBe(true);
    expect(allowed(method, path)).toBe(false);
  });

  it("every other /api/v1/tenant route that is not a wizard route is refused", () => {
    const wizardPrefixes = [
      "/api/v1/tenant/onboarding",
      "/api/v1/tenant/org-profile",
      "/api/v1/tenant/compliance-officer",
      "/api/v1/tenant/go-live",
      "/api/v1/tenant/account",
      "/api/v1/tenant/baa",
    ];
    const open = routes
      .filter((r) => r.path.startsWith("/api/v1/tenant/"))
      .filter((r) => allowed(r.method, r.path))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    for (const entry of open) {
      expect(
        wizardPrefixes.some((prefix) => entry.split(" ")[1]?.startsWith(prefix)),
        `${entry} is open but is not a wizard route`,
      ).toBe(true);
    }
  });

  it("no clinical, patient, billing, messaging or platform route is on the list", () => {
    const forbiddenRoots = [
      "/api/v1/patients",
      "/api/v1/admissions",
      "/api/v1/encounters",
      "/api/v1/claims",
      "/api/v1/documents",
      "/api/v1/messages",
      "/api/v1/portal",
      "/api/v1/platform",
      "/api/v1/billing",
    ];
    for (const entry of PRE_ACTIVATION_ALLOWED_ROUTES) {
      const path = entry.split(" ")[1] ?? "";
      expect(
        forbiddenRoots.some((root) => path === root || path.startsWith(`${root}/`)),
        entry,
      ).toBe(false);
    }
  });
});
