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
  CREATED_ONLY_ROUTES,
  PRE_ACTIVATION_ALLOWED_ROUTES,
  preActivationMayCall,
} from "../src/bootstrap/onboarding-org-gate";

const routes = scanRoutes();
const registered = new Set(routes.map((r) => `${r.method.toUpperCase()} ${r.path}`));
/** What a confined session may call; `created` adds the billing steps. */
const allowed = (method: string, path: string, organizationCreated = false) =>
  preActivationMayCall({ method, routeTemplate: path, rawUrl: path, organizationCreated });

/**
 * The whole allowlist, spelled out. Adding a pair means editing this list too, in the same change, so an addition cannot slip in
 * under a root the other checks here do not name (the test below compares the set to this list exactly).
 */
const EXPECTED_ALLOWLIST = [
  "DELETE /api/v1/memberships/:id/roles/:rid",
  "DELETE /api/v1/orgs/:id/invitations/:invId",
  "GET /api/v1/auth/context",
  "GET /api/v1/auth/credential-status",
  "GET /api/v1/auth/csrf",
  "GET /api/v1/auth/memberships",
  "GET /api/v1/billing/mac-credentials",
  "GET /api/v1/billing/mac-credentials/:providerEntityId",
  "GET /api/v1/locations",
  "GET /api/v1/locations/:id",
  "GET /api/v1/me/permissions",
  "GET /api/v1/me/session",
  "GET /api/v1/memberships/:id/roles",
  "GET /api/v1/orgs/:id/invitations",
  "GET /api/v1/orgs/:id/members",
  "GET /api/v1/provider-entities",
  "GET /api/v1/provider-entities/:id",
  "GET /api/v1/roles",
  "GET /api/v1/subscription/pricing",
  "GET /api/v1/tenant/account",
  "GET /api/v1/tenant/baa",
  "GET /api/v1/tenant/clearinghouse",
  "GET /api/v1/tenant/help-requests",
  "GET /api/v1/tenant/onboarding",
  "GET /api/v1/tenant/support-consent-grants",
  "GET /api/v1/tenant/support-sessions",
  "GET /api/v1/tenant/support-sessions/:id/events",
  "GET /health",
  "GET /ready",
  "PATCH /api/v1/locations/:id",
  "PATCH /api/v1/provider-entities/:id",
  "PATCH /api/v1/tenant/org-profile",
  "POST /api/v1/auth/password/complete-required-change",
  "POST /api/v1/auth/select-organization",
  "POST /api/v1/auth/unlock",
  "POST /api/v1/billing/mac-credentials",
  "POST /api/v1/billing/mac-credentials/:providerEntityId/test",
  "POST /api/v1/locations",
  "POST /api/v1/memberships/:id/roles",
  "POST /api/v1/orgs/:id/invitations",
  "POST /api/v1/orgs/:id/invitations/:invId/resend",
  "POST /api/v1/provider-entities",
  "POST /api/v1/sessions/step-up",
  "POST /api/v1/sessions/step-up/initiate",
  "POST /api/v1/tenant/baa/:id/attest",
  "POST /api/v1/tenant/clearinghouse/activate",
  "POST /api/v1/tenant/clearinghouse/baa",
  "POST /api/v1/tenant/clearinghouse/verify",
  "POST /api/v1/tenant/go-live/attest",
  "POST /api/v1/tenant/help-requests",
  "POST /api/v1/tenant/help-requests/:id/approve",
  "POST /api/v1/tenant/help-requests/:id/close",
  "POST /api/v1/tenant/onboarding/:taskId/attest",
  "POST /api/v1/tenant/onboarding/:taskId/block",
  "POST /api/v1/tenant/onboarding/:taskId/complete",
  "POST /api/v1/tenant/onboarding/:taskId/reopen",
  "POST /api/v1/tenant/onboarding/:taskId/skip",
  "POST /api/v1/tenant/onboarding/:taskId/start",
  "POST /api/v1/tenant/support-consent-grants/:id/revoke",
  "PUT /api/v1/tenant/clearinghouse",
  "PUT /api/v1/tenant/compliance-officer",
];

/** The billing steps (7A): open to a `created` organization only. */
const EXPECTED_CREATED_ONLY = [
  "GET /api/v1/billing/mac-credentials",
  "GET /api/v1/billing/mac-credentials/:providerEntityId",
  "GET /api/v1/subscription/pricing",
  "GET /api/v1/tenant/clearinghouse",
  "POST /api/v1/billing/mac-credentials",
  "POST /api/v1/billing/mac-credentials/:providerEntityId/test",
  "POST /api/v1/tenant/clearinghouse/activate",
  "POST /api/v1/tenant/clearinghouse/baa",
  "POST /api/v1/tenant/clearinghouse/verify",
  "PUT /api/v1/tenant/clearinghouse",
];

