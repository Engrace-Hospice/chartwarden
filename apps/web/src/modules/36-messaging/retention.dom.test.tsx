// M36 WP 5.6 (ADR-0086, PROPOSED) - the retention and legal-hold screen against a mocked network boundary: the per-class view (plan-only wording, never
// scanned, capped, certificate), the hold list, place (validation, step-up with stashed input), release (preview then a second confirmation that
// sends the count seen, a stale count re-shown, step-up), the 403 / error states, free text rendered as text, keyboard and axe.
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MessageLegalHoldDto, RetentionClassDto, RetentionOverviewDto } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { markStepUpReturn, stashStepUpDraft, stepUpDraftKey } from "../../shell/step-up-redirect";
import { APPLY_ACTION, RELEASE_ACTION } from "./legal-hold-drafts";
import { RetentionGovernance } from "./retention-governance";
import { useLegalHolds } from "./use-retention";

const CH = "11111111-1111-4111-8111-111111111111";
const HOLD = "22222222-2222-4222-8222-222222222222";
const ME = "99999999-9999-4999-8999-999999999999";
const ORG = "org-1";
const PATH = "/messaging/governance/retention";
const owner = (userId = ME, organizationId = ORG) => ({ userId, organizationId });
const createKey = (o = owner()) => stepUpDraftKey(o, APPLY_ACTION, "new");
const releaseKey = (o = owner(), id = HOLD) => stepUpDraftKey(o, RELEASE_ACTION, id);
/** What the step-up page does on success, just before it navigates back. */
const comeBackFromStepUp = () => markStepUpReturn(PATH);

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
function mount(routes: Routes, userId = ME, organizationId = ORG) {
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
    <MemoryRouter initialEntries={[PATH]}>
      <ApiClientProvider
        client={
          { GET, POST, PUT: writes[0], PATCH: writes[1], DELETE: writes[2] } as unknown as ApiClient
        }
      >
        <SessionProvider session={{ userId, organizationId }}>
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
    comeBackFromStepUp();
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
    comeBackFromStepUp();
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
    stashStepUpDraft(releaseKey(), { holdId: HOLD, reason: "Matter settled" });
    comeBackFromStepUp();
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
    stashStepUpDraft(createKey(), {
      name: "Case A",
      reason: "Subpoena",
      orgWide: false,
      channels: "",
      users: CH,
      patients: "",
    });
    comeBackFromStepUp();
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

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const PREVIEW_7 = () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: 7 });

