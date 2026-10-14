// M36 WP 2.7b - the tenant global search settings screen (jsdom): checklist, gated enable, confirmation, server refusals.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { GlobalSearchSettings } from "./global-search-settings";

const READY = {
  enabled: false,
  changedAt: null,
  purgeRequestedAt: null,
  purgeCompletedAt: null,
  checklist: {
    platformEnabled: true,
    legacyBodiesMigrated: true,
    escrowAttested: true,
    leakageAttested: true,
    rateLimitActive: true,
  },
  rebuild: null,
};
const UNMET = { ...READY, checklist: { ...READY.checklist, escrowAttested: false } };
const ON = { ...READY, enabled: true, changedAt: "2026-10-13T10:00:00.000Z" };
const failure = (status: number, error: unknown) => ({
  data: undefined,
  error,
  response: { status },
});
const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });

function Where(): null {
  document.title = useLocation().pathname;
  return null;
}

function mount(get: unknown, put?: unknown) {
  const api = {
    GET: vi.fn().mockResolvedValue(get),
    PUT: vi.fn().mockResolvedValue(put),
  } as unknown as ApiClient;
  render(
    <ApiClientProvider client={api}>
      <MemoryRouter initialEntries={["/messaging/search-settings"]}>
        <Where />
        <Routes>
          <Route path="/messaging/search-settings" element={<GlobalSearchSettings />} />
          <Route path="*" element={null} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
  return api;
}
const putCalls = (api: ApiClient): Array<[string, { body: unknown }]> =>
  (api.PUT as unknown as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { body: unknown }]>;
const firstPut = (api: ApiClient): [string, { body: unknown }] => {
  const call = putCalls(api)[0];
  if (!call) throw new Error("no PUT was sent");
  return call;
};

async function confirm(label: string) {
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: label }));
}

describe("Global search settings", () => {
  it("lists every prerequisite with met or not met in words", async () => {
    mount(ok(UNMET));
    const list = await screen.findByRole("list", { name: "Go-live prerequisites" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    expect(within(list).getAllByText("Met")).toHaveLength(4);
    expect(within(list).getAllByText("Not met")).toHaveLength(1);
  });

  it("disables switching on while a prerequisite is unmet and says why", async () => {
    mount(ok(UNMET));
    const button = await screen.findByRole("button", { name: "Switch on global search" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("disables switching on while the last purge has not finished", async () => {
    mount(ok({ ...READY, purgeRequestedAt: "2026-10-13T09:00:00.000Z" }));
    const button = await screen.findByRole("button", { name: "Switch on global search" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/still being removed/i)).toBeTruthy();
  });

  it("asks for confirmation, explains the blind-token index, and sends nothing on cancel", async () => {
    const api = mount(ok(READY));
    fireEvent.click(await screen.findByRole("button", { name: "Switch on global search" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/blind-token index/i);
    expect(putCalls(api)).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(putCalls(api)).toHaveLength(0);
  });

  it("switches on after confirmation and shows the state the server returned", async () => {
    const api = mount(ok(READY), ok(ON));
    fireEvent.click(await screen.findByRole("button", { name: "Switch on global search" }));
    await confirm("Switch on");
    expect(await screen.findByRole("button", { name: "Switch off global search" })).toBeTruthy();
    expect(putCalls(api)).toHaveLength(1);
    expect(firstPut(api)[0]).toBe("/api/v1/messaging/global-search/settings");
    expect(firstPut(api)[1].body).toEqual({ enabled: true });
  });

  it("shows the server's refusal and does not claim success", async () => {
    mount(
      ok(READY),
      failure(409, {
        error: {
          code: "GLOBAL_SEARCH_PREREQUISITES_UNMET",
          message: "Global search cannot be switched on until the go-live checklist is satisfied.",
          details: [
            {
              field: "enabled",
              code: "ESCROW_NOT_ATTESTED",
              message: "The key escrow and restore drill are not on record.",
            },
          ],
        },
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Switch on global search" }));
    await confirm("Switch on");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Global search cannot be switched on until the go-live checklist is satisfied. The key escrow and restore drill are not on record.",
    );
    expect(screen.queryByRole("button", { name: "Switch off global search" })).toBeNull();
  });

  it("keeps the server's refusal when the quiet re-read of the settings fails", async () => {
    const api = mount(
      ok(READY),
      failure(409, { error: { code: "GLOBAL_SEARCH_PREREQUISITES_UNMET", message: "Not yet." } }),
    );
    (api.GET as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(ok(READY))
      .mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(await screen.findByRole("button", { name: "Switch on global search" }));
    await confirm("Switch on");
    expect((await screen.findByRole("alert")).textContent).toBe("Not yet.");
  });

  it("words a stale index build separately from a first build", async () => {
    mount(ok({ ...ON, rebuild: { status: "stale", effectiveReady: false } }));
    expect(await screen.findByText(/catching up/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh status" })).toBeTruthy();
  });

  it("sends the user to step-up when the session is not fresh", async () => {
    mount(ok(READY), failure(403, { error: { code: "STEP_UP_REQUIRED", message: "Re-verify" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Switch on global search" }));
    await confirm("Switch on");
    await waitFor(() => expect(document.title).toBe("/step-up"));
  });

  it("shows a permission message on 403", async () => {
    mount(failure(403, { error: { code: "FORBIDDEN", message: "no" } }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/permission/i);
  });

  it("shows an unavailable state with retry on 503", async () => {
    const api = mount(failure(503, { error: { code: "UNAVAILABLE", message: "down" } }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/i);
    (api.GET as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(ok(READY));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Switch on global search" })).toBeTruthy();
  });

  it("switches off after confirmation", async () => {
    const api = mount(ok(ON), ok(READY));
    fireEvent.click(await screen.findByRole("button", { name: "Switch off global search" }));
    await confirm("Switch off");
    expect(await screen.findByRole("button", { name: "Switch on global search" })).toBeTruthy();
    expect(firstPut(api)[1].body).toEqual({ enabled: false });
  });

  it("reports the index build while it is not ready", async () => {
    mount(
      ok({
        ...ON,
        rebuild: {
          keyVersion: "v1",
          status: "building",
          checkpointCreatedAt: null,
          reconciledAt: null,
          changedAt: ON.changedAt,
          effectiveReady: false,
        },
      }),
    );
    expect(await screen.findByText(/still being built/i)).toBeTruthy();
  });
});
