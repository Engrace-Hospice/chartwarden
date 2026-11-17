// Workflow 07 — discipline-specific care plans. This is a read-only, re-runnable browser proof over
// the seeded Whitfield chart: the overview exposes all four discipline journeys, the real plan route
// is keyboard reachable, narrow reflow does not leak horizontal overflow, and axe reports WCAG 2.1
// A/AA against the authenticated screen. Lifecycle writes stay in the M15 live suites so this smoke
// test never changes the shared demo state.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openPatientChartByLastName } from "../fixtures/patients";

test.describe("Discipline-specific care plans", () => {
  test("the four journeys are reachable, responsive, keyboard-operable, and accessible", async ({
    page,
  }) => {
    await signInAs(page, RN_ACCOUNT());
    const patientId = await openPatientChartByLastName(page, "Whitfield");
    await page.goto(`/patients/${patientId}/discipline-plans`);

    await expect(page.getByRole("heading", { name: "Discipline plans", level: 1 })).toBeVisible();
    for (const name of ["Aide Plan of Care", "MSW Plan", "Spiritual Care Plan", "Volunteer Plan"]) {
      await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
    }

    await page.setViewportSize({ width: 375, height: 667 });
    const overview = page.getByLabel("Discipline plans");
    await expect(overview).toBeVisible();
    expect(
      await overview.evaluate((element) => element.scrollWidth <= element.clientWidth),
      "the discipline overview should reflow without horizontal overflow",
    ).toBe(true);

    await expect(page.getByText("No volunteer plan yet.")).toBeVisible();
    const aide = page.getByRole("link", { name: "Open Aide Plan of Care" });
    await aide.focus();
    await aide.press("Enter");
    await expect(page.getByRole("heading", { name: "Aide Plan of Care", level: 1 })).toBeVisible();

    await expectNoAxeViolations(page);
  });
});