describe("Step-up drafts are scoped and only reopen on a genuine return", () => {
  const draft = {
    name: "Case A",
    reason: "Subpoena",
    orgWide: false,
    channels: "",
    users: CH,
    patients: "",
  };
  const OTHER_USER = "aaaaaaaa-0000-4000-8000-000000000000";

  it("another user's draft is invisible, even right after a genuine return", async () => {
    stashStepUpDraft(createKey(owner(OTHER_USER)), draft);
    stashStepUpDraft(releaseKey(owner(OTHER_USER)), { holdId: HOLD, reason: "Matter settled" });
    comeBackFromStepUp();
    mount({ preview: PREVIEW_7 });
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.getByRole("tab", { name: "Retention" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("another organization's draft for the same user is invisible", async () => {
    stashStepUpDraft(createKey(owner(ME, "org-2")), draft);
    comeBackFromStepUp();
    mount({});
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an abandoned draft does not pop a dialog open on a later normal visit, and is cleaned up", async () => {
    stashStepUpDraft(createKey(), draft);
    stashStepUpDraft(releaseKey(), { holdId: HOLD, reason: "Matter settled" });
    mount({ preview: PREVIEW_7 });
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.getByRole("tab", { name: "Retention" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await openHolds();
    await screen.findByRole("list", { name: "Legal holds" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(window.sessionStorage.length).toBe(0));
  });

  it("a return marker for another page does not reopen anything", async () => {
    stashStepUpDraft(createKey(), draft);
    markStepUpReturn("/somewhere/else");
    mount({});
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the marker is one-shot: a second visit after a genuine return finds no dialog", async () => {
    stashStepUpDraft(createKey(), draft);
    comeBackFromStepUp();
    mount({ holds: () => ok({ holds: [] }) });
    await screen.findByRole("dialog", { name: "Place a legal hold" });
    cleanup();
    mount({ holds: () => ok({ holds: [] }) });
    await screen.findByRole("list", { name: "Retention by message class" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a genuine return reopens the place dialog filled, and cancelling it drops the draft", async () => {
    stashStepUpDraft(createKey(), draft);
    comeBackFromStepUp();
    mount({ holds: () => ok({ holds: [] }) });
    const dialog = await screen.findByRole("dialog", { name: "Place a legal hold" });
    expect((within(dialog).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Case A");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(window.sessionStorage.length).toBe(0);
  });

  it("a resumed release dialog opens once and does not refetch the list", async () => {
    stashStepUpDraft(releaseKey(), { holdId: HOLD, reason: "Matter settled" });
    comeBackFromStepUp();
    const { GET } = mount({ preview: PREVIEW_7 });
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect(GET.mock.calls.filter(([p]) => p.endsWith("/legal-holds")).length).toBe(1);
    expect(screen.getByRole("dialog", { name: "Release legal hold" })).toBe(dialog);
  });
});

describe("Stale-while-revalidate and focus", () => {
  it("after placing, the list is never replaced by a spinner while it refetches", async () => {
    const slow = deferred<Reply>();
    let reads = 0;
    const { GET } = mount({ holds: () => ok({ holds: [hold()] }), apply: () => ok({}) });
    const user = userEvent.setup();
    await openHolds();
    await screen.findByRole("list", { name: "Legal holds" });
    GET.mockImplementation((path: string) => {
      if (path.endsWith("/legal-holds")) {
        reads += 1;
        return slow.promise;
      }
      return Promise.resolve(ok(OVERVIEW));
    });
    await user.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Case B");
    await user.type(within(dialog).getByLabelText(/^Reason/), "Subpoena received");
    await user.type(within(dialog).getByLabelText(/^Channel ids/), CH);
    await user.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(reads).toBe(1));
    expect(screen.getByRole("list", { name: "Legal holds" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    await act(async () => slow.resolve(ok({ holds: [hold(), hold({ id: CH, name: "Case B" })] })));
    expect(await screen.findByText("Case B")).toBeTruthy();
  });

  it("after a place, focus lands on the result announcement, not on the page body", async () => {
    mount({ holds: () => ok({ holds: [] }), apply: () => ok({}) });
    const user = userEvent.setup();
    await openHolds();
    await screen.findByText("No legal holds");
    await user.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "All");
    await user.type(within(dialog).getByLabelText(/^Reason/), "Regulator inquiry");
    await user.click(within(dialog).getByLabelText("Hold every message in the organization"));
    await user.click(within(dialog).getByRole("button", { name: "Place hold" }));
    const status = await screen.findByText("Legal hold placed.");
    await waitFor(() => expect(document.activeElement).toBe(status));
  });

  it("after a release (the Release button disappears), focus lands on the result announcement", async () => {
    let released = false;
    mount({
      holds: () =>
        ok({
          holds: [
            released ? hold({ status: "released", released_at: "2026-10-10T00:00:00Z" }) : hold(),
          ],
        }),
      preview: PREVIEW_7,
      release: () => {
        released = true;
        return ok({});
      },
    });
    const user = userEvent.setup();
    await openHolds();
    await user.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/7 messages/);
    await user.type(within(first).getByLabelText(/^Reason for release/), "Matter settled");
    await user.click(within(first).getByRole("button", { name: "Continue" }));
    await user.click(await screen.findByRole("button", { name: /now$/ }));
    const status = await screen.findByText("Legal hold released.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    await screen.findByText("Released");
    expect(screen.queryByRole("button", { name: /Release hold/ })).toBeNull();
  });

  it("cancelling the release dialog returns focus to the Release button", async () => {
    mount({ preview: PREVIEW_7 });
    const user = userEvent.setup();
    await openHolds();
    const trigger = await screen.findByRole("button", { name: /Release hold/ });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(dialog).findByText(/7 messages/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(trigger);
  });

  it("changing step moves focus to the new step heading, and the stale count is an alert", async () => {
    let n = 7;
    let stale = true;
    mount({
      preview: () => ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: n }),
      release: () => {
        if (!stale) return ok({});
        stale = false;
        n = 9;
        return fail(409, { error: { code: "RELEASE_PREVIEW_STALE" } });
      },
    });
    const user = userEvent.setup();
    await openHolds();
    await user.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/7 messages/);
    expect(first.querySelector("[aria-live]")?.textContent).toContain("7 messages");
    await user.type(within(first).getByLabelText(/^Reason for release/), "Matter settled");
    await user.click(within(first).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog", { name: "Confirm release" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(confirm).getByRole("heading", { name: "Confirm release" }),
      ),
    );
    await user.click(within(confirm).getByRole("button", { name: /now$/ }));
    const alert = await within(confirm).findByRole("alert");
    expect(alert.textContent).toMatch(/The count changed.*9 messages will become eligible/);
    await user.click(within(confirm).getByRole("button", { name: "Back" }));
    const back = await screen.findByRole("dialog", { name: "Release legal hold" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(back).getByRole("heading", { name: "Release legal hold" }),
      ),
    );
  });
});

describe("Tabs keyboard", () => {
  it("ArrowLeft goes to the previous tab (wrapping), Home and End jump, and focus follows", async () => {
    mount({});
    const retention = await screen.findByRole("tab", { name: "Retention" });
    fireEvent.keyDown(retention, { key: "ArrowLeft" });
    const holds = screen.getByRole("tab", { name: "Legal holds" });
    expect(holds.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(holds);
    fireEvent.keyDown(holds, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Retention" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Retention" }), { key: "End" });
    expect(screen.getByRole("tab", { name: "Legal holds" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "Legal holds" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Retention" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("only the selected tab points at a panel that exists, and that panel is focusable", async () => {
    mount({});
    const retention = await screen.findByRole("tab", { name: "Retention" });
    const panel = screen.getByRole("tabpanel");
    expect(retention.getAttribute("aria-controls")).toBe(panel.id);
    expect(screen.getByRole("tab", { name: "Legal holds" }).hasAttribute("aria-controls")).toBe(
      false,
    );
    expect(panel.getAttribute("tabindex")).toBe("0");
    expect(panel.getAttribute("aria-labelledby")).toBe(retention.id);
  });
});

describe("Double submits, cancel while busy, preview retry", () => {
  it("a double-click on Place hold sends one request", async () => {
    const gate = deferred<Reply>();
    const { POST } = mount({ holds: () => ok({ holds: [] }) });
    POST.mockImplementation(() => gate.promise);
    const user = userEvent.setup();
    await openHolds();
    await screen.findByText("No legal holds");
    await user.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "All");
    await user.type(within(dialog).getByLabelText(/^Reason/), "Regulator inquiry");
    await user.click(within(dialog).getByLabelText("Hold every message in the organization"));
    await user.dblClick(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(POST).toHaveBeenCalledTimes(1);
    await act(async () => gate.resolve(ok({})));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("Cancel and Escape are ignored while placing; the dialog closes only on the answer", async () => {
    const gate = deferred<Reply>();
    const { POST } = mount({ holds: () => ok({ holds: [] }) });
    POST.mockImplementation(() => gate.promise);
    const user = userEvent.setup();
    await openHolds();
    await screen.findByText("No legal holds");
    await user.click(screen.getByRole("button", { name: "Place legal hold" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "All");
    await user.type(within(dialog).getByLabelText(/^Reason/), "Regulator inquiry");
    await user.click(within(dialog).getByLabelText("Hold every message in the organization"));
    await user.click(within(dialog).getByRole("button", { name: "Place hold" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Place a legal hold" })).toBeTruthy();
    await act(async () => gate.resolve(ok({})));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("Legal hold placed.")).toBeTruthy();
  });

  it("a double-click on the confirm button releases once, and Back/Escape are inert meanwhile", async () => {
    const gate = deferred<Reply>();
    const { POST } = mount({ preview: PREVIEW_7 });
    POST.mockImplementation(() => gate.promise);
    const user = userEvent.setup();
    await openHolds();
    await user.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/7 messages/);
    await user.type(within(first).getByLabelText(/^Reason for release/), "Matter settled");
    await user.click(within(first).getByRole("button", { name: "Continue" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.dblClick(within(confirm).getByRole("button", { name: /now$/ }));
    await user.click(within(confirm).getByRole("button", { name: "Back" }));
    await user.keyboard("{Escape}");
    expect(POST).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog", { name: "Confirm release" })).toBeTruthy();
    await act(async () => gate.resolve(ok({})));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Legal hold released.")).toBeTruthy();
  });

  it("a failed preview offers Retry, and Retry fills in the count", async () => {
    let attempts = 0;
    mount({ preview: () => (attempts++ === 0 ? fail(500) : PREVIEW_7()) });
    const user = userEvent.setup();
    await openHolds();
    await user.click(await screen.findByRole("button", { name: /Release hold/ }));
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(dialog).findByText("Could not count the messages this release frees.");
    await user.click(within(dialog).getByRole("button", { name: "Retry count" }));
    expect(await within(dialog).findByText(/7 messages will become eligible/)).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Retry count" })).toBeNull();
  });

  it("closing the release dialog before the preview lands applies nothing and does not throw", async () => {
    const gate = deferred<Reply>();
    const { GET } = mount({});
    const real = GET.getMockImplementation();
    GET.mockImplementation((path: string, init?: unknown) =>
      path.endsWith("/release-preview") ? gate.promise : (real?.(path, init) as Promise<Reply>),
    );
    const user = userEvent.setup();
    await openHolds();
    await user.click(await screen.findByRole("button", { name: /Release hold/ }));
    const dialog = await screen.findByRole("dialog", { name: "Release legal hold" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => gate.resolve(PREVIEW_7()));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("useLegalHolds refetch race", () => {
  const wrap =
    (client: unknown) =>
    ({ children }: { children: React.ReactNode }) => (
      <ApiClientProvider client={client as ApiClient}>{children}</ApiClientProvider>
    );

  it("only the newest response applies: a slow older read cannot overwrite a newer one", async () => {
    const slowOld = deferred<Reply>();
    let n = 0;
    const GET = vi.fn((_p: string) => {
      n += 1;
      return n === 1
        ? slowOld.promise
        : Promise.resolve(ok({ holds: [hold({ id: CH, name: "Newer" })] }));
    });
    const { result } = renderHook(() => useLegalHolds(), { wrapper: wrap({ GET }) });
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    act(() => result.current.reload());
    await waitFor(() => {
      const v = result.current.view;
      expect(v.status === "ready" && v.data[0]?.name).toBe("Newer");
    });
    await act(async () => slowOld.resolve(ok({ holds: [hold({ name: "Older" })] })));
    const v = result.current.view;
    expect(v.status === "ready" && v.data[0]?.name).toBe("Newer");
  });

  it("the mapped view keeps its identity between renders so effects keyed on it do not refire", async () => {
    const GET = vi.fn(() => Promise.resolve(ok({ holds: [hold()] })));
    const { result, rerender } = renderHook(() => useLegalHolds(), { wrapper: wrap({ GET }) });
    await waitFor(() => expect(result.current.view.status).toBe("ready"));
    const before = result.current.view;
    rerender();
    expect(result.current.view).toBe(before);
  });
});

describe("Review round 2: one-shot prefill, failed reloads, stale re-preview, refusals, scrim", () => {
  const draft = {
    name: "Case A",
    reason: "Subpoena received",
    orgWide: false,
    channels: "",
    users: CH,
    patients: "",
  };
  const placeButton = () => screen.getByRole("button", { name: "Place legal hold" });
  const closeScrim = () => fireEvent.click(screen.getByRole("button", { name: "Close" }));
  const reasonOf = (d: HTMLElement) =>
    (within(d).getByLabelText(/^Reason for release/) as HTMLTextAreaElement).value;

  it("a resumed place draft prefills once: after a successful place, reopening starts empty", async () => {
    stashStepUpDraft(createKey(), draft);
    comeBackFromStepUp();
    mount({ holds: () => ok({ holds: [] }), apply: () => ok({}) });
    const first = await screen.findByRole("dialog", { name: "Place a legal hold" });
    expect((within(first).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Case A");
    fireEvent.click(within(first).getByRole("button", { name: "Place hold" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(placeButton());
    const again = await screen.findByRole("dialog", { name: "Place a legal hold" });
    expect((within(again).getByLabelText(/^Name/) as HTMLInputElement).value).toBe("");
    expect((within(again).getByLabelText(/^Reason/) as HTMLTextAreaElement).value).toBe("");
  });

  it("a resumed release reason prefills once: after Cancel, reopening Release starts empty", async () => {
    stashStepUpDraft(releaseKey(), { holdId: HOLD, reason: "Matter settled" });
    comeBackFromStepUp();
    mount({ preview: PREVIEW_7 });
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect(reasonOf(first)).toBe("Matter settled");
    fireEvent.click(within(first).getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: /Release hold/ }));
    const again = await screen.findByRole("dialog", { name: "Release legal hold" });
    expect(reasonOf(again)).toBe("");
  });

  it("a stashed place draft of the wrong shape is ignored", async () => {
    stashStepUpDraft(createKey(), { name: 7, reason: null });
    comeBackFromStepUp();
    mount({ holds: () => ok({ holds: [] }) });
    await screen.findByRole("tab", { name: "Retention" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a failed reload after a place keeps the list and offers Retry; Retry recovers", async () => {
    let reads = 0;
    mount({
      holds: () => {
        reads += 1;
        return reads === 2 ? fail(500) : ok({ holds: [hold()] });
      },
      apply: () => ok({}),
    });
    const user = userEvent.setup();
    await openHolds();
    await screen.findByRole("list", { name: "Legal holds" });
    await user.click(placeButton());
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Case B");
    await user.type(within(dialog).getByLabelText(/^Reason/), "Subpoena received");
    await user.type(within(dialog).getByLabelText(/^Channel ids/), CH);
    await user.click(within(dialog).getByRole("button", { name: "Place hold" }));
    expect(await screen.findByText("Could not load this section.")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Legal holds" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByText("Could not load this section.")).toBeNull());
    expect(screen.getByRole("list", { name: "Legal holds" })).toBeTruthy();
  });

  it("Retry from the error view shows the loading state", async () => {
    const slow = deferred<Reply>();
    let reads = 0;
    mount({ holds: () => (reads++ === 0 ? fail(500) : (slow.promise as unknown as Reply)) });
    await openHolds();
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("Could not load this section.")).toBeNull();
  });

  it("after a stale count the confirm button stays busy until the new count lands", async () => {
    const second = deferred<Reply>();
    let previews = 0;
    const { POST } = mount({
      preview: () => (previews++ === 0 ? PREVIEW_7() : (second.promise as unknown as Reply)),
      release: () => fail(409, { error: { code: "RELEASE_PREVIEW_STALE" } }),
    });
    await openHolds();
    fireEvent.click(await screen.findByRole("button", { name: /Release hold/ }));
    const first = await screen.findByRole("dialog", { name: "Release legal hold" });
    await within(first).findByText(/7 messages/);
    fireEvent.change(within(first).getByLabelText(/^Reason for release/), {
      target: { value: "Matter settled" },
    });
    fireEvent.click(within(first).getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: /now$/ }));
    await waitFor(() => expect(previews).toBe(2));
    const confirm = screen.getByRole("button", { name: /now$/ });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(confirm);
    expect(POST).toHaveBeenCalledTimes(1); // the old count was not sent again
    await act(async () =>
      second.resolve(ok({ hold_id: HOLD, held_messages: 41, eligible_on_release: 9 })),
    );
    expect(await screen.findByText(/The count changed.*9 messages/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /now$/ }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("a refusal reads as sign-in (401) or not permitted (403), not as a generic failure", async () => {
    let status = 401;
    mount({ holds: () => ok({ holds: [] }), apply: () => fail(status) });
    await openHolds();
    await screen.findByText("No legal holds");
    const fillAndPlace = (): HTMLElement => {
      fireEvent.click(placeButton());
      const dialog = screen.getByRole("dialog");
      fireEvent.change(within(dialog).getByLabelText(/^Name/), { target: { value: "Case" } });
      fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
        target: { value: "Subpoena received" },
      });
      fireEvent.change(within(dialog).getByLabelText(/^Channel ids/), { target: { value: CH } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Place hold" }));
      return dialog;
    };
    const d401 = fillAndPlace();
    expect((await within(d401).findByRole("alert")).textContent).toContain("Sign in again");
    fireEvent.click(within(d401).getByRole("button", { name: "Cancel" }));
    status = 403;
    const d403 = fillAndPlace();
    expect((await within(d403).findByRole("alert")).textContent).toContain("not permitted");
  });

  it("a scrim click does not discard typed text; an empty dialog still closes on it; Escape closes", async () => {
    mount({ holds: () => ok({ holds: [] }) });
    await openHolds();
    await screen.findByText("No legal holds");
    fireEvent.click(placeButton());
    closeScrim();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(placeButton());
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Subpoena received" },
    });
    closeScrim();
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the place dialog warns not to put patient identifiers in the reason", async () => {
    mount({ holds: () => ok({ holds: [] }) });
    await openHolds();
    await screen.findByText("No legal holds");
    fireEvent.click(placeButton());
    expect(screen.getByText(/Do not include patient names or identifiers/)).toBeTruthy();
  });
});
