// e2e/specs/billing-commercial.spec.ts — Billing — Commercial (M41, issue #726): the claim work queue, the payer-kind filter, the
// claim drawer and the supported-payers view, in a real browser behind a real sign-in.
//
// The commercial READ routes are stubbed with `page.route`: no seed scenario assembles a commercial claim (that needs a commercial
// payer plan, route, contract rates and a commercial patient coverage, covered by the M41 live suites over the real database), so the
// browser test pins the screens' behaviour, keyboard operation and accessibility against deterministic, synthetic responses. The
// shell, sign-in, provider-entity list and routing are real. Nothing here touches PHI.
import { type Page, expect, test } from "@playwright/test";
import { ADMIN_ACCOUNT } from "../fixtures/credentials";
import { expectNoAxeViolations, signInAs } from "../fixtures/helpers";

const CLAIMS = "**/api/v1/billing/commercial/claims*";
const PLANS = "**/api/v1/billing/commercial/payer-plans*";
const ENROLLMENTS = "**/api/v1/billing/commercial/enrollments*";

const row = (over: Record<string, unknown>) => ({
  id: "66666666-6666-4666-8666-666666666666",
  claimControlNumber: "CCN-E2E-0001",
  state: "draft",
  patientId: "33333333-3333-4333-8333-333333333333",
  planId: "44444444-4444-4444-8444-444444444444",
  planName: "Synthetic PPO",
  tob: "812",
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
  secondaryPayerKind: null,
  totalChargeCents: 620_000,
  expectedPaymentCents: 620_000,
  updatedAt: "2026-10-25T10:00:00.000Z",
  ...over,
});

const COMMERCIAL_ONLY = row({});
const MEDICARE_SECONDARY = row({
  id: "66666666-6666-4666-8666-777777777777",
  claimControlNumber: "CCN-E2E-0002",
  state: "ready",
  secondaryPayerKind: "medicare",
});

// The screens probe the default provider entity with the payer-plans read before the queue loads.
async function stubProbe(page: Page): Promise<void> {
  await page.route(PLANS, (route) => route.fulfill({ json: { items: [] } }));
}

async function stubQueue(page: Page, requests: string[]): Promise<void> {
  await stubProbe(page);
  await page.route(CLAIMS, async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.search);
    const kind = url.searchParams.get("payerKind");
    const items =
      kind === "medicare_secondary"
        ? [MEDICARE_SECONDARY]
        : kind === "commercial_only"
          ? [COMMERCIAL_ONLY]
          : [COMMERCIAL_ONLY, MEDICARE_SECONDARY];
    await route.fulfill({ json: { items, hasMore: false, nextCursor: null } });
  });
}

