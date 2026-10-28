// e2e/specs/viewport-matrix.spec.ts — #852 (CW-QA-0008): the six required viewports.
//
// Run ONLY by the `viewport-*` projects in playwright.config.ts (the default `chromium` project
// ignores this file), so the six-wide matrix costs one small layout smoke x 6 — not every spec x 6.
// Per viewport: the Home shell, the patient census and one patient chart (id discovered at run time)
// must (a) not scroll the DOCUMENT horizontally (WCAG 1.4.10 Reflow — a table scrolling inside its own
// container is fine, a page that does is not) and (b) pass an axe WCAG 2A/AA scan.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Viewport matrix — layout smoke (#852)", () => {
  test("home, census and patient chart reflow without document-level horizontal scroll", async ({
    page,
  }, testInfo) => {
    // The viewport comes from the project (`use.viewport`), so the title names the real width.
    const width = page.viewportSize()?.width ?? 0;
    expect(width, `project ${testInfo.project.name} must set a viewport`).toBeGreaterThan(0);
    test.setTimeout(90_000);

    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);

    for (const path of ["/", "/patients", `/patients/${patientId}`]) {
      await page.goto(path);
      await expect(page.locator("#root > *").first()).toBeVisible();
      // Capped: polling pages never go idle. Without it the scan can land on the loading skeleton.
      await page.waitForLoadState("networkidle", { timeout: 6_000 }).catch(() => {});
      await expectNoAxeViolations(page);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(
        overflow,
        `${path} at ${width}px scrolls the document horizontally`,
      ).toBeLessThanOrEqual(0);
    }
  });
});
