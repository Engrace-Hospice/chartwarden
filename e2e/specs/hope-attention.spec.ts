// e2e/specs/hope-attention.spec.ts — HOPE Phase 3 admission-scoped attention flow.
//
// These specs require a local stack seeded with an Admission whose M10 HOPE summary already carries
// backend-derived attention. The browser never manufactures regulatory windows or SFV triggers.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

const attentionAdmissionId = process.env.E2E_HOPE_ATTENTION_ADMISSION_ID;
const overdueSfvId = process.env.E2E_HOPE_OVERDUE_SFV_ID;

test.describe("HOPE attention", () => {
  test.skip(
    !attentionAdmissionId,
    "set E2E_HOPE_ATTENTION_ADMISSION_ID to an Admission with backend-derived HOPE attention",
  );

  test("admission detail surfaces HOPE attention and opens the contextual workflow", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/admissions/${attentionAdmissionId}`);

    await expect(page.getByText("HOPE Admission Assessment")).toBeVisible();
    await expect(
      page.getByText(/due soon|overdue|workflow issue|action required/i).first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Open HOPE" }).click();
    await expect(page).toHaveURL(new RegExp(`/admissions/${attentionAdmissionId}/hope$`));
    await expect(page.getByRole("heading", { name: "HOPE" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "HUV1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "HUV2" })).toBeVisible();
    await expect(
      page.getByText(/due soon|overdue|workflow issue|window expired|action required/i).first(),
    ).toBeVisible();

    const cta = page
      .getByRole("button", {
        name: /Complete HOPE Admission Assessment|Complete HUV1|Complete HUV2|Complete Discharge Assessment/i,
      })
      .first();
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(page).toHaveURL(
      new RegExp(`/admissions/${attentionAdmissionId}/hope/timepoints/`),
    );
  });

  test("overdue SFV alert uses the contextual SFV workflow", async ({ page }) => {
    test.skip(
      !overdueSfvId,
      "set E2E_HOPE_OVERDUE_SFV_ID to an open/overdue SFV for the same Admission",
    );

    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/admissions/${attentionAdmissionId}/hope`);

    await expect(page.getByRole("heading", { name: "Symptom Follow-Up Visits" })).toBeVisible();
    await expect(page.getByText(/overdue|due/i).first()).toBeVisible();
    await page
      .getByRole("button", { name: /Open Follow-Up|Complete Follow-Up/i })
      .first()
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/admissions/${attentionAdmissionId}/hope/sfv/${overdueSfvId}$`),
    );
  });
});
