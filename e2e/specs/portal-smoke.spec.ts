// e2e/specs/portal-smoke.spec.ts — #852: Patient/Family Portal PWA (apps/portal, Vite :5174, base /portal/).
//
// Run by the `portal` project only, and only when `E2E_PORTAL_URL` names a running portal — the CI e2e
// job starts the web app alone. Scope is the pre-auth registered screens (sign-in, invitation, magic-link
// redemption): the portal signs in by emailed magic link, which a browser spec cannot complete without a
// mail sink, so the session-gated screens (`/patient-picker`, `/account`, ...) stay manual.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.skip(
  !process.env.E2E_PORTAL_URL,
  "E2E_PORTAL_URL is unset: start apps/portal (`cd apps/portal && bun run dev`, :5174) and export E2E_PORTAL_URL=http://localhost:5174",
);

// Registered `portal` screens with permission "(none)" (audit/ui-parity/ui-parity.json), under the /portal base.
const PUBLIC_PORTAL_ROUTES = [
  "/portal/",
  "/portal/accept-invitation",
  "/portal/signed-in",
  "/portal/funeral/redeem",
  "/portal/collaborator/redeem",
] as const;

test.describe("Portal — pre-auth smoke (#852)", () => {
  for (const route of PUBLIC_PORTAL_ROUTES) {
    test(`${route} renders and scans clean for WCAG 2A/AA`, async ({ page }) => {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root > *").first()).toBeVisible();
      await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
        ),
      ).toEqual([]);
    });
  }
});
