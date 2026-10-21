// M36 WP 4.6 - my notification preferences (`/messaging/preferences`): flag off is absent, locked quiet-hours rows say why, a save is one PUT,
// a server refusal keeps the draft, unsaved changes are guarded, axe clean.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationPreferences } from "./notification-preferences";
import { LOCKED_QUIET_ROWS, PREFS_OFF } from "./notification-preferences-wording";

const FLAG_PATH = "/api/v1/messaging/reminders";
const PREFS_PATH = "/api/v1/notifications/preferences";

const prefs = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  routingMap: { clinical_routine: { info: ["in_app"], warn: ["in_app", "push"] } },
  quietHours: {
    tz: "America/Chicago",
    ranges: [{ daysOfWeek: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "06:00" }],
    severityOverride: "critical",
  },
  vacationForwardToUserId: null,
  vacationUntil: null,
  updatedAt: "2026-10-18T10:00:00.000Z",
  ...over,
});

function mount(opts: { flag?: number; get?: unknown; put?: unknown } = {}) {
  const GET = vi.fn((path: string) =>
    Promise.resolve(
      path === FLAG_PATH
        ? opts.flag === 404
          ? { error: {}, response: { status: 404 } }
          : { data: { reminders: [] }, response: { status: 200 } }
        : (opts.get ?? { data: prefs(), response: { status: 200 } }),
    ),
  );
  const PUT = vi.fn(() =>
    // The real PUT answers { id, updatedAt } only (messaging-route-service-db.ts), never the preferences.
    Promise.resolve(
      opts.put ?? {
        data: { id: "pref-1", updatedAt: "2026-10-19T00:00:00.000Z" },
        response: { status: 200 },
      },
    ),
  );
  const view = render(
    <ApiClientProvider client={{ GET, PUT } as unknown as ApiClient}>
      <main>
        <NotificationPreferences />
      </main>
    </ApiClientProvider>,
  );
  return { GET, PUT, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("NotificationPreferences", () => {
  it("is absent (and reads no preferences) when the tenant flag is off", async () => {
    const { GET } = mount({ flag: 404 });
    expect(await screen.findByText(PREFS_OFF)).toBeTruthy();
    expect(GET.mock.calls.map((c) => c[0])).toEqual([FLAG_PATH]);
  });

  it("shows denied for a 403 on the preferences read", async () => {
    mount({ get: { error: {}, response: { status: 403 } } });
    expect((await screen.findByRole("alert")).textContent).toContain("do not have access");
  });

  it("shows every locked quiet-hours row as locked with its reason, and they have no off switch", async () => {
    mount();
    const locked = await screen.findAllByRole("listitem", { name: /locked/i });
    expect(locked).toHaveLength(LOCKED_QUIET_ROWS.length);
    for (const row of locked) {
      expect(within(row).getByText(/Locked/)).toBeTruthy();
      expect(within(row).getByText(/cannot be turned off/i)).toBeTruthy();
      expect(within(row).queryByRole("switch")).toBeNull();
      expect(within(row).queryByRole("checkbox")).toBeNull();
    }
  });

  it("quiet hours is a switch with state text; turning it off sends no ranges, and the save is one PUT", async () => {
    const { PUT } = mount();
    const sw = await screen.findByRole("switch", { name: "Quiet hours" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("On")).toBeTruthy();
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(PUT).toHaveBeenCalledTimes(1));
    const call = PUT.mock.calls[0] as unknown as [string, { body: Record<string, unknown> }];
    expect(call[0]).toBe(PREFS_PATH);
    expect((call[1].body.quietHours as { ranges: unknown[] }).ranges).toEqual([]);
    expect(await screen.findByText("Preferences saved.")).toBeTruthy();
    // The form survives the save (a PUT answer without the preferences once crashed the page).
    expect(screen.getByRole("switch", { name: "Quiet hours" }).getAttribute("aria-checked")).toBe(
      "false",
    );
  });

  it("keeps the draft and names the server's refusal, linked to the Save button", async () => {
    const { PUT } = mount({
      put: {
        error: { error: { message: "Vacation forward target is not a colleague." } },
        response: { status: 409 },
      },
    });
    fireEvent.click(await screen.findByRole("switch", { name: "Quiet hours" }));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Vacation forward target is not a colleague.");
    expect(
      screen.getByRole("button", { name: "Save preferences" }).getAttribute("aria-describedby"),
    ).toBe(alert.id);
    expect(screen.getByRole("switch", { name: "Quiet hours" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(PUT).toHaveBeenCalledTimes(1);
  });

  it("guards unsaved changes with a beforeunload prompt, and only while dirty", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: "Quiet hours" });
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    fireEvent.click(sw);
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  it("has no axe violations", async () => {
    const { container } = mount();
    await screen.findByRole("switch", { name: "Quiet hours" });
    const results = await axe.run(container);
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
