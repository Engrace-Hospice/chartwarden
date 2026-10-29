// e2e/specs/idg.spec.ts — critical workflow: adjourn the IDG meeting, through a real step-up (F-081, #91).
//
// #91's fifth acceptance criterion asks for one E2E spec per module driving the primary write path.
// M14's is the §2.2 D13 adjournment: the commit point that emits every open decision to the downstream
// modules, freezes the packets, finalizes the immutable minutes, and resets the 42 CFR 418.56(d)
// 15-day review floor for each patient reviewed. It is the one write in the module that matters.
//
// IT REQUIRES A FRESH STEP-UP, AND NO HUMAN COULD PERFORM ONE. That is what this spec is really about.
//
// The platform gates 138 route guards across 23 modules on `requireStepUp`, resolved from
// `session.last_step_up_at`. F-029 established that the routes which write that column were mounted by
// nobody and fixed it. What nothing had checked is whether the FACTOR those routes require can be
// enrolled — and it could not, by any user, in any deployment, for three independent reasons, each of
// which alone was fatal, and none of which is visible from any layer below a real browser:
//
//   1. The passkey `origin` came from `BETTER_AUTH_URL` — the AUTH SERVER's base URL — while WebAuthn's
//      expected origin is the origin of the PAGE that ran the ceremony, i.e. the SPA. Every registration
//      was refused: `Unexpected registration response origin "<spa>", expected "<api>"`.
//   2. `passkey.name` was NOT NULL with no default. Better Auth's plugin treats the name as optional and
//      inserts the column default when it is absent; the enrolment screen's name field is optional and
//      its own list renders `name ?? "Passkey"`. Leaving it blank — the default state of the form —
//      raised 23502 and `verify-registration` answered 500.
//   3. The step-up challenge was minted as a 32-character HEX string and handed to the browser as the
//      challenge BYTES. The authenticator echoes the challenge back base64url-encoded, and the server
//      compared that against the hex it had issued. Every assertion this platform could produce was
//      rejected as `webauthn_verification_failed` — a real passkey, correctly signed, reported as a
//      forgery.
//
// There is no TOTP enrolment surface in any front-end, so the passkey was the only enrollable factor
// and it could not be enrolled. Every step-up-gated write in the product was therefore unreachable from
// the UI: encounter signing (CoP 418.104(c)), claim submit, cost-report submit, GIP attestation,
// restraint application, consent signing — and this.
//
// TWO MORE THINGS HAD TO CHANGE FOR THE CEREMONY TO BE USABLE, AND BOTH ARE ASSERTED BELOW.
//
//   • A 401 from the step-up VERIFY route means "that factor did not verify", not "your session is
//     gone" — but the shell's global handler saw only the status and bounced the user to `/expired` on
//     their FIRST wrong code. That made the route's own lockout counter unreachable (attempts 2 and 3
//     could never happen) and the screen's "try again" branch dead.
//   • M14 was the one module that TOLD a coordinator to re-authenticate and gave them no way to: the
//     `/step-up` screen is chromeless, absent from nav, and reached only by a redirect that five other
//     modules perform and this one did not. The dialog now offers "Re-authenticate" on the 412 — after
//     one has happened, never before, because a permanent step-up button beside a commit point trains
//     people to re-authenticate ahead of being asked, which is the opposite of a freshness window.
//
// THE SEED HAD TO CHANGE FIRST, the #106/F-046 shape again: it adjourned the meeting itself, using a
// DB-direct stamp of `session.last_step_up_at` because no script can run a WebAuthn ceremony. So the
// only IDG meeting on a seeded stack was already terminal and the commit point had nothing to act on.
// The meeting is left in session now and the shortcut is deleted — this spec performs the real
// ceremony instead, which is a stronger statement than the shortcut ever made.
//
// THIS SPEC CONSUMES ITS SEED: adjourning is terminal, so a second run against the same database finds
// no live meeting and fails at the first assertion rather than passing vacuously. CI reseeds before the
// suite; locally re-run `bun run db:seed:scenario-orders-idg` between runs.
import { expect, test } from "@playwright/test";
import { PRESCRIBER_ACCOUNT } from "../fixtures/credentials";
import {
  enrolPasskey,
  expectNoAxeViolations,
  signInAs,
  stepUpWithPasskey,
} from "../fixtures/helpers";

/**
 * The main service location `db:seed:org-structure` creates.
 *
 * It is spelled out here because NOTHING IN THE APP PRODUCES THE LINK. `/idg/schedule` is a
 * per-location read that takes its location from `?location=`, the nav entry points at the bare path,
 * and the screen's own answer to a missing location is an EmptyState — "Open this schedule from a
 * location context" — with no picker in it. So the IDG Schedule nav item, followed as a user follows
 * it, is permanently empty on every deployment, whatever is on the calendar. Left as a finding rather
 * than fixed here: which locations a coordinator may pick from, and whether the shell should carry a
 * location context at all, is a design decision this spec has no standing to take.
 */
