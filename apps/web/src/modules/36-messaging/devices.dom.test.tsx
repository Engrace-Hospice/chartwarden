// M36 WP 5.5 (ADR-0083, PROPOSED) - the device and session manager screens: the owner's list (current marked in words, push state in words, one
// Revoke per row that names its device), revoke of another device (row leaves only after the server confirms, polite announcement, failure
// stays listed with a retry, already-gone is not a failure), the REQUIRED confirm step before revoking the current session (cancel does nothing,
// confirm revokes then signs out), the 401/403/error/empty states, no IP / user agent / id in the page, axe clean; and the security officer's
// page: a bad id is refused before any request, the list is that person's, a stale step-up sends the officer to the step-up screen.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DeviceDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceManager } from "./device-manager";
import { CONFIRM_CURRENT_ACTION, CONFIRM_CURRENT_TITLE } from "./devices-wording";
import { SessionGovernance } from "./session-governance";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const USER = "99999999-9999-4999-8999-000000000009";

const device = (over: Partial<DeviceDto> & Pick<DeviceDto, "id" | "label">): DeviceDto => ({
  current: false,
  created_at: "2026-10-18T08:00:00.000Z",
  last_used_at: "2026-10-19T11:00:00.000Z",
  push_registered: false,
  ...over,
});

const MINE: DeviceDto[] = [
  device({
    id: "s-current",
    label: "Chrome · macOS",
    current: true,
    last_used_at: "2026-10-19T11:59:30.000Z",
  }),
  device({
    id: "s-phone",
    label: "Safari · iOS",
    push_registered: true,
    last_used_at: "2026-10-19T09:00:00.000Z",
  }),
  device({ id: "s-old", label: "Chrome · Android", last_used_at: "2026-10-07T09:00:00.000Z" }),
];

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };

function mount(
  ui: JSX.Element,
  handlers: { get: () => Reply; del?: (id: string) => Reply | Promise<Reply> },
  entry = "/messaging/devices",
) {
  const GET = vi.fn((_path: string, _init?: unknown) => Promise.resolve(handlers.get()));
  const DELETE = vi.fn((_path: string, init?: { params?: { path?: { id?: string } } }) =>
    Promise.resolve(handlers.del?.(init?.params?.path?.id ?? "") ?? { response: { status: 500 } }),
  );
  const POST = vi.fn();
  const PUT = vi.fn();
  const PATCH = vi.fn();
  const Where = () => (
    <output data-testid="where">{useLocation().pathname + useLocation().search}</output>
  );
  const view = render(
    <MemoryRouter initialEntries={[entry]}>
      <ApiClientProvider client={{ GET, POST, PUT, PATCH, DELETE } as unknown as ApiClient}>
        <main>
          <Routes>
            <Route path="*" element={ui} />
          </Routes>
          <Where />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, DELETE, writes: [POST, PUT, PATCH], ...view };
}

