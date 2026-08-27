// e2e/specs/reporting.spec.ts — the M33 reporting read path in a real browser (F-044).
//
// The finding this covers was "every dashboard tile renders Not yet available". The tile executor was in
// fact bound; what a user actually met was an EMPTY `/reports` (the dashboard catalog provider was never
// passed to the read service, so the list was `[]` for every org) and, past it, a dashboard whose tile
// manifest no DTO carried — so the render screen's own "the tile manifest is not available in this
// context" empty state was the only state it could reach. Both are server-side, and both are invisible
// from the server: an empty list and an empty tenant look identical over HTTP.
//
// So this spec walks the whole path as a person does — catalog → dashboard → a tile with a number on it —
// which is the only place the two halves being joined is observable.
//
// `admin@` holds the `org_admin` ROLE KEY (not just the permission catalog), and that key is what §4.7.1
// reads for org-wide reporting scope. A clinical persona signing in here would see the same dashboard
// with its tile narrowed to their own rows — that is D8 working, not a failure — but it makes for an
// assertion about seeded caseloads rather than about reporting.
import { expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

/** The org-shared saved view `db:seed:scenario-reporting` publishes. */
const DASHBOARD_NAME = "Clinician Productivity";
const TILE_KEY = "encounter_productivity_membership_day";
/** The BASE's display name (seeded by migration 0061) — what the tile is titled, vs. what the tenant
 *  called their saved view. A one-tile dashboard used to print the tenant's label as both. */
const TILE_NAME = "Encounter Productivity by Clinician";

test.describe("Reporting", () => {
  test("main path: the catalog lists a dashboard, and its tile renders a real figure", async ({
    page,
  }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();

    // The catalog itself. Before F-044 this was the "No dashboards" empty state on every install,
    // because `listDashboards` read an unbound provider rather than the org's shared views.
    const card = page.getByRole("link", { name: new RegExp(DASHBOARD_NAME) });
    await expect(card).toBeVisible();
    await card.click();
    await page.waitForURL(/\/reports\/dashboards\/[^/]+$/);

    // The tile manifest: the dashboard resolves to a tile, named by its report-base key. The "No tiles"
    // empty state here is what the screen showed for every dashboard before the manifest existed.
    await expect(page.getByRole("heading", { level: 1, name: DASHBOARD_NAME })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: TILE_NAME })).toBeVisible();
    await expect(page.getByText(TILE_KEY, { exact: true })).toBeVisible();

    // …and the tile carries the MEASURE from the materialized view. `db:seed:all` writes encounters and
    // the reporting seed refreshes the MV, so this is a real aggregate over real rows — where the card
    // used to print `rowCount` ("1 aggregate rows"), which is 1 for every KPI tile that returns anything.
    await expect(page.getByText("encounter count", { exact: true })).toBeVisible();
    await expect(page.getByText("signed count", { exact: true })).toBeVisible();
  });

  test("accessibility: the reports catalog has no WCAG 2A/AA violations", async ({ page }) => {
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/reports");
    await expect(page.getByRole("heading", { name: "Reports" })).toBeVisible();
    await expectNoAxeViolations(page);
  });
});
