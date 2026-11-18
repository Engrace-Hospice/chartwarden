// @vitest-environment jsdom
// apps/web/src/modules/15-discipline-care-plans — recording or correcting a compliance gate is a multi-field form, so it
// opens as a drawer in the detail rail beside the list (the redesign's pattern), not as a dialog over the page. Revoking
// stays a dialog: it is a confirmation that must be answered before the page is used again. One form at a time: opening one
// replaces the other. A write in flight keeps the drawer open and the page inert; a write that rejects ends in the drawer.
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

type Write = () => Promise<unknown>;

function renderScreen(writes: { POST?: Write; PATCH?: Write } = {}): void {
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/volunteer-compliance-gates"
        ? ok({ data: [gate], next_cursor: null, has_more: false })
        : ok({}),
    ),
    POST: vi.fn(writes.POST ?? (async () => ok({}))),
    PATCH: vi.fn(writes.PATCH ?? (async () => ok({}))),
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

const RECORD = "Record compliance gate";
const CORRECT = "Correct Background check";

describe("volunteer compliance — one form at a time", () => {
  it("Correct while Record gate is open replaces it, and nothing reappears after Cancel", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Record gate" }));
    await screen.findByRole("complementary", { name: RECORD });

    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const correction = await screen.findByRole("complementary", { name: CORRECT });
    expect(screen.queryByRole("complementary", { name: RECORD })).toBeNull();

    fireEvent.click(within(correction).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull());
    expect(screen.queryByRole("complementary", { name: RECORD })).toBeNull();
  });

  it("Record gate while a correction is open replaces it, and nothing reappears after Cancel", async () => {
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const correction = await screen.findByRole("complementary", { name: CORRECT });
    fireEvent.change(within(correction).getByLabelText("Notes"), { target: { value: "typed" } });

    fireEvent.click(screen.getByRole("button", { name: "Record gate" }));
    const record = await screen.findByRole("complementary", { name: RECORD });
    expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull();

    fireEvent.click(within(record).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: RECORD })).toBeNull());
    expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull();
  });
});

describe("volunteer compliance — a write in flight", () => {
  it("keeps the drawer open and the page inert until the save lands, then closes it", async () => {
    let finish: () => void = () => undefined;
    const patch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(ok({}));
        }),
    );
    renderScreen({ PATCH: patch });
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const drawer = await screen.findByRole("complementary", { name: CORRECT });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save gate" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));

    for (const name of ["Record gate", "Correct", "Revoke"]) {
      expect(screen.getByRole("button", { name }).closest("[inert]")).not.toBeNull();
    }
    expect(
      (within(drawer).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    fireEvent.keyDown(drawer, { key: "Escape" });
    expect(screen.getByRole("complementary", { name: CORRECT })).toBeTruthy();

    finish();
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull());
    expect(document.querySelector("[inert]")).toBeNull();
  });

  it("shows a refusal in the drawer, not the page, and leaves the form dismissable", async () => {
    renderScreen({
      PATCH: async () => ({
        data: undefined,
        error: { error: { code: "CONFLICT", message: "The gate moved." } },
        response: new Response(null, { status: 409 }),
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const drawer = await screen.findByRole("complementary", { name: CORRECT });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save gate" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("The gate moved.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull());
  });

  it("a save that rejects on a network failure ends in the drawer, which can then be dismissed", async () => {
    renderScreen({
      PATCH: async () => {
        throw new TypeError("network down");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Correct" }));
    const drawer = await screen.findByRole("complementary", { name: CORRECT });
    fireEvent.click(within(drawer).getByRole("button", { name: "Save gate" }));
    expect((await within(drawer).findByRole("alert")).textContent).toContain("connection dropped");
    expect(
      (within(drawer).getByRole("button", { name: "Save gate" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(document.querySelector("[inert]")).toBeNull();
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: CORRECT })).toBeNull());
  });

  it("a revoke that rejects on a network failure says so and can be retried", async () => {
    renderScreen({
      POST: async () => {
        throw new TypeError("network down");
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "lapsed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke gate" }));
    expect(await within(dialog).findByText(/connection dropped/)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Revoke gate" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