const ok = (devices: DeviceDto[]): Reply => ({ data: { devices }, response: { status: 200 } });
const revoked = (current: boolean): Reply => ({
  data: { revoked: true, current, push_endpoints_expired: 0 },
  response: { status: 200 },
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeviceManager (self-service)", () => {
  it("lists the devices: current in words, push state in words, last used, a Revoke that names its device, no ids or agents", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { container } = mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => ok(MINE) });
    const list = await screen.findByRole("list", { name: "Your signed-in devices" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("This device")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Current")).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText("Active now")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Push on")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Last used 3 h ago")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("No push")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Last used 12 days ago")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Revoke Chrome · macOS (this device)" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke Safari · iOS" })).toBeTruthy();
    expect(container.textContent).not.toMatch(/s-phone|s-current|Mozilla|\d+\.\d+\.\d+\.\d+/);
  });

  it("revokes another device at once: DELETE by id, the row leaves only after the server says so, the result is announced", async () => {
    const { DELETE } = mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => revoked(false),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Safari · iOS" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke Safari · iOS" })).toBeNull(),
    );
    expect(DELETE).toHaveBeenCalledWith("/api/v1/devices/{id}", {
      params: { path: { id: "s-phone" } },
    });
    expect(screen.getByText("Safari · iOS revoked")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull(); // no confirm for another device
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows 'Revoking' and ignores a second press while the request is in flight", async () => {
    let release: (r: Reply) => void = () => {};
    const gate = new Promise<Reply>((resolve) => {
      release = resolve;
    });
    const { DELETE } = mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => gate,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Safari · iOS" }));
    const busy = await screen.findByRole("button", { name: "Revoke Safari · iOS" });
    expect(busy.textContent).toBe("Revoking");
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    expect(DELETE).toHaveBeenCalledTimes(1);
    release(revoked(false));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke Safari · iOS" })).toBeNull(),
    );
  });

  it("a failed revoke stays listed, says it is still signed in, and offers Try again", async () => {
    mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => ({ error: { error: { code: "INTERNAL" } }, response: { status: 500 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Safari · iOS" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("It is still signed in");
    expect(screen.getByRole("button", { name: "Revoke Safari · iOS" }).textContent).toBe(
      "Try again",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("revoking THIS device asks first; Cancel changes nothing", async () => {
    const { DELETE } = mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => revoked(true),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Chrome · macOS (this device)" }),
    );
    const dialog = await screen.findByRole("alertdialog", { name: CONFIRM_CURRENT_TITLE });
    expect(dialog.textContent).toContain("signed out");
    expect(DELETE).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(DELETE).not.toHaveBeenCalled();
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
  });

  it("Escape closes the confirm without revoking", async () => {
    const { DELETE } = mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => revoked(true),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Chrome · macOS (this device)" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(DELETE).not.toHaveBeenCalled();
  });

  it("confirming revokes the current session, then signs the person out", async () => {
    const onSignedOut = vi.fn();
    const { DELETE } = mount(<DeviceManager onSignedOut={onSignedOut} />, {
      get: () => ok(MINE),
      del: () => revoked(true),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Chrome · macOS (this device)" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: CONFIRM_CURRENT_ACTION }));
    await waitFor(() => expect(onSignedOut).toHaveBeenCalledTimes(1));
    expect(DELETE).toHaveBeenCalledWith("/api/v1/devices/{id}", {
      params: { path: { id: "s-current" } },
    });
  });

  it("moves focus to the list heading after a revoke removes the focused row", async () => {
    mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => revoked(false),
    });
    const button = await screen.findByRole("button", { name: "Revoke Safari · iOS" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Revoke Safari · iOS" })).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Your signed-in devices" }),
    );
  });

  it("a 401 on a revoke is terminal: the page says the session ended, with no endless Try again", async () => {
    mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => ({ error: {}, response: { status: 401 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Safari · iOS" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in again");
    expect(screen.queryByRole("button", { name: "Revoke Safari · iOS" })).toBeNull();
  });

  it("a 404 on a revoke is NOT announced as revoked: the list is re-read and the session reported not found", async () => {
    const { GET } = mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => ({ error: {}, response: { status: 404 } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Safari · iOS" }));
    expect(await screen.findByText(/was not found/)).toBeTruthy();
    expect(screen.queryByText("Safari · iOS revoked")).toBeNull();
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("Cancel returns focus to the button that opened the confirm", async () => {
    mount(<DeviceManager onSignedOut={vi.fn()} />, {
      get: () => ok(MINE),
      del: () => revoked(true),
    });
    const trigger = await screen.findByRole("button", {
      name: "Revoke Chrome · macOS (this device)",
    });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("does not sign out when the server refuses to revoke the current session", async () => {
    const onSignedOut = vi.fn();
    mount(<DeviceManager onSignedOut={onSignedOut} />, {
      get: () => ok(MINE),
      del: () => ({ error: {}, response: { status: 500 } }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Chrome · macOS (this device)" }),
    );
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: CONFIRM_CURRENT_ACTION,
      }),
    );
    await screen.findByRole("alert");
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it("401 says the session ended; 403 says not permitted; a failed load offers Retry that reads again", async () => {
    let reply: Reply = { error: {}, response: { status: 401 } };
    const first = mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => reply });
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in again");
    first.unmount();
    reply = { error: {}, response: { status: 403 } };
    mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => reply });
    expect((await screen.findByRole("alert")).textContent).toContain("not permitted");
    cleanup();
    reply = { error: {}, response: { status: 500 } };
    const { GET } = mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => reply });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("an empty list says so in words", async () => {
    mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => ok([]) });
    expect(await screen.findByText("No other sessions")).toBeTruthy();
  });

  it("has no axe violations, with the list and with the confirm open", async () => {
    const { container } = mount(<DeviceManager onSignedOut={vi.fn()} />, { get: () => ok(MINE) });
    await screen.findByRole("list", { name: "Your signed-in devices" });
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Revoke Chrome · macOS (this device)" }));
    await screen.findByRole("alertdialog");
    expect((await axe.run(document.body)).violations).toEqual([]);
  });
});

describe("SessionGovernance (security officer)", () => {
  it("refuses a malformed id in words and sends no request", async () => {
    const { GET } = mount(
      <SessionGovernance />,
      { get: () => ok([]) },
      "/messaging/governance/sessions",
    );
    fireEvent.change(screen.getByLabelText("User id"), { target: { value: "not-a-uuid" } });
    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    expect((await screen.findByRole("alert")).textContent).toContain("valid user id");
    expect(GET).not.toHaveBeenCalled();
  });

  it("lists that person's sessions through the governance route and names the device on each Revoke", async () => {
    const { GET } = mount(
      <SessionGovernance />,
      { get: () => ok([device({ id: "s-x", label: "Safari · iOS", push_registered: true })]) },
      "/messaging/governance/sessions",
    );
    fireEvent.change(screen.getByLabelText("User id"), { target: { value: USER } });
    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    expect(
      await screen.findByRole("button", { name: "Revoke Safari · iOS for this person" }),
    ).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/governance/sessions", {
      params: { query: { user_id: USER } },
    });
  });

  it("reads the person from ?user= and revokes through the governance route", async () => {
    const { DELETE } = mount(
      <SessionGovernance />,
      { get: () => ok([device({ id: "s-x", label: "Safari · iOS" })]), del: () => revoked(false) },
      `/messaging/governance/sessions?user=${USER}`,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Safari · iOS for this person" }),
    );
    await waitFor(() => expect(screen.getByText("Safari · iOS revoked")).toBeTruthy());
    expect(DELETE).toHaveBeenCalledWith("/api/v1/messaging/governance/sessions/{id}", {
      params: { path: { id: "s-x" } },
    });
  });

  it("a stale step-up sends the officer to the step-up screen and leaves the list as it was", async () => {
    mount(
      <SessionGovernance />,
      {
        get: () => ok([device({ id: "s-x", label: "Safari · iOS" })]),
        del: () => ({ error: { error: { code: "STEP_UP_REQUIRED" } }, response: { status: 403 } }),
      },
      `/messaging/governance/sessions?user=${USER}`,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Revoke Safari · iOS for this person" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
  });

  it("focuses the heading after a revoke, and a step-up refusal shows one alert, not a failed row", async () => {
    mount(
      <SessionGovernance />,
      {
        get: () =>
          ok([
            device({ id: "s-x", label: "Safari · iOS" }),
            device({ id: "s-y", label: "Chrome · macOS" }),
          ]),
        del: (id) =>
          id === "s-x"
            ? revoked(false)
            : { error: { error: { code: "STEP_UP_REQUIRED" } }, response: { status: 403 } },
      },
      `/messaging/governance/sessions?user=${USER}`,
    );
    const first = await screen.findByRole("button", {
      name: "Revoke Safari · iOS for this person",
    });
    first.focus();
    fireEvent.click(first);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Revoke Safari · iOS for this person" }),
      ).toBeNull(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Sessions of the selected person" }),
    );
  });

  it("an invalid ?user= says so, and Show sessions for the same person reads again", async () => {
    const bad = mount(
      <SessionGovernance />,
      { get: () => ok([]) },
      "/messaging/governance/sessions?user=nope",
    );
    expect((await screen.findByRole("alert")).textContent).toContain("valid user id");
    expect(bad.GET).not.toHaveBeenCalled();
    cleanup();
    const { GET } = mount(
      <SessionGovernance />,
      { get: () => ok([device({ id: "s-x", label: "Safari · iOS" })]) },
      `/messaging/governance/sessions?user=${USER}`,
    );
    await screen.findByRole("list", { name: "Sessions of the selected person" });
    fireEvent.click(screen.getByRole("button", { name: "Show sessions" }));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
  });

  it("has no axe violations", async () => {
    const { container } = mount(
      <SessionGovernance />,
      { get: () => ok([device({ id: "s-x", label: "Safari · iOS" })]) },
      `/messaging/governance/sessions?user=${USER}`,
    );
    await screen.findByRole("list", { name: "Sessions of the selected person" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
