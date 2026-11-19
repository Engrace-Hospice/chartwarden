// e2e/specs/evv.spec.ts — critical workflow: approve the device EVV capture depends on (F-031, #91).
//
// #91's fifth acceptance criterion asks for one E2E spec per module driving the primary write path.
// M18's is not the obvious one, and the reason is worth stating rather than working around.
//
// CHECK-IN / CHECK-OUT IS NOT A WEB SURFACE, by design and not by omission. `screens.ts` says so: the
// capture flow is the Capacitor mobile app, "a browser has no attested device and no §12.4 posture to
// report, so there is nothing for a web screen to do". A spec that drove a fake browser check-in would
// be testing something the product does not ship. So the path driven here is the one the web DOES own
// and that capture depends on absolutely: device approval. `resolveApprovedDevice` refuses a check-in
// outright without one (D8), so until a supervisor approves the handset, every EVV capture from it is
// rejected — which under the 21st Century Cures Act means the visit cannot be evidenced at all.
//
// THE SEED HAD TO CHANGE FIRST. `db:seed:scenario-field-ops` self-registered one device and immediately
// approved it, so `/evv/devices/pending` was permanently EMPTY on a seeded stack and the approve/reject
// ceremony — the only M18 write a browser can drive — had nothing to act on. The seed now leaves a
// second handset pending. Same shape as M11's signature inbox and the billing spec #106/F-046 names.
//
// THIS SPEC CONSUMES ITS SEED, deliberately, exactly as `orders.spec.ts` does: approving the handset
// empties the queue, so a second run against the same database fails at "the queue has something in
// it" rather than passing on an empty one. That is the guard working — verified by running it twice.
// CI reseeds (`db:seed:all`) before the suite; locally, re-run `bun run db:seed:scenario-field-ops`
// between runs. It is not made self-supplying because device self-registration is the mobile flow this
// spec's header is about NOT faking.
//
// The late-check sweep, missing-resolution consumer, and aggregator preparation worker are now built
// and wired. They remain outside this browser spec because the seed does not provide a deterministic
// late-check or rejected-submission journey; worker/domain suites exercise those paths instead.
//
// Signs in as the SUPERVISOR, not the RN who owns the handset: `/me/evv/devices` deliberately offers no
// approve control, because approving a device is an act on someone else's equipment.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SUPERVISOR_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, expectRouteReached, signInAs } from "../fixtures/helpers";

const EVIDENCE_VIEWPORTS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

async function captureEvvEvidence(
  page: import("@playwright/test").Page,
  checkpoint: string,
): Promise<void> {
  const evidenceDir = process.env.EVV_EVIDENCE_DIR;
  if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

  for (const viewport of EVIDENCE_VIEWPORTS) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${checkpoint} should not introduce document-level horizontal overflow at ${viewport.width}px`,
    ).toBe(true);
    await expectNoAxeViolations(page);
    if (evidenceDir) {
      await page.screenshot({
        path: join(
          evidenceDir,
          `${checkpoint}-${viewport.name}-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
  }
}

