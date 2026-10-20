// M36 WP 5.6 (ADR-0086, PROPOSED) - the retention and legal-hold screen against a mocked network boundary: the per-class view (plan-only wording, never
// scanned, capped, certificate), the hold list, place (validation, step-up with stashed input), release (preview then a second confirmation that
// sends the count seen, a stale count re-shown, step-up), the 403 / error states, free text rendered as text, keyboard and axe.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MessageLegalHoldDto, RetentionClassDto, RetentionOverviewDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { stashStepUpDraft } from "../../shell/step-up-redirect";
import { RetentionGovernance } from "./retention-governance";

const CH = "11111111-1111-4111-8111-111111111111";
const HOLD = "22222222-2222-4222-8222-222222222222";

const cls = (
  c: RetentionClassDto["class"],
  over: Partial<RetentionClassDto> = {},
): RetentionClassDto => ({
  class: c,
  period_years: 7,
  source: "platform_default",
  eligible: 12,
  held: 3,
  capped: false,
  certificate_id: null,
  certificate_status: null,
  ...over,
});
const OVERVIEW: RetentionOverviewDto = {
  classes: [
    cls("care_related", { certificate_id: CH, certificate_status: "pending" }),
    cls("bereavement", { eligible: 0, held: 0 }),
    cls("operational", { period_years: 1, eligible: 5000, capped: true }),
  ],
  next_scan_at: "2026-11-01T03:00:00.000Z",
  last_scan_at: "2026-10-25T03:00:00.000Z",
  destruction_built: false,
};
const hold = (over: Partial<MessageLegalHoldDto> = {}): MessageLegalHoldDto => ({
  id: HOLD,
  name: "<b>Smith</b> litigation",
  status: "active",
  scope: { channel_ids: [CH], user_ids: [], patient_ids: [], org_wide: false },
  placed_by: "Pat Officer",
  placed_at: "2026-10-01T10:00:00.000Z",
  released_at: null,
  held_messages: 41,
  ...over,
});

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

interface Routes {
  retention?: () => Reply;
  holds?: () => Reply;
  preview?: () => Reply;
  release?: () => Reply;
  apply?: () => Reply;
}
function mount(routes: Routes, userId = "99999999-9999-4999-8999-999999999999") {
  const GET = vi.fn((path: string, _init?: unknown): Promise<Reply> => {
    if (path.endsWith("/retention")) return Promise.resolve(routes.retention?.() ?? ok(OVERVIEW));
    if (path.endsWith("/release-preview")) return Promise.resolve(routes.preview?.() ?? fail(500));
    return Promise.resolve(routes.holds?.() ?? ok({ holds: [hold()] }));
  });
  const POST = vi.fn(
    (path: string, _init?: unknown): Promise<Reply> =>
      Promise.resolve(
        (path.endsWith("/release") ? routes.release?.() : routes.apply?.()) ?? fail(500),
      ),
  );
  const writes = [vi.fn(), vi.fn(), vi.fn()];
  const Where = () => (
    <output data-testid="where">{useLocation().pathname + useLocation().search}</output>
  );
  const view = render(
    <MemoryRouter initialEntries={["/messaging/governance/retention"]}>
      <ApiClientProvider
        client={
          { GET, POST, PUT: writes[0], PATCH: writes[1], DELETE: writes[2] } as unknown as ApiClient
        }
      >
        <SessionProvider session={{ userId, organizationId: "org-1" }}>
          <main>
            <RetentionGovernance />
            <Where />
          </main>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, writes, ...view };
}

