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
// TWO FINDINGS THIS SPEC DOES NOT FIX, recorded here because chasing them is how it got written:
//
//   1. The missing-EVV resolution queue can only ever be populated by a CORRECTION. `evv_missing_
//      resolution` has exactly one writer in the backend — the correction-of-record path, which needs
//      a check-in to already exist in order to correct it. A visit that simply never captured produces
//      nothing. The designed path is M17's late-check sweep emitting
//      `m17.visit.late_check_out_suspected`, whose catalog entry says in as many words "M18 opens an
//      evv_missing_resolution row (M18 §7 / D6)". M18's side of that is a REGISTERED deferral in
//      `scripts/outbox-deferred-consumers.ts` ("the remainder are forward declarations") — a declared
//      absence, correctly tracked. The M17 side is not: NOTHING in the codebase emits that event. So
//      even binding the consumer would deliver nothing, and the queue that exists to prove a visit
//      happened when the device did not record it is unreachable.
//   2. Consequently the Aggregator Submission queue is empty too, and its resubmit/cancel controls are
//      likewise unexercisable on a seeded stack.
//
// Signs in as the SUPERVISOR, not the RN who owns the handset: `/me/evv/devices` deliberately offers no
// approve control, because approving a device is an act on someone else's equipment.
import { expect, test } from "@playwright/test";
import { SUPERVISOR_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

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
});
