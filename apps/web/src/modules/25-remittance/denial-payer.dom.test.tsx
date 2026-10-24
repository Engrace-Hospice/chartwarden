// apps/web/src/modules/25-remittance - milestone 11a-1: the denial panel shows the payer, and a Medicaid denial gets
// no Medicare-tier "Open appeal" (a focusable aria-disabled control with the reason visible instead). medicare /
// commercial / unknown denials keep the action.
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DenialDetailPanel } from "./denial-detail-panel";

const DENIAL = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const REASON =
  /Medicaid denials follow the state's path; the Medicaid appeal path is not available yet/;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const stubFetchFor =
  (payerKind: string, state: string) =>
  async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      typeof input === "object" && "url" in input ? (input as Request).url : String(input);
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
        state,
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
  };

function mount(payerKind: string, state = "escalated"): void {
  render(
    <ApiClientProvider
      client={createApiClient({
        baseUrl: "http://localhost",
        fetch: stubFetchFor(payerKind, state),
      })}
    >
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

const openAppeal = () => screen.findByRole("button", { name: "Open appeal" });

afterEach(() => cleanup());

describe("denial panel payer", () => {
  it("shows the Medicaid badge; the appeal control stays focusable, is aria-disabled, inert, and linked to the visible reason", async () => {
    mount("medicaid");
    expect(await screen.findByText("Medicaid")).toBeTruthy();
    const open = await openAppeal();
    expect(open.getAttribute("aria-disabled")).toBe("true");
    expect((open as HTMLButtonElement).disabled).toBe(false);
    const reasonId = open.getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId as string)?.textContent).toMatch(REASON);
    open.focus();
    expect(document.activeElement).toBe(open);
    fireEvent.click(open);
    expect(screen.queryByText("Appeal tier")).toBeNull();
  });

  it.each([
    ["medicare", "Medicare"],
    ["commercial", "Commercial"],
  ])("keeps the appeal action for a %s denial", async (kind, label) => {
    mount(kind);
    expect(await screen.findByText(label)).toBeTruthy();
    const open = await openAppeal();
    expect(open.getAttribute("aria-disabled")).toBeNull();
    await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText(REASON)).toBeNull();
  });

  it.each(["unknown", "tricare"])(
    "treats a %s payer as not known, keeps the action and says to check the payer",
    async (kind) => {
      mount(kind);
      expect(await screen.findByText("Payer not known")).toBeTruthy();
      expect(
        await screen.findByText(/Check the payer before you open a Medicare appeal/),
      ).toBeTruthy();
      const open = await openAppeal();
      await waitFor(() => expect((open as HTMLButtonElement).disabled).toBe(false));
    },
  );

  it("shows neither the Medicaid reason nor the unknown-payer hint where no appeal is offered", async () => {
    mount("medicaid", "closed");
    expect(await screen.findByText("Medicaid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open appeal" })).toBeNull();
    expect(screen.queryByText(REASON)).toBeNull();
    cleanup();
    mount("unknown", "closed");
    expect(await screen.findByText("Payer not known")).toBeTruthy();
    expect(screen.queryByText(/Check the payer before/)).toBeNull();
  });
});
