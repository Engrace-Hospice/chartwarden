// @vitest-environment jsdom
// "Add shift" is a multi-field form on a list screen, so it opens as a drawer in the detail rail beside the roster
// (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing; Create stays disabled until
// the form is complete.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OnCallShiftsScreen } from "./oncall-shifts";

afterEach(cleanup);

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async (path: string) =>
      path === "/api/v1/oncall/current"
        ? ok({ asOf: "2026-11-18T12:00:00.000Z", perProviderEntity: [] })
        : ok({ data: [], next_cursor: null, has_more: false }),
    ),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <OnCallShiftsScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

const addShift = async () => (await screen.findAllByRole("button", { name: "Add shift" }))[0];

describe("on-call roster — add a shift", () => {
  it("opens the form as a drawer beside the roster, not a dialog over it", async () => {
    mount();
    fireEvent.click((await addShift()) as HTMLElement);
    const drawer = await screen.findByRole("complementary", { name: "Add an on-call shift" });
    expect(within(drawer).getByLabelText("Starts at")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The roster stays on the page while the form is open.
    expect(screen.getByRole("heading", { name: "On-call roster" })).toBeTruthy();
  });

  it("closes from Cancel without sending anything", async () => {
    const { post } = mount();
    fireEvent.click((await addShift()) as HTMLElement);
    const drawer = await screen.findByRole("complementary", { name: "Add an on-call shift" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Add an on-call shift" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Create shift disabled until the form is complete", async () => {
    mount();
    fireEvent.click((await addShift()) as HTMLElement);
    const drawer = await screen.findByRole("complementary", { name: "Add an on-call shift" });
    expect(
      (within(drawer).getByRole("button", { name: "Create shift" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
