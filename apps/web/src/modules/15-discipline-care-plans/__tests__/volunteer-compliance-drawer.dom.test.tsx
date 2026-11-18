// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — recording or correcting a compliance gate is a multi-field form, so it
// opens as a drawer in the detail rail beside the list (the redesign's pattern), not as a dialog over the page. Revoking
// stays a dialog: it is a confirmation that must be answered before the page is used again.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import type { GateView } from "../discipline-api";
import { VolunteerComplianceGates } from "../volunteer-compliance";

afterEach(cleanup);

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["volunteer_compliance.read"],
};

const gate: GateView = {
  gateId: "gate-1",
  volunteerMembershipId: "m-chen",
  gateKind: "background_check",
  storedStatus: "satisfied",
  effectiveStatus: "satisfied",
  validFrom: "2026-01-22T00:00:00.000Z",
  validUntil: "2027-01-22T00:00:00.000Z",
  revokedAt: null,
  sourceDocumentId: null,
  version: 1,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function renderScreen(): void {
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/volunteer-compliance-gates"
        ? ok({ data: [gate], next_cursor: null, has_more: false })
        : ok({}),
    ),
    POST: vi.fn(async () => ok({})),
    PATCH: vi.fn(async () => ok({})),
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <VolunteerComplianceGates />
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("volunteer compliance — gate form drawer", () => {
  it("opens Record gate as a drawer beside the list, not a dialog", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Record gate" }));

    const drawer = await screen.findByRole("complementary", { name: "Record compliance gate" });
    expect(within(drawer).getByLabelText("Valid from")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The list stays on the page while the form is open.
    const results = screen.getByRole("region", { name: "Results" });
    expect(within(results).getByText("Background check")).toBeTruthy();
  });

  it("closes from Cancel", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Record gate" }));
    const drawer = await screen.findByRole("complementary", { name: "Record compliance gate" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Record compliance gate" })).toBeNull(),
    );
  });

  it("opens Correct for a row as a drawer named for that gate", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    expect(
      await screen.findByRole("complementary", { name: "Correct Background check" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps Revoke as a dialog", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