test.describe("Billing — Commercial claim work queue (M41)", () => {
  test("main path: lists commercial claims, filters by payer kind and opens the drawer by keyboard", async ({
    page,
  }) => {
    const requests: string[] = [];
    await stubQueue(page, requests);
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/claims");

    await expect(page.getByRole("heading", { name: "Commercial Claims", level: 1 })).toBeVisible();
    const table = page.getByRole("table", { name: "Commercial claims" });
    await expect(table.getByRole("link", { name: "CCN-E2E-0001", exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: "CCN-E2E-0002", exact: true })).toBeVisible();

    // The payer-kind filter narrows the queue and is sent to the API, not applied in the browser.
    await page.getByLabel("Payer kind").selectOption("medicare_secondary");
    await expect(table.getByRole("link", { name: "CCN-E2E-0001", exact: true })).toHaveCount(0);
    await expect(table.getByRole("link", { name: "CCN-E2E-0002", exact: true })).toBeVisible();
    expect(requests.some((q) => q.includes("payerKind=medicare_secondary"))).toBe(true);
    await expect(table.getByText("Commercial + Medicare secondary")).toBeVisible();

    // Row activation by keyboard opens the drawer; Escape closes it and returns focus to the row.
    const claimRow = table.getByRole("row", { name: /CCN-E2E-0002/ });
    await claimRow.focus();
    await page.keyboard.press("Enter");
    const drawer = page.getByRole("complementary", { name: "Claim CCN-E2E-0002" });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Open claim detail" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(claimRow).toBeFocused();
  });

  test("main path: Load more follows the server's keyset cursor and appends the next page", async ({
    page,
  }) => {
    const cursors: (string | null)[] = [];
    await stubProbe(page);
    await page.route(CLAIMS, async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      cursors.push(cursor);
      await route.fulfill({
        json: cursor
          ? { items: [MEDICARE_SECONDARY], hasMore: false, nextCursor: null }
          : { items: [COMMERCIAL_ONLY], hasMore: true, nextCursor: "CUR-E2E-1" },
      });
    });
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/claims");
    const table = page.getByRole("table", { name: "Commercial claims" });
    await expect(table.getByRole("link", { name: "CCN-E2E-0001", exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: "CCN-E2E-0002", exact: true })).toHaveCount(0);

    await page.getByRole("button", { name: "Load more" }).click();
    await expect(table.getByRole("link", { name: "CCN-E2E-0002", exact: true })).toBeVisible();
    await expect(table.getByRole("link", { name: "CCN-E2E-0001", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    expect(cursors.at(-1)).toBe("CUR-E2E-1");
  });

  test("failure path: an unavailable queue is announced and Try again recovers", async ({
    page,
  }) => {
    let fail = true;
    await stubProbe(page);
    await page.route(CLAIMS, async (route) => {
      if (fail) await route.fulfill({ status: 500, json: { error: { code: "INTERNAL" } } });
      else
        await route.fulfill({
          json: { items: [COMMERCIAL_ONLY], hasMore: false, nextCursor: null },
        });
    });
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/claims");

    await expect(page.getByRole("alert").filter({ hasText: "Claims unavailable" })).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(
      page.getByRole("link", { name: "CCN-E2E-0001", exact: true }).first(),
    ).toBeVisible();
  });

  test("accessibility: the claim queue has no WCAG 2A/AA violations", async ({ page }) => {
    await stubQueue(page, []);
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/claims");
    await expect(
      page.getByRole("link", { name: "CCN-E2E-0001", exact: true }).first(),
    ).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("Billing — Commercial supported payers (M41)", () => {
  const plan = {
    id: "44444444-4444-4444-8444-444444444444",
    payerId: "55555555-5555-4555-8555-555555555555",
    planName: "Synthetic PPO",
    claimFilingIndicator: "CI",
    authorizationRequirement: "required_at_admission",
    authorizationLeadDays: 3,
    eligibilityStalenessPolicy: "warn",
    eligibilityMaxAgeDays: 30,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    payerStatus: "active",
    routes: [
      {
        clearinghouseKey: "stedi",
        clearinghousePayerId: "SYNTH01",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    ],
  };

  test("main path: shows the plan with its route and 'Not Enrolled' when no enrollment exists", async ({
    page,
  }) => {
    await page.route(PLANS, (route) => route.fulfill({ json: { items: [plan] } }));
    await page.route(ENROLLMENTS, (route) => route.fulfill({ json: { items: [] } }));
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/payers");

    await expect(page.getByRole("heading", { name: "Supported Payers", level: 1 })).toBeVisible();
    const table = page.getByRole("table", { name: "Supported commercial payers" });
    await expect(table.getByText("Synthetic PPO")).toBeVisible();
    await expect(table.getByText("stedi: SYNTH01")).toBeVisible();
    await expect(table.getByText("Not Enrolled")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("Billing — Commercial authorizations (M41)", () => {
  const PATIENT = "33333333-3333-4333-8333-333333333333";
  const plan = {
    id: "44444444-4444-4444-8444-444444444444",
    payerId: "55555555-5555-4555-8555-555555555555",
    planName: "Synthetic PPO",
    claimFilingIndicator: "CI",
    authorizationRequirement: "required_at_admission",
    authorizationLeadDays: 3,
    eligibilityStalenessPolicy: "warn",
    eligibilityMaxAgeDays: 30,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    payerStatus: "active",
    routes: [],
  };
  const authorization = {
    id: "77777777-7777-4777-8777-777777777777",
    patientId: PATIENT,
    planId: plan.id,
    levelOfCare: "routine_home_care",
    status: "approved",
    obtainedOn: "2026-02-20",
    effectiveFrom: "2026-03-01",
    effectiveTo: "2026-03-31",
  };

  test("main path: lists a patient's authorization and opens its drawer without ever showing a number", async ({
    page,
  }) => {
    await page.route(PLANS, (route) => route.fulfill({ json: { items: [plan] } }));
    await page.route("**/api/v1/billing/commercial/authorizations*", (route) =>
      route.fulfill({ json: { items: [authorization] } }),
    );
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/commercial/billing/authorizations?patient=${PATIENT}`);

    await expect(page.getByRole("heading", { name: "Authorizations", level: 1 })).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByText("Synthetic PPO")).toBeVisible();
    await table.getByText("Synthetic PPO").click();
    await expect(page.getByLabel("Authorization for Synthetic PPO")).toBeVisible();
    await expect(page.getByText("never shown")).toBeVisible();
    await expectNoAxeViolations(page);
  });
});

test.describe("Billing — Commercial enrollments (M41)", () => {
  const PAYER = "55555555-5555-4555-8555-555555555555";
  const plan = {
    id: "44444444-4444-4444-8444-444444444444",
    payerId: PAYER,
    planName: "Synthetic PPO",
    claimFilingIndicator: "CI",
    authorizationRequirement: "required_at_admission",
    authorizationLeadDays: 3,
    eligibilityStalenessPolicy: "warn",
    eligibilityMaxAgeDays: 30,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    payerStatus: "active",
    routes: [],
  };
  const enrollment = {
    id: "88888888-8888-4888-8888-888888888888",
    providerEntityId: "22222222-2222-4222-8222-222222222222",
    payerId: PAYER,
    clearinghouseKey: "stedi",
    status: "enrolled",
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    evidenceRef: "DOC-E2E/1#a",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  test("main path: lists enrollments, then adds one through the drawer", async ({ page }) => {
    const rows = [enrollment];
    const posted: unknown[] = [];
    await page.route(PLANS, (route) => route.fulfill({ json: { items: [plan] } }));
    await page.route(ENROLLMENTS, async (route) => {
      if (route.request().method() === "POST") {
        posted.push(route.request().postDataJSON());
        const added = {
          ...enrollment,
          id: "99999999-9999-4999-8999-999999999999",
          clearinghouseKey: "other",
        };
        rows.push(added);
        await route.fulfill({ status: 201, json: added });
        return;
      }
      await route.fulfill({ json: { items: rows } });
    });
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto("/commercial/billing/enrollments");

    await expect(page.getByRole("heading", { name: "Enrollments", level: 1 })).toBeVisible();
    const table = page.getByRole("table", { name: "Payer enrollments" });
    await expect(table.getByText("stedi")).toBeVisible();
    await expect(table.getByText("DOC-E2E/1#a")).toBeVisible();

    await page.getByRole("button", { name: "Add enrollment" }).click();
    const drawer = page.getByRole("complementary", { name: "Add enrollment" });
    await drawer.getByLabel("Payer").selectOption(PAYER);
    await drawer.getByLabel("Clearinghouse key").fill("other");
    await drawer.getByLabel("Effective from").fill("2026-02-01");
    await drawer.getByRole("button", { name: "Add enrollment" }).click();

    await expect(page.getByText("Enrollment added.")).toBeVisible();
    await expect(table.getByText("other")).toBeVisible();
    expect(posted).toHaveLength(1);
    await expectNoAxeViolations(page);
  });
});

test.describe("Billing — Commercial eligibility (M41)", () => {
  const PATIENT = "33333333-3333-4333-8333-333333333333";
  const PLAN = "44444444-4444-4444-8444-444444444444";
  const plan = {
    id: PLAN,
    payerId: "55555555-5555-4555-8555-555555555555",
    planName: "Synthetic PPO",
    claimFilingIndicator: "CI",
    authorizationRequirement: "required_at_admission",
    authorizationLeadDays: 3,
    eligibilityStalenessPolicy: "warn",
    eligibilityMaxAgeDays: 30,
    effectiveFrom: "2026-01-01",
    effectiveTo: null,
    payerStatus: "active",
    routes: [],
  };
  const check = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    providerEntityId: "22222222-2222-4222-8222-222222222222",
    patientId: PATIENT,
    planId: PLAN,
    clearinghouseKey: "stedi",
    serviceDate: "2026-10-20",
    outcome: "active",
    asOfDate: "2026-10-20",
    requestId: "req-1",
    checkedAt: "2026-10-24T10:00:00.000Z",
  };
  const freshness = {
    ruleId: "M41.ELIGIBILITY.FRESHNESS",
    status: "fresh",
    severity: "pass",
    message: "Eligibility was verified recently.",
    evidence: {
      ageDays: 1,
      maxAgeDays: 30,
      policy: "warn",
      outcome: "active",
      checkedAt: check.checkedAt,
    },
  };

  test("main path: shows the latest check and history for a patient, then runs a check", async ({
    page,
  }) => {
    const rows = [check];
    const posted: unknown[] = [];
    await page.route(PLANS, (route) => route.fulfill({ json: { items: [plan] } }));
    await page.route("**/api/v1/billing/commercial/eligibility/latest*", (route) =>
      route.fulfill({ json: { latest: { ...rows[0], replayed: false }, freshness } }),
    );
    await page.route("**/api/v1/billing/commercial/eligibility/check", async (route) => {
      posted.push(route.request().postDataJSON());
      const added = {
        ...check,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        serviceDate: "2026-10-25",
      };
      rows.unshift(added);
      await route.fulfill({ json: { ...added, replayed: false, freshness } });
    });
    await page.route("**/api/v1/billing/commercial/eligibility?*", (route) =>
      route.fulfill({ json: { items: rows } }),
    );
    await signInAs(page, ADMIN_ACCOUNT());
    await page.goto(`/commercial/billing/eligibility?patient=${PATIENT}&plan=${PLAN}`);

    await expect(page.getByRole("heading", { name: "Eligibility", level: 1 })).toBeVisible();
    const card = page.getByLabel("Latest eligibility check for Synthetic PPO");
    await expect(card.getByText("Fresh")).toBeVisible();
    await expect(card.getByText("Eligibility was verified recently.")).toBeVisible();
    const table = page.getByRole("table", { name: /Eligibility checks for/ });
    await expect(table.getByText("2026-10-20")).toBeVisible();

    await page.getByLabel("Service date").fill("2026-10-25");
    await page.getByRole("button", { name: "Run eligibility check" }).click();
    await expect(page.getByText("Eligibility check recorded.")).toBeVisible();
    await expect(table.getByText("2026-10-25")).toBeVisible();
    expect(posted).toHaveLength(1);
    expect(JSON.stringify(posted)).not.toMatch(/member/i);
    await expectNoAxeViolations(page);
  });
});
