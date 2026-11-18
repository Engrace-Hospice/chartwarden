// e2e/specs/safety-incident-wizard.spec.ts — the "Report a Safety Incident" wizard (M20) advances one step
// per click and never creates the draft before its review step.
//
// A real click on a reused <button> flips it to type="submit" before the click's default action runs (the
// same defect the WF08 visit wizard had); jsdom cannot replay that ordering, so only a real browser proves
// the footer's keyed buttons. Stops at the review step: nothing is created.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

const NARRATIVE =
  "The clinician reported an unsecured dog on the patient's porch during an evening visit. ".repeat(
    3,
  );

test.describe("Safety incident wizard", () => {
  test("Continue advances through the steps without creating the draft", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    // The create call is aborted as well as recorded: if the bug ever returns, the spec must not write an
    // (encrypted) incident draft into the shared database.
    const createRequests: string[] = [];
    await page.route("**/api/v1/safety/incidents", async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      createRequests.push(route.request().url());
      return route.abort();
    });
    await page.goto("/safety/incidents/new");
    await expect(page.getByRole("heading", { name: "Report a Safety Incident" })).toBeVisible({
      timeout: 15_000,
    });

    const affected = page.getByRole("combobox", { name: /^Affected clinician/ });
    await affected.click();
    await page
      .getByRole("option", { name: /Rita Alvarez/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    await page.getByLabel(/^Describe what happened/).fill(NARRATIVE);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // The review step: the draft button exists, focus moved to the step's heading (the Continue button that
    // held it was replaced), and nothing was created on the way.
    const review = page.getByRole("heading", { name: "Context & Review", exact: true });
    await expect(review).toBeVisible();
    await expect(page.getByRole("button", { name: "Create draft", exact: true })).toBeEnabled();
    expect(createRequests, "Continue must not create the incident").toEqual([]);
    await expect(review).toBeFocused();
  });
});
