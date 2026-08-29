// e2e/fixtures/helpers.ts — shared sign-in + accessibility helpers for the WX-PR-018 critical-
// workflow suite. Plain functions (not custom Playwright fixtures) so each spec stays explicit
// about which account it signs in as, matching the "deterministic users" implementation step.
import AxeBuilder from "@axe-core/playwright";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { DEMO_ORG_NAME, type DemoAccount } from "./credentials";

/** Signs in as `account`, binds the shared demo org, and waits for the shell to land on Home. */
export async function signInAs(page: Page, account: DemoAccount): Promise<void> {
  await page.goto("/login");
  await page.getByPlaceholder("you@agency.org").fill(account.email);
  await page.getByPlaceholder("••••••••••").fill(account.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/login/organization");
  await page.getByRole("button", { name: new RegExp(DEMO_ORG_NAME) }).click();
  // organization-select does a hard `window.location.assign("/")` — wait for the real navigation.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
}

/**
 * Signs out by calling Better Auth's own `/api/auth/sign-out` endpoint via `page.evaluate` + the
 * real page `fetch` — NOT `page.request.post`, which is Playwright's separate APIRequestContext and
 * does not send a real `Origin` header the way a page-context request does. Better Auth's own
 * origin check (packages/auth/src/identity/auth.ts `trustedOrigins`) rejects an Origin-less request
 * with 403 `MISSING_OR_NULL_ORIGIN`, so `page.request.post` silently never actually signed the
 * session out — this is the same call the app's own `authClient.signOut()` makes under the hood, run
 * from inside the real page so it looks like a genuine browser request. There is no persistent
 * sign-out menu in the shell chrome to click (per apps/web/src/shell/layout.tsx; the only in-app
 * affordance is the idle screen-lock overlay's "Sign out instead" button).
 */
export async function signOut(page: Page): Promise<void> {
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", { method: "POST", credentials: "include" }),
  );
  await page.goto("/login");
}

/**
 * F-023 (#56) — wait for in-flight CSS transitions/animations before scanning.
 *
 * A scan is only meaningful against the page a user actually sees. The app shell fades its primary
 * navigation in on every load, and mid-transition those labels compute to `#ededec` on `#ffffff` —
 * contrast 1.17, which axe correctly calls a `color-contrast` violation across ~32 nodes. They
 * settle to `rgb(86, 82, 76)` (~7:1, comfortably AA) within about 300ms. WCAG does not require
 * contrast to hold DURING a transition, so those reports were the scanner racing the paint, not a
 * defect — but they failed two E2E tests non-deterministically and, worse, buried the one real
 * violation in the same run under thirty-two false ones.
 *
 * `getAnimations()` covers CSS transitions as well as animations, so this waits on the real thing
 * rather than sleeping a guessed interval. The `finished` promises are caught individually: an
 * animation cancelled by a re-render rejects, and a cancelled animation is a settled one.
 * `waitForLoadState("networkidle")` first, so an animation kicked off by late-arriving data is
 * already in flight by the time we enumerate.
 */
async function waitForTransitionsToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.evaluate(async () => {
    await Promise.all(
      document.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/**
 * Runs an axe scan restricted to WCAG 2.1 A/AA and fails with the violated rule ids + targets.
 * `excludeSelectors` is for a REVIEWED, TRACKED, already-known gap only (mirrors
 * scripts/check-audit-exceptions.ts's exception style) — never a blanket way to silence a page;
 * everything else on the page is still fully scanned.
 */
export async function expectNoAxeViolations(
  page: Page,
  excludeSelectors: readonly string[] = [],
): Promise<void> {
  await waitForTransitionsToSettle(page);
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]);
  for (const selector of excludeSelectors) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary, `axe violations:\n${summary.join("\n")}`).toEqual([]);
}

/**
 * Enrol a WebAuthn passkey on the current session, so the account can satisfy a step-up gate (F-081).
 *
 * A Chromium VIRTUAL AUTHENTICATOR (CDP `WebAuthn.addVirtualAuthenticator`) stands in for the
 * hardware. Everything else is the product's own path: the real `/security/passkeys` screen, the real
 * `navigator.credentials.create` ceremony, Better Auth's real `verify-registration`, and the real row
 * in `passkey`. Nothing is faked at the API boundary — the point of driving step-up from a browser at
 * all is that this is the ONE layer no server-side test can reach, and the three defects it found were
 * each invisible from every other layer.
 *
 * Completion is judged by the VIRTUAL AUTHENTICATOR holding a credential, not by the screen's list
 * losing its empty state. A passkey row survives in the database from an earlier run while the private
 * key does not — it lived in that run's virtual authenticator, which is gone — so "the list is not
 * empty" is true before this call does anything, and the step-up that followed then asked a fresh
 * authenticator to assert a credential it had never held. That failure surfaces as "Passkey
 * verification was cancelled or failed", which reads like a flaky ceremony rather than a stale fixture.
 */
export async function enrolPasskey(page: Page): Promise<string> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      // The ceremony asks for `userVerification: "required"`, and a real device would prompt for a
      // biometric here. These two make the virtual authenticator answer the prompt itself.
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto("/security/passkeys");
  await expect(page.getByRole("heading", { name: "Passkeys" })).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Register passkey" }).click();
  await expect
    .poll(
      async () =>
        (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials.length,
      { timeout: 20_000, message: "the virtual authenticator never received a credential" },
    )
    .toBeGreaterThan(0);
  // …and the server stored it: the screen's list is what a second, independent read looks like. It
  // renders `name ?? "Passkey"`, and nothing here types a name — `passkey.name` is nullable (0234).
  await expect(page.getByText("No passkeys")).toBeHidden({ timeout: 15_000 });
  return authenticatorId;
}

/**
 * Complete a step-up re-authentication with the passkey `enrolPasskey` registered, landing back on
 * `returnTo`. This is the real `/step-up` screen and the real `POST /api/v1/sessions/step-up`, which
 * paired-writes `session.last_step_up_at` — the fact 138 `requireStepUp` guards across 23 modules read.
 */
export async function stepUpWithPasskey(page: Page, returnTo: string): Promise<void> {
  await page.goto(`/step-up?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("button", { name: "Verify with a passkey" }).click();
  // Success navigates to `returnTo`; a failure keeps the screen up carrying the server's message.
  await page.waitForURL((url) => url.pathname + url.search === returnTo, { timeout: 20_000 });
}
