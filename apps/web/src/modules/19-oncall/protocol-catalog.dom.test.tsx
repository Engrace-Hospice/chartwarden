// @vitest-environment jsdom
// "Author a protocol" is a multi-field form on a list screen, so it opens as a drawer in the detail rail beside the
// catalog (the redesign's pattern), not as a dialog over it. Cancel closes it and sends nothing.
import type { ApiClient } from "@chartwarden/ui";
import { ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TriageProtocolView } from "./oncall-api";
import { TriageProtocolCatalogScreen } from "./protocol-catalog";

afterEach(cleanup);

const protocol: TriageProtocolView = {
  id: "pr1",
  organizationId: null,
  key: "pain_crisis",
  chiefComplaintLabel: "Pain crisis",
  snomedCode: "22253000",
  disciplineRequired: "rn",
  isSystemLocked: true,
  requiresMandatoryEscalation: false,
  mandatoryEscalationTier: null,
  version: "1.0.0",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  effectiveTo: null,
  sortOrder: 1,
  questions: [],
};

const ok = (data: unknown) => ({
  data,
  error: undefined,
  response: new Response(null, { status: 200 }),
});

function mount(): { post: ReturnType<typeof vi.fn> } {
  const post = vi.fn(async () => ok({}));
  const client = {
    GET: vi.fn(async () => ok({ data: [protocol], next_cursor: null, has_more: false })),
    POST: post,
  } as unknown as ApiClient;
  render(
    <MemoryRouter>
      <ApiClientProvider client={client}>
        <TriageProtocolCatalogScreen />
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { post };
}

describe("triage protocol catalog — author a protocol", () => {
  it("opens the form as a drawer beside the catalog, not a dialog over it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Author a protocol" }));
    const drawer = await screen.findByRole("complementary", { name: "Author a tenant protocol" });
    expect(within(drawer).getByLabelText("Chief complaint label")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    // The catalog stays on the page while the form is open.
    expect(screen.getByText("Pain crisis")).toBeTruthy();
  });

  it("closes from Cancel without sending anything", async () => {
    const { post } = mount();
    fireEvent.click(await screen.findByRole("button", { name: "Author a protocol" }));
    const drawer = await screen.findByRole("complementary", { name: "Author a tenant protocol" });
    fireEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByRole("complementary", { name: "Author a tenant protocol" })).toBeNull(),
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps Create disabled until the key, label and SNOMED code are valid", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Author a protocol" }));
    const drawer = await screen.findByRole("complementary", { name: "Author a tenant protocol" });
    expect(
      (within(drawer).getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
