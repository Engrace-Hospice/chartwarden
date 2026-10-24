// M36 WP 6.10 (ADR-0101, PROPOSED) - the Alarm sources screen against a mocked network boundary: it is READ ONLY (no button creates, rotates or disables
// anything and no secret is ever shown), every view says it is a notice and not a nurse-call replacement, a silent drop is a visible number, and the
// loading, empty, denied, error and refresh-failed states are honest. axe is clean.
import type { AlarmSourceDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AlarmSources } from "./alarm-sources";

const ORG = "33333333-3333-4333-8333-333333333333";
type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number): Reply => ({ error: {}, response: { status } });

const source = (over: Partial<AlarmSourceDto> = {}): AlarmSourceDto => ({
  id: "22222222-2222-4222-8222-222222222222",
  name: "Ward 2 bed sensors",
  enabled: true,
  secretGeneration: 2,
  createdAt: "2026-10-20T10:00:00.000Z",
  rotatedAt: "2026-10-22T10:00:00.000Z",
  disabledAt: null,
  lastAcceptedAt: "2026-10-23T09:30:00.000Z",
  mappings: [
    { alarmKind: "bed_exit", alertType: "alarm_ingest.patient_sensor", severityCeiling: "warn" },
    { alarmKind: "call", alertType: "alarm_ingest.nurse_call", severityCeiling: "info" },
  ],
  last24h: { alerted: 12, noRecipients: 0, unmapped: 0, pending: 0 },
  ...over,
});

function mount(reply: () => Reply | Promise<Reply> = () => ok({ sources: [source()] })) {
  const GET = vi.fn((): Promise<Reply> => Promise.resolve(reply()));
  const POST = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={["/messaging/alarm-sources"]}>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <SessionProvider
          session={{
            userId: "u1",
            organizationId: ORG,
            permissions: ["messaging.alarm_ingest.manage"],
          }}
        >
          <main>
            <AlarmSources />
          </main>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("alarm sources screen", () => {
  it("lists each source with what its codes become, the ceiling, the last delivery and the 24 hour outcome counts", async () => {
    const { GET } = mount();
    expect(await screen.findByText("Ward 2 bed sensors")).toBeTruthy();
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/alarm-sources");
    const codes = screen.getByRole("list", { name: "Alarm codes of Ward 2 bed sensors" });
    const [bed, call] = within(codes).getAllByRole("listitem");
    expect(bed?.textContent).toBe("bed_exit becomes Bed or fall sensor · Up to warning");
    expect(call?.textContent).toBe("call becomes Nurse call · Information only");
    expect(screen.getByText(/12 alerted · 0 with nobody to alert · 0 unmapped code · 0 waiting/)).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText(/Secret version 2/)).toBeTruthy();
  });

  it("is read only: only Refresh is offered (nothing creates, rotates or disables), and no secret is shown", async () => {
    const { POST } = mount();
    await screen.findByText("Ward 2 bed sensors");
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual(["Refresh"]);
    expect(screen.getByText(/This list is read only/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/wxas_/);
    expect(POST).not.toHaveBeenCalled();
  });

  it("says on every view that it is a notice only and does not replace the nurse-call system, and never says anyone is paged", async () => {
    mount();
    await screen.findByText("Ward 2 bed sensors");
    expect(screen.getByText(/does not replace your nurse-call or monitoring system/)).toBeTruthy();
    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).not.toContain("emergency");
    expect(text).not.toMatch(/\bpag(e|ed|es|ing)\b/);
  });

  it("makes a silent drop visible: alarms with nobody to alert, an unmapped code or still waiting raise a plain warning", async () => {
    mount(() =>
      ok({ sources: [source({ last24h: { alerted: 3, noRecipients: 2, unmapped: 1, pending: 1 } })] }),
    );
    expect(await screen.findByText(/did not reach a person/)).toBeTruthy();
    expect(screen.getByText(/3 alerted · 2 with nobody to alert · 1 unmapped code · 1 waiting/)).toBeTruthy();
  });

  it("shows a disabled source as Disabled (a word) with its time, and an empty list honestly", async () => {
    const view = mount(() =>
      ok({ sources: [source({ enabled: false, disabledAt: "2026-10-23T11:00:00.000Z", lastAcceptedAt: null })] }),
    );
    expect(await screen.findByText("Disabled")).toBeTruthy();
    expect(screen.getByText(/Last delivered Never/)).toBeTruthy();
    view.unmount();
    mount(() => ok({ sources: [] }));
    expect(await screen.findByText("No alarm sources")).toBeTruthy();
  });

  it("keeps the list and raises an alert when a refresh fails, then clears it", async () => {
    let calls = 0;
    mount(() => {
      calls += 1;
      if (calls === 1) return ok({ sources: [source()] });
      return calls === 2 ? fail(500) : ok({ sources: [source()] });
    });
    expect(await screen.findByText("Ward 2 bed sensors")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "Refresh" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("could not be refreshed");
    expect(screen.getByText("Ward 2 bed sensors")).toBeTruthy();
    await userEvent.setup().click(within(alert).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says denied for a 403 and sign-in for a 401, and offers Retry on an error", async () => {
    mount(() => fail(403));
    expect(await screen.findByText(/You do not have access to alarm sources/)).toBeTruthy();
    cleanup();
    mount(() => fail(401));
    expect(await screen.findByText(/Sign in/i)).toBeTruthy();
    cleanup();
    let calls = 0;
    mount(() => (++calls === 1 ? fail(500) : ok({ sources: [source()] })));
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText("Ward 2 bed sensors")).toBeTruthy());
  });

  it("has no axe violations (colour contrast is not computed in jsdom)", async () => {
    const { container } = mount();
    await screen.findByText("Ward 2 bed sensors");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
