// @vitest-environment jsdom
// Amending a check-in is a multi-field form on the clinician's own history, so it opens as a drawer in the detail rail
// beside the history (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; a closed
// grace window opens no form at all.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MyCheckInsScreen } from "./my-check-ins";
import type { SafetyCheckInView } from "./safety-api";

afterEach(cleanup);

const posted: SafetyCheckInView = {
  id: "11111111-1111-4111-8111-111111111111",
  scheduleId: null,
  visitId: null,
  postedByMembershipId: "m-lopez",
  postedAt: "2026-11-17T20:00:00.000Z",
  kind: "mid_visit",
  status: "ok",
  concernNote: null,
  coordinatesCaptured: false,
  isPartOfSosBracket: false,
  correctsCheckInId: null,
  supersededAt: null,
  supersededByCheckInId: null,
  amendableUntil: null,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(amendableUntil: string | null): { patch: ReturnType<typeof vi.fn> } {
  const patch = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/safety/check-ins/{checkInId}"
        ? ok({ ...posted, amendableUntil })
        : ok({ asOf: "2026-11-18T12:00:00.000Z", obligations: [], recentCheckIns: [posted] }),
    ),
    PATCH: patch,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <MyCheckInsScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { patch };
}

const OPEN_WINDOW = "2026-11-18T12:05:00.000Z";
const drawerNamed = (name: string) => screen.findByRole("complementary", { name });

describe("my check-ins — amend a check-in", () => {
  it("opens the form as a drawer beside the history, not a dialog over it", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    const drawer = await drawerNamed("Amend this check-in");
    expect(within(drawer).getByLabelText("Why the correction?")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The history stays on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("closes from Cancel without recording anything", async () => {
    const { patch } = mount(OPEN_WINDOW);
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    const drawer = await drawerNamed("Amend this check-in");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull(),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps Record correction disabled until the reason is long enough", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    const drawer = await drawerNamed("Amend this check-in");
    const record = within(drawer).getByRole("button", {
      name: "Record correction",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Why the correction?"), {
      target: { value: "Tapped the wrong button" },
    });
    expect(record.disabled).toBe(false);
  });

  it("asks for a note, with a live count, once the correction says concern", async () => {
    mount(OPEN_WINDOW);
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    const drawer = await drawerNamed("Amend this check-in");
    expect(within(drawer).queryByLabelText("Your note")).toBeNull();
    fireEvent.change(within(drawer).getByLabelText("What you meant to say"), {
      target: { value: "concerned_continue" },
    });
    expect(within(drawer).getByLabelText("Your note")).toBeTruthy();
    expect(drawer.textContent).toContain("20 more characters required");
  });

  it("opens no form when the grace window has closed", async () => {
    mount(null);
    fireEvent.click(await screen.findByRole("button", { name: "Amend" }));
    expect(await screen.findByText("Grace closed")).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Amend this check-in" })).toBeNull();
  });
});