const openHolds = async () => {
  fireEvent.click(await screen.findByRole("tab", { name: "Legal holds" }));
};

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Retention tab", () => {
  it("shows each class: read-only period, source, eligible and held counts, capped notice, scan times, certificate, plan-only wording", async () => {
    const { GET } = mount({});
    const list = await screen.findByRole("list", { name: "Retention by message class" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const care = rows[0] as HTMLElement;
    expect(within(care).getByText("Care-related messages")).toBeTruthy();
    expect(within(care).getByText("12 messages eligible")).toBeTruthy();
    expect(within(care).getByText("3 messages held by a legal hold")).toBeTruthy();
    expect(care.textContent).toContain("Kept 7 years");
    expect(care.textContent).toContain("Platform default");
    expect(care.textContent).toContain("Approving it destroys nothing yet");
    expect(care.textContent).toContain(`Certificate ${CH}`);
    expect(within(rows[2] as HTMLElement).getByText(/Counts stop at the scan limit/)).toBeTruthy();
    expect(
      screen.getByText(/approving a destruction certificate destroys nothing yet/),
    ).toBeTruthy();
    expect(screen.getByText(/Last scan/)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull(); // periods are read-only
    expect(GET).toHaveBeenCalledWith("/api/v1/messaging/governance/retention");
  });

  it("says so before the first scan", async () => {
    mount({
      retention: () =>
        ok({
          ...OVERVIEW,
          last_scan_at: null,
          classes: OVERVIEW.classes.map((c) => ({ ...c, eligible: null, held: null })),
        }),
    });
    expect(await screen.findByText(/No scan has run yet/)).toBeTruthy();
    expect(screen.getAllByText("Not scanned yet")).toHaveLength(3);
  });

  it("reads 403 as a plain refusal and an error as a retry", async () => {
    mount({ retention: () => fail(403) });
    expect((await screen.findByRole("alert")).textContent).toContain("not permitted");
    cleanup();
    let calls = 0;
    mount({ retention: () => (calls++ === 0 ? fail(500) : ok(OVERVIEW)) });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Retention by message class" })).toBeTruthy();
  });

  it("is axe clean", async () => {
    const { container } = mount({});
    await screen.findByRole("list", { name: "Retention by message class" });
    const results = await axe.run(container);
    expect(results.violations).toEqual([]);
  });
});

describe("Legal holds tab", () => {
  it("lists holds with free text rendered as text, a status word, count, and a Release that names the hold", async () => {
    mount({});
    await openHolds();
    const list = await screen.findByRole("list", { name: "Legal holds" });
    expect(within(list).getByText("<b>Smith</b> litigation")).toBeTruthy();
    expect(list.querySelector("b")).toBeNull();
    expect(within(list).getByText("Active")).toBeTruthy();
    expect(within(list).getByText("41 messages held")).toBeTruthy();
    expect(list.textContent).toContain(`Channels: ${CH}`);
    expect(list.textContent).toContain("Placed by Pat Officer");
    expect(
      screen.getByRole("button", { name: "Release hold <b>Smith</b> litigation" }),
    ).toBeTruthy();
  });

  it("shows the empty state and omits Release for a released hold", async () => {
    mount({ holds: () => ok({ holds: [] }) });
    await openHolds();
    expect(await screen.findByText("No legal holds")).toBeTruthy();
    cleanup();
    mount({
      holds: () =>
        ok({ holds: [hold({ status: "released", released_at: "2026-10-10T00:00:00Z" })] }),
    });
    await openHolds();
    await screen.findByText("Released");
    expect(screen.queryByRole("button", { name: /Release hold/ })).toBeNull();
  });

  it("validates before sending, then places a hold with the snake_case body and refreshes", async () => {
    let placed = false;
    const { POST, GET } = mount({
      holds: () => ok({ holds: placed ? [hold()] : [] }),
      apply: () => {
        placed = true;
        return ok({});
      },
    });
    await openHolds();
    await screen.findByText("No legal holds");
    fireEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog", { name: "Place a legal hold" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("name");
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "Case A" } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: "short" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("10 characters");
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Subpoena received" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("Choose a scope");
    fireEvent.change(within(dialog).getByLabelText(/^Channel ids/), { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(within(dialog).getByRole("alert").textContent).toContain("valid id");
    expect(POST).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/^Channel ids/), {
      target: { value: `${CH}, ${HOLD}` },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/governance/legal-holds", {
      body: {
        name: "Case A",
        reason: "Subpoena received",
        channel_ids: [CH, HOLD],
        user_ids: [],
        patient_ids: [],
      },
    });
    expect(await screen.findByText("Legal hold placed.")).toBeTruthy();
    await screen.findByRole("list", { name: "Legal holds" });
    expect(GET.mock.calls.filter(([p]) => p.endsWith("/legal-holds")).length).toBeGreaterThan(1);
  });

  it("an org-wide hold sends org_wide only", async () => {
    const { POST } = mount({ holds: () => ok({ holds: [] }), apply: () => ok({}) });
    await openHolds();
    await screen.findByText("No legal holds");
    fireEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "All" } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Regulator inquiry" },
    });
    fireEvent.click(within(dialog).getByLabelText("Hold every message in the organization"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST.mock.calls[0]?.[1]).toEqual({
      body: { name: "All", reason: "Regulator inquiry", org_wide: true },
    });
  });

  it("a stale step-up on place stashes the input and goes to the step-up page; coming back reopens the dialog filled", async () => {
    mount({
      holds: () => ok({ holds: [] }),
      apply: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
    });
    await openHolds();
    await screen.findByText("No legal holds");
    fireEvent.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "Case A" } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Subpoena received" },
    });
    fireEvent.change(within(dialog).getByLabelText(/^Person ids/), { target: { value: CH } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();
    mount({ holds: () => ok({ holds: [] }) });
    await openHolds();
    const again = await screen.findByRole("dialog", { name: "Place a legal hold" });
    expect((within(again).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Case A");
    expect((within(again).getByLabelText(/^Person ids/) as HTMLTextAreaElement).value).toBe(CH);
  });

  it("release: preview, then a second confirmation sends the count seen", async () => {
    const { POST } = mount({
      preview: () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: 412 }),
      release: () => ok({}),
    });
    await openHolds();
    fireEvent.click(
      await screen.findByRole("button", { name: "Release hold <b>Smith</b> litigation" }),
    );
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect(
      await within(first).findByText("412 messages will become eligible on the next scan."),
    ).toBeTruthy();
    const next = within(first).getByRole("button", { name: "Continue" });
    fireEvent.click(next);
    expect(screen.getByRole("dialog", { name: "Release legal hold" })).toBeTruthy(); // reason too short: still step one
    fireEvent.change(within(first).getByLabelText(/^Reason for release/), {
      target: { value: "Matter settled" },
    });
    fireEvent.click(within(first).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Confirm release" });
    expect(confirm.textContent).toContain("nothing is destroyed");
    expect(POST).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirm).getByRole("button", { name: "Release hold <b>Smith</b> litigation now" }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/governance/legal-holds/{id}/release", {
      params: { path: { id: HOLD } },
      body: { reason: "Matter settled", confirmed_eligible_count: 412 },
    });
    expect(await screen.findByText("Legal hold released.")).toBeTruthy();
  });

  it("a stale count (409 RELEASE_PREVIEW_STALE) re-shows the new count and asks again", async () => {
    let n = 412;
    let stale = true;
    const { POST } = mount({
      preview: () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: n }),
      release: () => {
        if (!stale) return ok({});
        stale = false;
        n = 430;
        return fail(409, { error: { code: "RELEASE_PREVIEW_STALE" } });
      },
    });
    await openHolds();
    fireEvent.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/412 messages/);
    fireEvent.change(within(first).getByLabelText(/^Reason for release/), {
      target: { value: "Matter settled" },
    });
    fireEvent.click(within(first).getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /now$/ }));
    expect(
      await screen.findByText(/The count changed.*430 messages will become eligible/),
    ).toBeTruthy();
    expect(screen.getByRole("alertdialog")).toBeTruthy(); // not released
    fireEvent.click(screen.getByRole("button", { name: /now$/ }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST.mock.calls[1]?.[1]).toMatchObject({ body: { confirmed_eligible_count: 430 } });
  });

  it("a stale step-up on release stashes the reason, goes to step-up, and comes back at step one", async () => {
    const preview = () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: 7 });
    mount({ preview, release: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }) });
    await openHolds();
    fireEvent.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/7 messages/);
    fireEvent.change(within(first).getByLabelText(/^Reason for release/), {
      target: { value: "Matter settled" },
    });
    fireEvent.click(within(first).getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /now$/ }));
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();
    mount({ preview });
    await openHolds();
    const back = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect((within(back).getByLabelText(/^Reason for release/) as HTMLTextAreaElement).value).toBe(
      "Matter settled",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull(); // the second confirmation is asked again
  });

  it("cancel sends nothing, and the dialogs are axe clean with focus inside", async () => {
    const { POST, container } = mount({
      preview: () => ok({ hold_id: HOLD, held_messages: 1, eligible_on_release: 1 }),
    });
    await openHolds();
    fireEvent.click(await screen.findByRole("button", { name: /Release hold/ }));
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(dialog).findByText("1 message will become eligible on the next scan.");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((await axe.run(dialog)).violations).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(POST).not.toHaveBeenCalled();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("tabs move with the arrow keys", async () => {
    mount({});
    const tab = await screen.findByRole("tab", { name: "Retention" });
    fireEvent.keyDown(tab, { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Legal holds" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

describe("Who placed a hold, and returning after step-up", () => {
  const ME = "99999999-9999-4999-8999-999999999999";
  const OTHER = "ab12cd34-0000-4000-8000-000000000000";

  it("shows You for the signed-in user and a labelled short id (never a bare uuid) for others", async () => {
    mount({
      holds: () =>
        ok({
          holds: [
            hold({ id: HOLD, placed_by: ME }),
            hold({ id: CH, name: "Other", placed_by: OTHER }),
          ],
        }),
    });
    await openHolds();
    const list = await screen.findByRole("list", { name: "Legal holds" });
    expect(list.textContent).toContain("Placed by you on");
    expect(list.textContent).toContain("Placed by user ab12cd34 on");
    expect(list.textContent).not.toContain(OTHER);
    expect(list.querySelector(`[title="${OTHER}"]`)).toBeTruthy();
    expect(await axe.run(list)).toHaveProperty("violations", []);
  });

  it("returning from step-up lands on Legal holds and reopens the release dialog at step one, prefilled", async () => {
    const preview = () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: 7 });
    stashStepUpDraft("messaging-legal-hold-release", { holdId: HOLD, reason: "Matter settled" });
    mount({ preview });
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect(screen.getByRole("tab", { name: "Legal holds" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(
      (within(dialog).getByLabelText(/^Reason for release/) as HTMLTextAreaElement).value,
    ).toBe("Matter settled");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(await axe.run(dialog)).toHaveProperty("violations", []);
  });

  it("returning from step-up with a stashed place draft lands on Legal holds", async () => {
    stashStepUpDraft("messaging-legal-hold-create", {
      name: "Case A",
      reason: "Subpoena",
      orgWide: false,
      channels: "",
      users: CH,
      patients: "",
    });
    mount({});
    await screen.findByRole("dialog", { name: "Place a legal hold" });
    expect(screen.getByRole("tab", { name: "Legal holds" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("without a stash the Retention tab stays the default", async () => {
    mount({});
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.getByRole("tab", { name: "Retention" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});
