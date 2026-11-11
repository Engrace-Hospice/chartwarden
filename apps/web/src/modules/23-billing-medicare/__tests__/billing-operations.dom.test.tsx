import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { BillingInvestigationPanel } from "../billing-investigation-panel";
import { BillingOperations } from "../billing-operations";

afterEach(cleanup);

const ok = (data: unknown) => ({ data, response: new Response(null, { status: 200 }) });
const denied = () => ({
  error: { error: { code: "FORBIDDEN" } },
  response: new Response(null, { status: 403 }),
});
const providers = ["provider-a", "provider-b"];
function mount(
  get: ReturnType<typeof vi.fn>,
  path = "/billing/operations",
  permissions: string[] = [],
) {
  const post = vi.fn();
  render(
    <ApiClientProvider client={{ GET: get, POST: post } as unknown as ApiClient}>
      <SessionProvider
        session={{
          userId: "u1",
          organizationId: "o1",
          providerEntityIds: providers,
          locationIds: ["location-a"],
          permissions,
        }}
      >
        <MemoryRouter initialEntries={[path]}>
          <BillingOperations />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { post };
}

describe("Billing Operations", () => {
  it("shows source-qualified M25 amounts and does not invent an A/R total", async () => {
    const summary = {
      dateBasis: "era_received_at_utc",
      fromDate: "2026-10-01",
      toDate: "2026-10-31",
      providerEntityId: "provider-a",
      completeness: "exact_for_m25_remittance_advice",
      receivedAdviceCount: 2,
      reportedAdviceCount: 2,
      reportedEraPaymentCents: "10000",
      reportedClaimPaymentCents: "9500",
      fullyPostedClaimPaymentCents: "7000",
      postedClaimPaymentCents: "7000",
      fullyPostedAdviceCount: 1,
      partialPostedAdviceCount: 1,
      reportedAdjustmentsByGroup: { CO: "0", CR: "0", OA: "1000", PI: "0", PR: "0" },
      reportedPlbCents: "500",
      unmatchedLineCount: 1,
      latestReceivedAt: "2026-10-30T12:00:00.000Z",
      claimMdStagesIncluded: false,
      authoritativeAr: { status: "unavailable", reasonCode: "NO_CANONICAL_RECEIVABLE_LEDGER" },
    };
    const get = vi.fn(async (path: string, _options?: unknown) => {
      if (path === "/api/v1/remittance/revenue-cycle-summary") return ok(summary);
      if (path === "/api/v1/remittance/claimmd-operational-health")
        return ok({
          scope: "tenant_attributed_m25_stages",
          completeness: "exact_for_authorized_provider_stages",
          stageCount: 4,
          states: { staged: 3, held: 1 },
          exceptionCount: 1,
          oldestExceptionAt: "2026-10-29T12:00:00.000Z",
          latestStageAt: "2026-10-30T12:00:00.000Z",
          centralCapture: {
            status: "restricted",
            reasonCode: "CENTRAL_ACCOUNT_METADATA_NOT_TENANT_VISIBLE",
          },
          requestBudget: {
            status: "unavailable",
            reasonCode: "NO_DURABLE_REQUEST_BUDGET_OBSERVATION",
          },
        });
      return ok({ items: [] });
    });
    mount(get, "/billing/operations?entity=provider-a&eraFrom=2026-10-01&eraTo=2026-10-31", [
      "remittance.read",
    ]);
    expect((await screen.findAllByText("$70.00")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Authoritative open A\/R and aging are unavailable/)).toBeTruthy();
    expect(screen.getByText("$5.00")).toBeTruthy();
    expect(await screen.findByText("Stages requiring attention")).toBeTruthy();
    expect(
      screen.getByText(/Live worker heartbeat and observed request-budget usage are unavailable/),
    ).toBeTruthy();
    expect(screen.queryByText("$30.00 open A/R")).toBeNull();
    await waitFor(() =>
      expect(
        get.mock.calls.some(
          ([path, options]) =>
            path === "/api/v1/remittance/revenue-cycle-summary" &&
            (options as { params: { query: Record<string, unknown> } }).params.query
              .providerEntityId === "provider-a",
        ),
      ).toBe(true),
    );
  });

  it("opens a read/triage investigation without offering source retry or financial actions", async () => {
    const investigation = {
      id: "case-1",
      status: "open",
      version: 1,
      sourceModule: "M41",
      sourceAttemptId: "attempt-1",
      providerEntityId: "provider-a",
      assignedToMembershipId: null,
    };
    const get = vi.fn(async (path: string) =>
      path.endsWith("/investigations/{id}")
        ? ok({
            investigation,
            source: {
              sourceModule: "M41",
              submissionId: "attempt-1",
              claimId: "claim-1",
              providerEntityId: "provider-a",
              attempt: 1,
              reference: "COM-1",
              payer: "Synthetic Plan",
              occurredAt: "2026-11-01T00:00:00Z",
              currentStatus: "in_doubt",
              sourceHref: "/commercial/billing/claims/claim-1",
              reasonCode: "TRANSPORT_TIMEOUT",
            },
            history: [],
            notes: [],
          })
        : denied(),
    );
    const post = vi.fn(async (path: string) =>
      path === "/api/v1/billing/operations/investigations"
        ? ok(investigation)
        : ok({ id: "note-1", body: "Checked source status" }),
    );
    render(
      <ApiClientProvider client={{ GET: get, POST: post } as unknown as ApiClient}>
        <SessionProvider
          session={{
            userId: "u1",
            organizationId: "o1",
            providerEntityIds: providers,
            permissions: ["billing.operations.read", "billing.operations.triage"],
          }}
        >
          <MemoryRouter>
            <BillingInvestigationPanel
              source={{
                sourceModule: "M41",
                submissionId: "attempt-1",
                providerEntityId: "provider-a",
              }}
              onClose={() => undefined}
            />
          </MemoryRouter>
        </SessionProvider>
      </ApiClientProvider>,
    );
    expect(
      await screen.findByText(
        /Submission outcome in doubt\. The request may have reached the payer\./,
      ),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open source record" }).getAttribute("href")).toBe(
      "/commercial/billing/claims/claim-1",
    );
    fireEvent.change(screen.getByLabelText("Add a note"), {
      target: { value: "Checked source status" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save note" }));
    expect(await screen.findByText("Note saved")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry|resubmit|post|payment/i })).toBeNull();
  });

  it("shows authorized source rows and routes ERA work to the existing review screen", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/provider-entities")
        return ok({ items: [{ id: "provider-a", legalName: "North Hospice" }] });
      if (path === "/api/v1/locations")
        return ok({
          items: [
            { id: "location-a", name: "North Campus" },
            { id: "location-foreign", name: "Foreign" },
          ],
        });
      if (path === "/api/v1/billing/claims")
        return ok({
          items: [
            {
              claimId: "m23-1",
              claimControlNumber: "MED-1",
              state: "denied",
              serviceFrom: "2026-10-01",
              serviceTo: "2026-10-31",
            },
          ],
        });
      if (path === "/api/v1/medicaid-claims")
        return ok({
          items: [
            {
              id: "m24-1",
              medicaidClaimControlNumber: "MCD-1",
              kind: "ffs",
              state: "denied",
              updatedAt: "2026-10-20T00:00:00.000Z",
            },
          ],
        });
      if (path === "/api/v1/billing/commercial/claims")
        return ok({
          items: [
            {
              id: "m41-1",
              claimControlNumber: "COM-1",
              planName: "Commercial Plan",
              state: "rejected",
              totalChargeCents: 10000,
            },
          ],
        });
      if (path === "/api/v1/remittance/claimmd-era")
        return ok({
          items: [
            {
              id: "stage-1",
              eraId: "ERA-1",
              providerEntityId: "provider-a",
              locationId: "location-a",
              state: "staged",
              payer: { name: "Payer A" },
              payment: { amount: 70 },
              claimCount: 1,
              identityExceptionCount: 1,
              createdAt: "2026-10-21T00:00:00Z",
            },
          ],
          nextCursor: null,
        });
      return denied();
    });
    const { post } = mount(get);
    expect((await screen.findAllByText("MED-1")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("MCD-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("COM-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("ERA ERA-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$70.00").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Open ERA review" })[0]?.getAttribute("href")).toBe(
      "/remittance/claimmd-era-review?stage=stage-1",
    );
    expect(screen.getByLabelText("Provider entity").querySelectorAll("option")).toHaveLength(3);
    expect(screen.getByLabelText("Location (ERA stages)").textContent).not.toContain("Foreign");
    expect(screen.queryByRole("button", { name: /post|approve|replay/i })).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  it("uses authorized provider context in every owner API and degrades denied sources without zero counts", async () => {
    const get = vi.fn(
      async (path: string, options?: { params?: { query?: Record<string, unknown> } }) => {
        if (path === "/api/v1/provider-entities")
          return ok({
            items: [
              { id: "provider-a", legalName: "A" },
              { id: "provider-b", legalName: "B" },
              { id: "provider-c", legalName: "C" },
            ],
          });
        if (path === "/api/v1/locations") return ok({ items: [] });
        if (path === "/api/v1/billing/claims") return denied();
        if (
          [
            "/api/v1/medicaid-claims",
            "/api/v1/billing/commercial/claims",
            "/api/v1/remittance/claimmd-era",
          ].includes(path)
        )
          return ok({ items: [], nextCursor: null });
        return denied();
      },
    );
    mount(get);
    await screen.findByText(/M23: access not granted/);
    const scoped = get.mock.calls.filter(([path]) =>
      [
        "/api/v1/medicaid-claims",
        "/api/v1/billing/commercial/claims",
        "/api/v1/remittance/claimmd-era",
      ].includes(path as string),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const [, options] of scoped)
      expect(
        (options as { params: { query: Record<string, unknown> } }).params.query.providerEntityId,
      ).toBe("provider-a");
    expect(screen.getAllByText("—", { selector: "div" }).length).toBeGreaterThan(0);
  });

  it("keeps provider selection in the URL and reloads the owner APIs for the new scope", async () => {
    const get = vi.fn(
      async (path: string, options?: { params?: { query?: Record<string, unknown> } }) =>
        path === "/api/v1/provider-entities"
          ? ok({ items: providers.map((id) => ({ id, legalName: id })) })
          : path === "/api/v1/locations"
            ? ok({ items: [] })
            : ok({ items: [], nextCursor: null }),
    );
    mount(get, "/billing/operations?entity=provider-a");
    await screen.findByRole("option", { name: "provider-b" });
    fireEvent.change(screen.getByLabelText("Provider entity"), { target: { value: "provider-b" } });
    await waitFor(() =>
      expect(
        get.mock.calls.some(
          ([path, options]) =>
            path === "/api/v1/remittance/claimmd-era" &&
            (options as { params: { query: Record<string, unknown> } }).params.query
              .providerEntityId === "provider-b",
        ),
      ).toBe(true),
    );
  });

  it("opens persisted investigation history when the source is no longer in doubt", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/provider-entities") return ok({ items: [] });
      if (path === "/api/v1/locations") return ok({ items: [] });
      if (path === "/api/v1/billing/operations/investigations")
        return ok({
          items: [{ id: "case-old", sourceModule: "M41", status: "resolved", version: 4 }],
          nextCursor: null,
        });
      if (path.endsWith("/investigations/{id}"))
        return ok({
          investigation: {
            id: "case-old",
            status: "resolved",
            version: 4,
            assignedToMembershipId: null,
          },
          source: {
            sourceModule: "M41",
            submissionId: "attempt-old",
            claimId: "claim-old",
            providerEntityId: "provider-a",
            attempt: 1,
            reference: "COM-OLD",
            payer: "Synthetic Plan",
            reasonCode: null,
            occurredAt: "2026-10-01T00:00:00Z",
            currentStatus: "sent",
            sourceHref: "/commercial/billing/claims/claim-old",
          },
          history: [],
          notes: [],
        });
      return ok({ items: [], nextCursor: null });
    });
    mount(get, "/billing/operations", ["billing.operations.read"]);
    fireEvent.click(await screen.findByRole("button", { name: "View investigation history" }));
    expect(await screen.findByText(/Current submission status: sent/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open source record" }).getAttribute("href")).toBe(
      "/commercial/billing/claims/claim-old",
    );
    expect(screen.queryByText(/submission outcome still in doubt/i)).toBeNull();
  });

  it("surfaces owner-projected in-doubt submissions without implying failure or offering a retry", async () => {
    const get = vi.fn(async (path: string) => {
      if (path === "/api/v1/provider-entities") return ok({ items: [] });
      if (path === "/api/v1/locations") return ok({ items: [] });
      if (path === "/api/v1/billing/claims")
        return ok({
          items: [
            {
              claimId: "m23-uncertain",
              claimControlNumber: "MED-UNCERTAIN",
              state: "submitted",
              providerEntityId: "provider-a",
            },
          ],
          nextCursor: null,
        });
      if (path === "/api/v1/billing/commercial/claims")
        return ok({
          items: [
            {
              id: "m41-uncertain",
              claimControlNumber: "COM-UNCERTAIN",
              state: "submitted",
              planName: "Commercial Plan",
            },
          ],
          nextCursor: null,
        });
      if (path === "/api/v1/billing/claims/in-doubt-submissions")
        return ok({
          items: [
            {
              submissionId: "attempt-23",
              claimId: "m23-uncertain",
              claimControlNumber: "MED-UNCERTAIN",
              attemptIndex: 2,
              reasonCode: "TRANSPORT_TIMEOUT",
              occurredAt: "2026-11-01T12:00:00Z",
            },
          ],
          nextCursor: null,
        });
      if (path === "/api/v1/billing/commercial/submissions/in-doubt")
        return ok({
          items: [
            {
              submissionId: "attempt-41",
              claimId: "m41-uncertain",
              claimControlNumber: "COM-UNCERTAIN",
              attemptCount: 2,
              planName: "Commercial Plan",
              reasonCode: "TRANSPORT_TIMEOUT",
              occurredAt: "2026-11-02T12:00:00Z",
            },
          ],
          nextCursor: null,
        });
      return ok({ items: [], nextCursor: null });
    });
    mount(get);
    expect((await screen.findAllByText("MED-UNCERTAIN")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("COM-UNCERTAIN").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Submission outcome in doubt").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/may have reached the payer/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /retry|resubmit/i })).toBeNull();
  });
});