const LOCATION_MAIN_ID = "55555555-0000-4000-8000-000000000001";

test.describe("IDG", () => {
  test("main path: the D13 commit point refuses a stale session, then adjourns after a real step-up", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await signInAs(page, PRESCRIBER_ACCOUNT());

    // The one seeded meeting, in session. Filtered on the state as well, so a re-run against an
    // already-adjourned database fails HERE — visibly — rather than somewhere further down.
    await page.goto(`/idg/schedule?location=${LOCATION_MAIN_ID}`);
    await expect(page.getByRole("heading", { name: "IDG Schedule" })).toBeVisible({
      timeout: 15_000,
    });
    // Since the #m14 redesign the row holds its own link, so it no longer carries `role="button"` (a
    // button may not wrap focusable content): it is a plain `row` again, opened through its title link.
    const liveRow = page.getByRole("row").filter({ hasText: "Live" }).first();
    await expect(liveRow).toBeVisible({ timeout: 15_000 });
    await liveRow.getByRole("link", { name: "IDG meeting", exact: true }).click();
    await page.waitForURL(/\/idg\/meetings\/[^/]+/, { timeout: 15_000 });
    const meetingUrl = new URL(page.url());
    const meetingPath = meetingUrl.pathname;

    // The live surface is where the ceremony lives.
    await page.goto(`${meetingPath}/live`);
    await expect(page.getByRole("button", { name: "Adjourn" })).toBeEnabled({ timeout: 15_000 });

    // ── 1. The gate refuses a session with no fresh step-up ────────────────────────────────────────
    //
    // This is a control working, and asserting it is the point: the refusal must be a REFUSAL, not a
    // silent success. The session is fresh from `signInAs` and still not enough — freshness here means
    // a second factor within the policy window, which signing in with a password never establishes.
    await page.getByRole("button", { name: "Adjourn" }).click();
    const dialog = page.getByRole("dialog", { name: "Adjourn the meeting" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox").check(); // the dialog now asks for an attestation first
    await dialog.getByRole("button", { name: "Finalize & Adjourn" }).click();
    await expect(dialog.getByRole("alert")).toContainText("fresh re-authentication", {
      timeout: 15_000,
    });

    // …and the way out of it is offered, which it was not before F-081.
    await expect(dialog.getByRole("button", { name: "Re-authenticate" })).toBeVisible();

    // ── 2. Enrol a passkey and complete the real ceremony ──────────────────────────────────────────
    //
    // A Chromium virtual authenticator stands in for the hardware; everything else is the product's
    // own path — the real `/security/passkeys` screen, the real `navigator.credentials` ceremonies,
    // Better Auth's real registration verification, and the real `POST /api/v1/sessions/step-up` that
    // paired-writes `session.last_step_up_at`.
    await enrolPasskey(page);
    await stepUpWithPasskey(page, `${meetingPath}/live`);

    // ── 3. The same action, now permitted ──────────────────────────────────────────────────────────
    await expect(page.getByRole("button", { name: "Adjourn" })).toBeEnabled({ timeout: 15_000 });
    await page.getByRole("button", { name: "Adjourn" }).click();
    const secondDialog = page.getByRole("dialog", { name: "Adjourn the meeting" });
    await expect(secondDialog).toBeVisible();
    await secondDialog.getByRole("checkbox").check(); // the dialog now asks for an attestation first
    await secondDialog.getByRole("button", { name: "Finalize & Adjourn" }).click();
    // The dialog closes only on a committed write; a refusal keeps it open carrying the server's copy.
    await expect(secondDialog).toBeHidden({ timeout: 20_000 });

    // The round trip: the server re-read the meeting and it is adjourned. Asserted off the reloaded
    // surface rather than the POST's status code, so this is a statement about the record.
    await page.goto(`${meetingPath}/live`);
    await expect(page.getByText("Adjourned", { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
    // …and the commit point is not offered twice: `adjourned` is terminal.
    await expect(page.getByRole("button", { name: "Adjourn" })).toHaveCount(0); // no longer rendered once adjourned
  });

  test("the IDG schedule is accessible (WCAG 2.1 A/AA)", async ({ page }) => {
    await signInAs(page, PRESCRIBER_ACCOUNT());
    await page.goto(`/idg/schedule?location=${LOCATION_MAIN_ID}`);
    await expect(page.getByRole("heading", { name: "IDG Schedule" })).toBeVisible({
      timeout: 15_000,
    });
    await expectNoAxeViolations(page);
  });
});