describe("the onboarding-org allowlist against the registered route table", () => {
  it("scans a plausible route table (the guard against an empty scan passing everything vacuously)", () => {
    expect(routes.length).toBeGreaterThan(500);
    expect(registered.has("GET /api/v1/tenant/onboarding")).toBe(true);
  });

  it("the allowlist is exactly the reviewed list (no pair under any root can be added unseen)", () => {
    expect([...PRE_ACTIVATION_ALLOWED_ROUTES].sort()).toEqual([...EXPECTED_ALLOWLIST].sort());
    expect([...CREATED_ONLY_ROUTES].sort()).toEqual([...EXPECTED_CREATED_ONLY].sort());
    for (const entry of EXPECTED_CREATED_ONLY) {
      expect(PRE_ACTIVATION_ALLOWED_ROUTES.has(entry), entry).toBe(true);
    }
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
    ["GET", "/api/v1/billing/rate-tables"],
    ["POST", "/api/v1/billing/rate-tables"],
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

  it.each([
    ["GET", "/api/v1/tenant/help-requests"],
    ["POST", "/api/v1/tenant/help-requests"],
    ["POST", "/api/v1/tenant/help-requests/:id/approve"],
    ["POST", "/api/v1/tenant/help-requests/:id/close"],
  ])("%s %s exists and is open: the four help-request routes, and only those", (method, path) => {
    expect(registered.has(`${method} ${path}`), "the route must be real").toBe(true);
    expect(allowed(method, path)).toBe(true);
  });

  it("every other /api/v1/tenant route that is not a wizard or help-request route is refused", () => {
    const wizardPrefixes = [
      "/api/v1/tenant/help-requests",
      "/api/v1/tenant/onboarding",
      "/api/v1/tenant/org-profile",
      "/api/v1/tenant/compliance-officer",
      "/api/v1/tenant/go-live",
      "/api/v1/tenant/account",
      "/api/v1/tenant/baa",
      "/api/v1/tenant/support-consent-grants",
      "/api/v1/tenant/support-sessions",
      // 7A: the tenant's own clearinghouse choice, for the billing steps
      "/api/v1/tenant/clearinghouse",
    ];
    const open = routes
      .filter((r) => r.path.startsWith("/api/v1/tenant/"))
      .filter((r) => allowed(r.method, r.path, true))
      .map((r) => `${r.method.toUpperCase()} ${r.path}`);
    for (const entry of open) {
      expect(
        wizardPrefixes.some((prefix) => entry.split(" ")[1]?.startsWith(prefix)),
        `${entry} is open but is not a wizard route`,
      ).toBe(true);
    }
  });

  it.each([
    ["GET", "/api/v1/tenant/support-consent-grants"],
    ["POST", "/api/v1/tenant/support-consent-grants/:id/revoke"],
    ["GET", "/api/v1/tenant/support-sessions"],
    ["GET", "/api/v1/tenant/support-sessions/:id/events"],
  ])("%s %s remains available to inspect or terminate support access", (method, path) => {
    expect(registered.has(`${method} ${path}`)).toBe(true);
    expect(allowed(method, path)).toBe(true);
  });

  it("the billing steps' routes are open to a created organization only, and are exactly the clearinghouse, MAC credential and pricing-read pairs", () => {
    const billingStepRoutes = [
      "GET /api/v1/tenant/clearinghouse",
      "PUT /api/v1/tenant/clearinghouse",
      "POST /api/v1/tenant/clearinghouse/baa",
      "POST /api/v1/tenant/clearinghouse/verify",
      "POST /api/v1/tenant/clearinghouse/activate",
      "GET /api/v1/subscription/pricing",
      "GET /api/v1/billing/mac-credentials",
      "GET /api/v1/billing/mac-credentials/:providerEntityId",
      "POST /api/v1/billing/mac-credentials",
      "POST /api/v1/billing/mac-credentials/:providerEntityId/test",
    ];
    for (const entry of billingStepRoutes) {
      expect(registered.has(entry), `${entry} must be a real route`).toBe(true);
      const [method, path] = entry.split(" ") as [string, string];
      expect(allowed(method, path, true), entry).toBe(true); // a created organization
      expect(allowed(method, path, false), entry).toBe(false); // any other confined stage
    }
    // nothing else under the billing root or the subscription root is open
    const openBillingOrSubscription = [...PRE_ACTIVATION_ALLOWED_ROUTES].filter((entry) => {
      const path = entry.split(" ")[1] ?? "";
      return path.startsWith("/api/v1/billing/") || path.startsWith("/api/v1/subscription/");
    });
    expect(openBillingOrSubscription.sort()).toEqual(
      billingStepRoutes
        .filter((e) => e.includes("/billing/") || e.includes("/subscription/"))
        .sort(),
    );
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
    // 7A: the MAC credential routes are the one billing exception (the wizard's step 8 needs them); every other billing route stays out.
    const billingStepRoot = "/api/v1/billing/mac-credentials";
    for (const entry of PRE_ACTIVATION_ALLOWED_ROUTES) {
      const path = entry.split(" ")[1] ?? "";
      if (path === billingStepRoot || path.startsWith(`${billingStepRoot}/`)) continue;
      expect(
        forbiddenRoots.some((root) => path === root || path.startsWith(`${root}/`)),
        entry,
      ).toBe(false);
    }
  });
});
