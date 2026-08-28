// e2e/specs/orders.spec.ts — critical workflow: sign an order from the Signature Inbox (F-031, #91).
//
// #91's fifth acceptance criterion asks for at least one E2E spec per module driving the primary
// authored-then-signed path. Twelve module rows were built and DOM-covered; only two of the twelve —
// M13 eMAR and M22 Documents — ever got a browser spec. This is M11's, the module the issue ranks
// immediately behind eMAR.
//
// The queue IS the workflow here. Four of M11's seven screens are queues, and until #91 they issued no
// mutation at all: a clinician could open "orders awaiting your signature" and have no way to sign one.
// So the path worth driving is not a form submit, it is the round trip — the order appears in the inbox,
// the signature is taken from the row, and the order LEAVES the inbox. That last half is what a spec
// asserting "the POST returned 200" would miss, and it is the half a clinician would notice.
//
// THE SEED HAD TO CHANGE FIRST, and that is the point rather than a detail.
// `db:seed:scenario-orders-idg` drove its only order all the way to `signed`, so the Signature Inbox was
// permanently EMPTY on a seeded stack and the only spec anyone could have written against it would have
// asserted the empty state — passing forever, proving nothing. That is exactly the shape #106/F-046 names
// in the billing spec. The seed now leaves a second, cosigned DME order awaiting signature.
//
// THIS SPEC CONSUMES ITS SEED, deliberately. Signing the pending order empties the inbox, so a second
// run against the same database fails at the "the queue has something in it" assertion rather than
// passing on an empty one. That is the guard working, not a flaw: verified by running it twice, and it is
// the same property `emar.spec.ts` relies on. CI reseeds (`db:seed:all`) before the suite; locally,
// re-run `bun run db:seed:scenario-orders-idg` between runs.
//
// Signs in as the RN, not the admin: `signer_eligible` (§4.7) resolves the caller's disciplines from
// their M3 role grants and matches them against the order kind's signer matrix, and `admin@` holds every
// permission key and no clinical role — it passes RBAC and is refused by ABAC. The same split
// `emar.spec.ts` signs in around. Rita holds `rn_case_manager`, which is in the signer vocabulary, so the
// modal's "Signing as" select resolves to exactly one option.
import { expect, test } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

test.describe("Orders", () => {
  test("main path: an RN signs an order and it leaves the signature inbox", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "Orders Awaiting Signature" })).toBeVisible();

    // The queue has something in it. If this fails, the seed regressed — and the whole spec would
    // otherwise pass vacuously on an empty inbox, which is the failure mode it exists to prevent.
    const signButtons = page.getByRole("button", { name: "Sign", exact: true });
    await expect(signButtons.first()).toBeVisible({ timeout: 15_000 });
    const before = await signButtons.count();
    expect(before).toBeGreaterThan(0);

    await signButtons.first().click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Sign order" })).toBeVisible();

    // `signerDiscipline` is PROVENANCE, not authorization — which of the caller's roles they signed as.
    // Rita holds one role in the signer vocabulary, so the modal preselects it and the ceremony is not
    // blocked on a choice with a single answer.
    await expect(dialog.getByLabel("Signing as")).toHaveValue("rn_case_manager");

    await dialog.getByRole("button", { name: "Sign", exact: true }).click();

    // The dialog closes only on a committed write; a refusal keeps it open carrying the server's own
    // message, so "it closed" is a real assertion about the mutation rather than about the button.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // And the round trip: a signed order is no longer awaiting signature, so the queue is one shorter.
    // Asserting the COUNT rather than "the inbox is empty" keeps the spec honest if the seed ever grows
    // a second pending order.
    await expect(signButtons).toHaveCount(before - 1, { timeout: 15_000 });
  });

  test("the signature inbox is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, RN_ACCOUNT());
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "Orders Awaiting Signature" })).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("the cosign-pending queue renders its own action, not a read-only list", async ({
    page,
  }) => {
    // The second half of #91's M11 row: every queue offers the action it exists for. This one is
    // asserted structurally rather than driven to completion — the seeded order's cosignature is already
    // attached, so there is nothing legitimately cosignable, and manufacturing one would be testing the
    // seed rather than the screen.
    await signInAs(page, RN_ACCOUNT());
    await page.goto("/orders/cosign-pending");
    await expect(page.getByRole("heading", { name: /Cosign/i })).toBeVisible();
    // Either rows with a Cosign action, or an empty state that says so — never a table with no action
    // column, which is what this screen was before #91.
    const emptyState = page.getByText(/no orders/i);
    const cosignButtons = page.getByRole("button", { name: "Cosign", exact: true });
    await expect(async () => {
      const empty = await emptyState.count();
      const actions = await cosignButtons.count();
      expect(empty + actions).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
  });
});
