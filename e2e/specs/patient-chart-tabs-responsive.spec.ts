// e2e/specs/patient-chart-tabs-responsive.spec.ts — regression for #590: the patient-chart tab strip
// (`nav[aria-label="Patient chart"]`, ChartModuleRail) was occluded below ~1280 px wide.
//
// Layout is only observable in a real browser: at each width the strip must be hit-testable (nothing paints over it)
// and every tab must be reachable — fully visible, or the strip scrolls and scrolling brings the tab into view.
//
// Needs the full local stack with seeded demo data (see playwright.config.ts). NOT part of the default `bun run test`.
import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

// Heights from the #590 diagnosis. The bug needs a route whose main column is tall enough to collapse the workspace
// body (/documents has too little content to show it), so the checks run on medications and care-plan.
const VIEWPORTS = [
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;
const CHART_SECTIONS = ["medications", "care-plan"] as const;
// Mirrors TABS in apps/web/src/shell/chart-module-rail.tsx.
const TAB_LABELS = [
  "Overview",
  "Clinical",
  "Election & Certification",
  "Assessments",
  "Plan of Care",
  "Orders",
  "Medications",
  "Visits",
  "IDG",
  "Documents",
  "Claims",
  "Communication",
] as const;

/** True when the topmost element at the centre of `target` is the target or one of its descendants. */
async function isHitTestable(target: Locator): Promise<boolean> {
  // elementFromPoint is null for points outside the viewport; bring the target in first.
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return top !== null && el.contains(top);
  });
}

/** True when the whole of `tab` lies inside the visible box of `nav`. */
async function isInsideNav(nav: Locator, tab: Locator): Promise<boolean> {
  const [navBox, tabBox] = await Promise.all([nav.boundingBox(), tab.boundingBox()]);
  if (!navBox || !tabBox) return false;
  return (
    tabBox.x >= navBox.x - 0.5 &&
    tabBox.x + tabBox.width <= navBox.x + navBox.width + 0.5 &&
    tabBox.y >= navBox.y - 0.5 &&
    tabBox.y + tabBox.height <= navBox.y + navBox.height + 0.5
  );
}

let page: Page;
let patientId: string;

// Sign in and resolve the patient once, at the default viewport, so no test depends on the census flow.
test.describe.configure({ mode: "serial" });
test.beforeAll(async ({ browser }, testInfo) => {
  page = await browser.newPage({ baseURL: testInfo.project.use.baseURL });
  await signInAs(page, ADMIN_ACCOUNT());
  // Fails loudly (no skip) when the seed has no patient: the census row never appears.
  patientId = await openFirstPatientChart(page);
});
test.afterAll(async () => {
  await page.close();
});

async function openChart(
  viewport: { width: number; height: number },
  section: string,
): Promise<Locator> {
  await page.setViewportSize(viewport);
  await page.goto(`/patients/${patientId}/${section}`);
  // A reload re-runs the session bootstrap, which the local API's rate limiter intermittently answers with
  // "Account security unavailable" (environment noise, not layout). Retry that screen a bounded number of times.
  const nav = page.locator('nav[aria-label="Patient chart"]');
  const unavailable = page.getByText(/account security unavailable/i);
  const retry = page.getByRole("button", { name: "Try again" });
  for (let attempt = 0; attempt < 5; attempt++) {
    await expect(unavailable.or(nav)).toBeVisible();
    if (await nav.isVisible()) break;
    await retry.click();
  }
  // The chart re-renders while its queries resolve; the assertions below poll, so a capped idle wait is only a nicety.
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
  await expect(nav).toBeVisible();
  return nav;
}

for (const section of CHART_SECTIONS) {
  for (const viewport of VIEWPORTS) {
    test.describe(`patient chart tabs on ${section} at ${viewport.width}x${viewport.height}`, () => {
      test("the workspace body keeps a height and the tab strip is hit-testable", async () => {
        const nav = await openChart(viewport, section);
        const bodyHeight = await page
          .locator(".wx-patient-workspace-body")
          .evaluate((el) => el.getBoundingClientRect().height);
        expect(bodyHeight, "the workspace body collapsed to nothing").toBeGreaterThan(0);
        expect(await isHitTestable(nav), "something paints over the tab strip").toBe(true);
      });

      test("every tab is visible or reachable by scrolling the strip", async () => {
        const nav = await openChart(viewport, section);
        const scrollable = await nav.evaluate((el) => el.scrollWidth > el.clientWidth);

        for (const label of TAB_LABELS) {
          const tab = nav.getByRole("link", { name: label, exact: true });
          await expect(tab, `tab "${label}" is missing`).toHaveCount(1);
          if (!(await isInsideNav(nav, tab))) {
            expect(scrollable, `tab "${label}" is clipped and the strip does not scroll`).toBe(
              true,
            );
            await tab.scrollIntoViewIfNeeded();
          }
          // Polled: a scroll-behavior: smooth strip is still moving right after scrollIntoViewIfNeeded resolves.
          await expect
            .poll(() => isInsideNav(nav, tab), {
              message: `tab "${label}" is outside the strip`,
            })
            .toBe(true);
          expect(await isHitTestable(tab), `tab "${label}" is covered by another element`).toBe(
            true,
          );
        }
      });
    });
  }
}
