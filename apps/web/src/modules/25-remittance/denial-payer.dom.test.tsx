import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/web/src/modules/25-remittance - milestone 11a-1: the denial panel shows the payer, and a Medicaid denial gets
// no Medicare-tier "Open appeal" (a disabled control with the reason visible instead). medicare / commercial /
// unknown denials keep the action.
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DenialDetailPanel } from "./denial-detail-panel";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
let payerKind = "medicaid";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === "object" && "url" in input ? (input as Request).url : String(input);
  const path = new URL(url, "http://localhost").pathname;
  if (path === `/api/v1/denials/${DENIAL}`) {
    return json({
      id: DENIAL,
      payerKind,
      providerEntityId: "11111111-1111-4111-8111-111111111111",
      claimId: null,
      carcCode: "50",
      rarcCode: null,
      category: "denial",
      source: "remittance_adjustment",
      state: "escalated",
      assigneeMembershipId: null,
      openedAt: "2026-09-01T00:00:00.000Z",
      agingBucketDays: 3,
      agingBucketLabel: "0-7",
      dollarValue: "300.00",
      taxonomyStatus: "mapped",
      version: 7,
    });
  }
  if (path.endsWith("/route")) {
    return json({
      route: "undetermined",
      unverified: false,
      rule: null,
      macReasonCode: null,
      macName: null,
    });
  }
  return json({ items: [] });
}

function mount(): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider
        session={{
          roles: ["billing_specialist"],
          permissions: [],
          isAdmin: false,
          userId: "u",
          organizationId: "o",
          membershipId: "ffffffff-6666-4666-8666-ffffffffffff",
        }}
      >
        <ToastProvider>
          <MemoryRouter>
            <DenialDetailPanel
              denialId={DENIAL}
              onClose={() => undefined}
              onChanged={() => undefined}
            />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

afterEach(() => cleanup());

describe("denial panel payer", () => {
  it("shows the Medicaid badge, disables the appeal action and states the reason", async () => {
    payerKind = "medicaid";
    mount();
    expect(await screen.findByText("Medicaid")).toBeTruthy();
    const open = (await screen.findByRole("button", { name: "Open appeal" })) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(
      screen.getByText(
        /Medicaid denials follow the state's path; the Medicaid appeal path is not available yet/,
      ),
    ).toBeTruthy();
  });

  it.each([
    ["medicare", "Medicare"],
    ["commercial", "Commercial"],
  ])("keeps the appeal action for a %s denial", async (kind, label) => {
    payerKind = kind;
    mount();
    expect(await screen.findByText(label)).toBeTruthy();
    const open = (await screen.findByRole("button", { name: "Open appeal" })) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
    expect(screen.queryByText(/Medicaid appeal path is not available/)).toBeNull();
  });

  it("flags an unknown payer and keeps the action", async () => {
    payerKind = "unknown";
    mount();
    expect((await screen.findAllByText(/Payer not known/)).length).toBeGreaterThan(0);
    const open = (await screen.findByRole("button", { name: "Open appeal" })) as HTMLButtonElement;
    expect(open.disabled).toBe(false);
  });
});