test.describe("EVV", () => {
  test("main path: a supervisor approves a pending device and it leaves the queue", async ({
    page,
  }) => {
    await signInAs(page, SUPERVISOR_ACCOUNT());
    await page.goto("/evv/devices/pending");
    await expect(page.getByRole("heading", { name: "EVV Devices - Pending Approval" })).toBeVisible(
      { timeout: 15_000 },
    );

    // The queue has something in it. If this fails the seed regressed, and every assertion below would
    // otherwise pass vacuously against an empty roster — the failure mode this spec exists to prevent.
    const approve = page.getByRole("button", { name: "Approve", exact: true });
    await expect(approve.first()).toBeVisible({ timeout: 15_000 });
    const before = await approve.count();
    expect(before).toBeGreaterThan(0);

    await approve.first().click();
    const dialog = page.getByRole("alertdialog", { name: "Approve this device" });
    await expect(dialog).toBeVisible();
    // Stated on the ceremony itself, because approval is not a formality: it is what makes the handset
    // able to capture at all.
    await expect(dialog.getByText(/every check-in from this handset is refused/i)).toBeVisible();
    await dialog.getByRole("button", { name: "Approve device" }).click();

    // The dialog closes only on a committed write; a refusal keeps it open with the server's message.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // And the round trip: an approved device is no longer pending approval, so the queue is one shorter.
    // Asserting the COUNT rather than "the queue is empty" keeps this honest if the seed grows a second
    // pending handset.
    await expect(approve).toHaveCount(before - 1, { timeout: 15_000 });
  });

  test("a clinician's own device list offers no approval control", async ({ page }) => {
    // The other half of the same rule, and the cheaper one to get wrong: approving your own handset
    // would defeat the point of the control. Asserted structurally — the roster renders, and it offers
    // no approve action — rather than by driving a refusal, because the server's 403 is not what this
    // screen is for.
    await signInAs(page, SUPERVISOR_ACCOUNT());
    await page.goto("/me/evv/devices");
    await expect(page.getByRole("heading", { name: /Devices/i }).first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  });

  test("the pending-device roster is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, SUPERVISOR_ACCOUNT());
    await page.goto("/evv/devices/pending");
    await expect(page.getByRole("heading", { name: "EVV Devices - Pending Approval" })).toBeVisible(
      { timeout: 15_000 },
    );
    await expectNoAxeViolations(page);
  });

  test("release evidence: correction ceremony and aggregator status stay honest", async ({
    page,
  }) => {
    await signInAs(page, SUPERVISOR_ACCOUNT());
    await page.goto("/evv/events");
    await expectRouteReached(page, "/evv/events");
    await expect(page.getByRole("heading", { name: "EVV Event Ledger" })).toBeVisible({
      timeout: 15_000,
    });

    const eventRows = page.locator("tbody tr[role=button]");
    await expect(eventRows.first()).toBeVisible({ timeout: 15_000 });
    const eventCount = await eventRows.count();
    expect(
      eventCount,
      "the synthetic field-operations seed should contain EVV events",
    ).toBeGreaterThan(0);

    let correctableEventFound = false;
    for (let index = 0; index < eventCount; index += 1) {
      await eventRows.nth(index).click();
      await expect(page.getByRole("heading", { name: "EVV Event Detail" })).toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByRole("heading", { name: "Recorded evidence" })).toBeVisible({
        timeout: 15_000,
      });
      const correction = page.getByRole("button", { name: "File correction" });
      const correctionVisible = await correction
        .waitFor({ state: "visible", timeout: 3_000 })
        .then(() => true)
        .catch(() => false);
      if (correctionVisible) {
        correctableEventFound = true;
        await correction.click();
        break;
      }
      await page.goto("/evv/events");
      await expect(page.getByRole("heading", { name: "EVV Event Ledger" })).toBeVisible();
    }

    expect(
      correctableEventFound,
      "the seed should contain a current event eligible for correction",
    ).toBe(true);
    const correctionDialog = page.getByRole("dialog", { name: "Correct EVV event" });
    await expect(correctionDialog).toBeVisible();
    await expect(correctionDialog.getByText(/original event remains unchanged/i)).toBeVisible();
    await expect(
      correctionDialog.getByRole("button", { name: "Create correction" }),
    ).toBeDisabled();
    await captureEvvEvidence(page, "correction-ceremony");
    await correctionDialog.getByRole("button", { name: "Cancel" }).click();

    await page.goto("/evv/aggregator-submissions");
    await expectRouteReached(page, "/evv/aggregator-submissions");
    await expect(page.getByRole("heading", { name: "Aggregator Submissions" })).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      page.getByText("Configuration status unavailable", { exact: false }),
    ).toBeVisible();

    const evidenceButtons = page.getByRole("button", { name: "View evidence" });
    if ((await evidenceButtons.count()) > 0) {
      await evidenceButtons.first().click();
      const evidenceDialog = page.getByRole("dialog", { name: "Submission evidence" });
      await expect(evidenceDialog).toBeVisible();
      await expect(
        evidenceDialog.getByText(/not a payer claim decision or payment status/i),
      ).toBeVisible();
      await captureEvvEvidence(page, "aggregator-evidence");
    } else {
      await expect(page.getByText("No submission records")).toBeVisible();
      await expect(page.getByText(/empty queue does not confirm/i)).toBeVisible();
      await captureEvvEvidence(page, "aggregator-empty-state");
    }
  });
});
