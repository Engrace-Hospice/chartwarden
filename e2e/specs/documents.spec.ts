// e2e/specs/documents.spec.ts — critical workflow 5/6: documents (TEST-001).
//
// This header used to say the spec was "scoped to read + filter, not upload: apps/web has no upload
// UI anywhere yet (grepped for `type=\"file\"` across the whole app — zero hits)". That was true when
// it was written and stopped being true with #91's M22 row, which built the staff upload; the header
// outlived the fact it was justified by, and the screens.ts comment it quotes no longer says that.
//
// The write path covered here is TAGS, not upload — deliberately. The upload's third step PUTs bytes
// directly to object storage, so an E2E upload proves a MinIO deployment as much as it proves the
// app, and the seed itself skips the verified-upload path for exactly that reason
// (`seed-scenario-remaining.ts`: "verified-upload needs MinIO which isn't running"). Tags need no
// object store and exercise the same thing this suite exists for: a control that writes, a read that
// shows the write, and a reload that proves the row is really there.
//
// It is also the write path #153 was about. `document_tag` had two writers and no reader, so a tag
// was invisible and undeletable on the next page load — a defect that is INVISIBLE to a test that
// never reloads. The reload below is the assertion, not a formality.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";
import { openFirstPatientChart } from "../fixtures/patients";

test.describe("Documents", () => {
  test("main path: a patient's document list renders from a real API call", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    // Proves the retention-class filter round-trips through the API without crashing the screen.
    await page.getByLabel("Retention class").selectOption({ label: "Clinical" });
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  });

  test("main path: a tag survives the reload that used to erase it (#153/#91)", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    // Discovered through the app, never a hardcoded uuid — and the row click is itself the fix: the
    // version chain was registered at `/documents/:documentId/versions` and linked from NOWHERE, so
    // every control it hosts was reachable only by typing a URL.
    await page.goto("/documents");
    // The data rows announce as `button`, not `row`: `interactiveRowProps` sets `role="button"` on a
    // row with no focusable content of its own, so a screen-reader user is told what Enter does
    // instead of landing on a bare row that says nothing. Selecting by the role the app actually
    // exposes is the same lesson F-023 (#56) taught this fixture set.
    const rows = page.getByRole("table").getByRole("button");
    await expect.poll(() => rows.count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await rows.first().click();
    await page.waitForURL(/\/documents\/[^/]+\/versions$/);

    const key = `e2e-phase-${Date.now()}`;
    await page.getByRole("button", { name: "Add tag" }).click();
    // `getByLabel("Key")` is a SUBSTRING match and the form has three fields whose labels contain it
    // ("Kind", "Key", and the Value field's hint "…key with no value"), so both are pinned by role
    // and exact name.
    await page.getByRole("textbox", { name: "Key", exact: true }).fill(key);
    await page.getByRole("textbox", { name: /^Value/ }).fill("IIA");
    await page.getByRole("button", { name: "Add tag" }).click();
    await expect(page.getByText(key)).toBeVisible();

    // THE assertion. Before #153 the tag was written and then invisible to every client forever;
    // a spec that only checked the optimistic render would have passed against the broken build.
    await page.reload();
    await expect(page.getByText(key)).toBeVisible();

    // And removable — by an id that only a read could supply, which is why the DELETE was
    // unreachable by construction before the reader existed.
    await page.getByRole("button", { name: `Remove tag ${key}` }).click();
    await expect(page.getByText(key)).toHaveCount(0);
    await page.reload();
    await expect(page.getByText(key)).toHaveCount(0);
  });

  test("accessibility: the documents list has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    const patientId = await openFirstPatientChart(page);
    await page.goto(`/patients/${patientId}/documents`);
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
