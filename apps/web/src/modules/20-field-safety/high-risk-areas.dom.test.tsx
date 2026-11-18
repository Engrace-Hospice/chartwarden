// @vitest-environment jsdom
// Drawing or editing a high-risk area is a multi-field form on a registry screen, so it opens as a drawer in the detail
// rail beside the registry (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HighRiskAreasScreen } from "./high-risk-areas";
import type { SafetyHighRiskAreaView } from "./safety-api";

afterEach(cleanup);

const area: SafetyHighRiskAreaView = {
  id: "11111111-1111-4111-8111-111111111111",
  riskCategory: "documented_prior_incident",
  advisoryMessage: "Two assaults reported on this block in the last year.",
  polygon: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
  policyForVisitsToArea: "advisory_only",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  createdByMembershipId: null,
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const patch = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok({ data: [area], next_cursor: null, has_more: false })),
    POST: post,
    PATCH: patch,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <HighRiskAreasScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post, patch };
}

const drawerNamed = (name: string) => screen.findByRole("complementary", { name });

describe("high-risk areas — draw and edit an area", () => {
  it("opens Draw area as a drawer beside the registry, not a dialog over it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Draw area" }));
    const drawer = await drawerNamed("Draw a high-risk area");
    expect(within(drawer).getByLabelText("Advisory message (<=200 characters)")).toBeTruthy();
    expect(within(drawer).queryByLabelText("Effective from")).not.toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The registry stays on the page while the form is open.
    expect(screen.getByRole("table")).toBeTruthy();
  });

  it("opens Edit with the area's own values, and no start date to change", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await drawerNamed("Edit this area");
    expect(
      (within(drawer).getByLabelText("Advisory message (<=200 characters)") as HTMLInputElement)
        .value,
    ).toBe(area.advisoryMessage);
    expect(within(drawer).queryByLabelText("Effective from")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes from Cancel without saving anything", async () => {
    const { post, patch } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Draw area" }));
    const drawer = await drawerNamed("Draw a high-risk area");
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Draw a high-risk area" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("keeps Create area disabled until an advisory and a ring are entered", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Draw area" }));
    const drawer = await drawerNamed("Draw a high-risk area");
    const create = within(drawer).getByRole("button", { name: "Create area" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Advisory message (<=200 characters)"), {
      target: { value: "Loose dogs near the east entrance." },
    });
    expect(create.disabled).toBe(true);
    fireEvent.change(within(drawer).getByLabelText("Polygon rings"), {
      target: { value: "0,0 1,0 1,1 0,0" },
    });
    expect(create.disabled).toBe(false);
  });

  it("files the new area and closes the drawer", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Draw area" }));
    const drawer = await drawerNamed("Draw a high-risk area");
    fireEvent.change(within(drawer).getByLabelText("Advisory message (<=200 characters)"), {
      target: { value: "Loose dogs near the east entrance." },
    });
    fireEvent.change(within(drawer).getByLabelText("Polygon rings"), {
      target: { value: "0,0 1,0 1,1 0,0" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Create area" }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Draw a high-risk area" })).toBeNull(),
    );
  });

  it("keeps the drawer open and says why when the rings are not a closed polygon", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Draw area" }));
    const drawer = await drawerNamed("Draw a high-risk area");
    fireEvent.change(within(drawer).getByLabelText("Advisory message (<=200 characters)"), {
      target: { value: "Loose dogs near the east entrance." },
    });
    fireEvent.change(within(drawer).getByLabelText("Polygon rings"), {
      target: { value: "0,0 1,0 1,1 2,2" },
    });
    fireEvent.click(within(drawer).getByRole("button", { name: "Create area" }));
    expect(await within(drawer).findByRole("alert")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole("complementary", { name: "Draw a high-risk area" })).toBeTruthy();
  });
});
