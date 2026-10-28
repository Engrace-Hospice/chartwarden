// M36 WP 5.7 (ADR-0089, PROPOSED) - restricted message export on the web against a mocked network boundary: the request entry (key + live flag), the
// dialog (what is left out, validation, the exact body, error mapping), my exports (chips, expiry, cancel, download only while ready and unexpired),
// and the approver queue (own request has no buttons, reject needs a note, no content). Plus axe.
import type {
  MessagingExportJobDetailDto,
  MessagingExportJobSummaryDto,
  MessagingExportStatus,
} from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { markStepUpReturn, stepUpDraftKeys } from "../../shell/step-up-redirect";
import { ExportApprovals } from "./export-approvals";
import { ExportMine } from "./export-mine";
import { validateDraft } from "./export-request";
import { saveBlob } from "./use-export";

const JOB = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ME = "99999999-9999-4999-8999-999999999999";
const OTHER = "77777777-7777-4777-8777-777777777777";
const WHY = "Quality review of the night team handoffs";
const HOUR = 3_600_000;
const MINUTE = 60_000;
const STEP_UP = { error: { code: "STEP_UP_REQUIRED" } };
const CAN_DOWNLOAD = ["messaging.export.request", "messaging.export.download"];
const RETURN_PATH = "/messaging/export";

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

const job = (over: Partial<MessagingExportJobSummaryDto> = {}): MessagingExportJobSummaryDto => ({
  id: JOB,
  status: "pending_approval",
  requestedBy: ME,
  requestedByName: "Riley Compliance",
  requestedAt: "2026-10-21T10:00:00.000Z",
  scope: {
    scopeKind: "channel",
    channelId: CHANNEL,
    patientId: null,
    dateFrom: null,
    dateTo: null,
  },
  decidedBy: null,
  decidedAt: null,
  readyAt: null,
  expiresAt: null,
  messageCount: null,
  heldExcluded: null,
  part2Excluded: null,
  downloadCount: 0,
  failureCode: null,
  ...over,
});
const detail = (over: Partial<MessagingExportJobDetailDto> = {}): MessagingExportJobDetailDto => ({
  ...job(),
  justification: "<b>Needed</b> for the quality review",
  decisionNote: null,
  buildingAt: null,
  artefactBytes: null,
  artefactSha256: null,
  downloadable: false,
  ...over,
});
const inHours = (h: number): string => new Date(Date.now() + h * HOUR).toISOString();

interface Routes {
  mine?: () => Reply;
  pending?: () => Reply;
  detail?: () => Reply;
  post?: (path: string, body: unknown) => Reply;
  download?: () => Reply;
}

function LocationProbe(): JSX.Element {
  const { pathname, search } = useLocation();
  return <output data-testid="loc">{`${pathname}${search}`}</output>;
}
const here = (): string => screen.getByTestId("loc").textContent ?? "";
const stashedKeys = (): string[] => stepUpDraftKeys();

function mount(
  ui: JSX.Element,
  routes: Routes = {},
  opts: { permissions?: string[]; flag?: boolean } = {},
) {
  const GET = vi.fn((path: string): Promise<Reply> => {
    if (path.endsWith("/mine")) return Promise.resolve(routes.mine?.() ?? ok({ jobs: [] }));
    if (path.endsWith("/pending")) return Promise.resolve(routes.pending?.() ?? ok({ jobs: [] }));
    if (path.endsWith("/download"))
      return Promise.resolve(routes.download?.() ?? ok(new Blob(["{}"])));
    return Promise.resolve(routes.detail?.() ?? ok(detail()));
  });
  const POST = vi.fn(
    (path: string, init?: { body?: unknown }): Promise<Reply> =>
      Promise.resolve(routes.post?.(path, init?.body) ?? ok(job())),
  );
  const view = render(
    <MemoryRouter initialEntries={["/messaging/export"]}>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <SessionProvider
          session={{
            userId: ME,
            organizationId: "org-1",
            permissions: opts.permissions ?? ["messaging.export.request"],
          }}
        >
          <FeatureFlagProvider flags={{ "messaging.export": opts.flag ?? true }}>
            <main>
              <LocationProbe />
              {ui}
            </main>
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const fillRequest = async (id = CHANNEL, justification = WHY) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Request an export" }));
  const dialog = await screen.findByRole("dialog");
  await user.type(within(dialog).getByLabelText(/Channel ID/), id);
  await user.type(within(dialog).getByLabelText(/Justification/), justification);
  return { user, dialog };
};

describe("validateDraft", () => {
  const base = {
    scopeKind: "channel",
    id: CHANNEL,
    dateFrom: "",
    dateTo: "",
    justification: WHY,
  } as const;
  it("accepts a plain request and refuses each bad field", () => {
    expect(validateDraft(base)).toBeNull();
    expect(validateDraft({ ...base, id: "nope" })).toMatch(/valid ID/);
    expect(validateDraft({ ...base, justification: "short" })).toMatch(/20 to 280/);
    expect(validateDraft({ ...base, dateFrom: "2026-01-01" })).toMatch(/both dates/);
    expect(validateDraft({ ...base, dateFrom: "2026-02-01", dateTo: "2026-01-01" })).toMatch(
      /before/,
    );
    expect(validateDraft({ ...base, dateFrom: "2025-01-01", dateTo: "2026-01-03" })).toMatch(/366/);
    expect(validateDraft({ ...base, dateFrom: "2025-01-01", dateTo: "2026-01-02" })).toBeNull();
  });
});

describe("Request entry and dialog", () => {
  it("is offered only with the request key AND the live flag", () => {
    mount(<ExportMine />);
    expect(screen.getByRole("button", { name: "Request an export" })).toBeTruthy();
    cleanup();
    mount(<ExportMine />, {}, { flag: false });
    expect(screen.queryByRole("button", { name: "Request an export" })).toBeNull();
    cleanup();
    mount(<ExportMine />, {}, { permissions: ["messaging.read"] });
    expect(screen.queryByRole("button", { name: "Request an export" })).toBeNull();
  });

  it("states what is left out up front, refuses bad input without a request, and sends the exact body", async () => {
    const { POST } = mount(<ExportMine />);
    const { user, dialog } = await fillRequest(CHANNEL, "too short");
    for (const text of [
      "legal hold",
      "Part 2",
      "metadata",
      "name and size",
      "24 hours",
      "second person",
    ]) {
      expect(dialog.textContent?.toLowerCase()).toContain(text.toLowerCase());
    }
    await user.click(within(dialog).getByRole("button", { name: "Send for approval" }));
    expect(await within(dialog).findByText(/20 to 280 characters/)).toBeTruthy();
    expect(within(dialog).getByText(/9 of 280 characters/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    await user.clear(within(dialog).getByLabelText(/Justification/));
    await user.type(within(dialog).getByLabelText(/Justification/), WHY);
    await user.type(within(dialog).getByLabelText(/From/), "2026-01-01");
    await user.click(within(dialog).getByRole("button", { name: "Send for approval" }));
    expect(await within(dialog).findByText(/both dates/)).toBeTruthy();
    await user.type(within(dialog).getByLabelText(/To \(/), "2026-02-01");
    await user.click(within(dialog).getByRole("button", { name: "Send for approval" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/export", {
      body: {
        scopeKind: "channel",
        channelId: CHANNEL,
        dateFrom: "2026-01-01",
        dateTo: "2026-02-01",
        justification: WHY,
      },
    });
    expect(await screen.findByText(/waiting for a second person/)).toBeTruthy();
  });

  it.each([
    [404, {}, /not available/],
    [429, { error: { code: "EXPORT_LIMIT" } }, /limit/],
    [409, { error: { code: "EXPORT_TOO_LARGE" } }, /too many messages/],
    [500, {}, /could not be requested/],
    [400, {}, /Check the details and try again/],
    [401, {}, /Sign in again/],
    [403, {}, /not permitted/],
  ])("maps a %s answer without guessing a reason", async (status, error, text) => {
    mount(<ExportMine />, { post: () => fail(status, error) });
    const { user, dialog } = await fillRequest();
    await user.click(within(dialog).getByRole("button", { name: "Send for approval" }));
    expect(await within(dialog).findByText(text)).toBeTruthy();
  });
});

describe("My exports", () => {
  it("shows every status as a word, and a ready file with its expiry countdown", async () => {
    const statuses: MessagingExportStatus[] = [
      "pending_approval",
      "approved",
      "building",
      "failed",
      "expired",
      "rejected",
      "cancelled",
    ];
    mount(<ExportMine />, {
      mine: () =>
        ok({
          jobs: [
            ...statuses.map((s, i) => job({ id: `id-${i}`, status: s })),
            job({ id: "ready", status: "ready", expiresAt: inHours(23) }),
          ],
        }),
    });
    const list = await screen.findByRole("list", { name: "My exports" });
    for (const label of [
      "Pending approval",
      "Approved",
      "Building",
      "Failed",
      "Expired",
      "Rejected",
      "Cancelled",
      "Ready",
    ]) {
      expect(within(list).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(within(list).getByText(/Expires in 22 h 5\d min|Expires in 23 h/)).toBeTruthy();
  });

  it("offers Download only while ready and unexpired, and saves the blob", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const created = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: vi.fn() });
    const { GET } = mount(
      <ExportMine />,
      {
        mine: () =>
          ok({
            jobs: [
              job({ id: "a", status: "ready", expiresAt: inHours(5) }),
              job({ id: "b", status: "ready", expiresAt: inHours(-1) }),
              job({ id: "c", status: "building" }),
            ],
          }),
      },
      { permissions: CAN_DOWNLOAD },
    );
    const list = await screen.findByRole("list", { name: "My exports" });
    expect(within(list).getAllByRole("button", { name: "Download" })).toHaveLength(1);
    expect(within(list).getAllByText("Expired")).toHaveLength(1); // the lapsed link reads as expired
    const user = userEvent.setup();
    await user.click(within(list).getByRole("button", { name: "Download" }));
    await waitFor(() => expect(created).toHaveBeenCalled());
    expect(GET).toHaveBeenCalledWith(
      "/api/v1/messaging/export/{id}/download",
      expect.objectContaining({ parseAs: "blob" }),
    );
    expect(await screen.findByText("The download has started.")).toBeTruthy();
  });

  it("maps a 409 on download to plain words", async () => {
    mount(
      <ExportMine />,
      {
        mine: () => ok({ jobs: [job({ status: "ready", expiresAt: inHours(5) })] }),
        download: () => fail(409, { error: { code: "EXPORT_EXPIRED" } }),
      },
      { permissions: CAN_DOWNLOAD },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Download" }));
    expect(await screen.findByText(/link has expired/)).toBeTruthy();
  });

  it("cancels only a pending request", async () => {
    const { POST } = mount(<ExportMine />, {
      mine: () => ok({ jobs: [job(), job({ id: "x", status: "approved" })] }),
    });
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole("button", { name: "Cancel request" });
    expect(buttons).toHaveLength(1);
    await user.click(buttons[0] as HTMLElement);
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/messaging/export/{id}/cancel", {
        params: { path: { id: JOB } },
      }),
    );
  });

  it("keeps the list but hides the request entry with the flag off, and has no axe violations", async () => {
    const { container } = mount(
      <ExportMine />,
      { mine: () => ok({ jobs: [job({ status: "ready", expiresAt: inHours(2) })] }) },
      { flag: false },
    );
    await screen.findByRole("list", { name: "My exports" });
    expect(screen.queryByRole("button", { name: "Request an export" })).toBeNull();
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});

describe("Approver queue", () => {
  it("lists requests and shows the justification as text with no content", async () => {
    mount(
      <ExportApprovals />,
      {
        pending: () => ok({ jobs: [job({ requestedBy: OTHER })] }),
        detail: () => ok(detail({ requestedBy: OTHER })),
      },
      { permissions: ["messaging.export.approve"] },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText("<b>Needed</b> for the quality review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.queryByText(/messages ·/)).toBeNull();
  });

  it("hides Approve and Reject on the person's own request", async () => {
    mount(<ExportApprovals />, { pending: () => ok({ jobs: [job()] }) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    expect(await screen.findByText(/This is your own request/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("needs a note to reject, then sends it; approve sends the typed note", async () => {
    const { POST } = mount(<ExportApprovals />, {
      pending: () => ok({ jobs: [job({ requestedBy: OTHER })] }),
      detail: () => ok(detail({ requestedBy: OTHER })),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Reject" }));
    expect(await screen.findByText(/note to reject/)).toBeTruthy();
    expect(POST).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText(/Note/), "Out of scope");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/messaging/export/{id}/reject", {
        params: { path: { id: JOB } },
        body: { note: "Out of scope" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/messaging/export/{id}/approve", {
        params: { path: { id: JOB } },
        body: { note: "Out of scope" },
      }),
    );
  });

  it("says a decided request is already decided (409) and has no axe violations", async () => {
    const { container } = mount(<ExportApprovals />, {
      pending: () => ok({ jobs: [job({ requestedBy: OTHER })] }),
      detail: () => ok(detail({ requestedBy: OTHER })),
      post: () => fail(409, { error: { code: "EXPORT_ALREADY_DECIDED" } }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/already been decided/)).toBeTruthy();
    const result = await axe.run(container);
    expect(result.violations).toEqual([]);
  });
});

describe("Review fixes (WP 5.7)", () => {
  const pendingOther = {
    pending: () => ok({ jobs: [job({ requestedBy: OTHER })] }),
    detail: () => ok(detail({ requestedBy: OTHER })),
  };
  const send = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Send for approval" });

  it("a 400 is never shown as the justification message", async () => {
    mount(<ExportMine />, { post: () => fail(400) });
    const { user, dialog } = await fillRequest();
    await user.click(send(dialog));
    expect(await within(dialog).findByText("Check the details and try again.")).toBeTruthy();
    expect(within(dialog).queryByText(/20 to 280/)).toBeNull();
  });

  it("makes the dialog Close and Send and the Retry button at least 44px tall", async () => {
    mount(<ExportMine />, { mine: () => fail(500) });
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(retry.style.minHeight).toBe("2.875rem");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request an export" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Close" }).style.minHeight).toBe("2.875rem");
    expect(send(dialog).style.minHeight).toBe("2.875rem");
  });

  it("sends a patient-scope request with patientId and no channelId", async () => {
    const { POST } = mount(<ExportMine />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request an export" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "One patient" }));
    await user.type(within(dialog).getByLabelText(/Patient ID/), CHANNEL);
    await user.type(within(dialog).getByLabelText(/Justification/), WHY);
    await user.click(send(dialog));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    expect(POST).toHaveBeenCalledWith("/api/v1/messaging/export", {
      body: { scopeKind: "patient", patientId: CHANNEL, justification: WHY },
    });
  });

  it("stashes the request draft on step-up, redirects, and reopens the dialog with it", async () => {
    mount(<ExportMine />, { post: () => fail(403, STEP_UP) });
    const { user, dialog } = await fillRequest();
    await user.click(send(dialog));
    await waitFor(() => expect(here()).toMatch(/^\/step-up\?returnTo=/));
    expect(here()).not.toContain(WHY); // the draft never goes in the URL
    expect(stashedKeys()).toHaveLength(1);
    cleanup();
    markStepUpReturn(RETURN_PATH);
    mount(<ExportMine />);
    const reopened = await screen.findByRole("dialog");
    expect((within(reopened).getByLabelText(/Justification/) as HTMLTextAreaElement).value).toBe(
      WHY,
    );
    expect((within(reopened).getByLabelText(/Channel ID/) as HTMLInputElement).value).toBe(CHANNEL);
  });

  it("keeps the approver's note across step-up and clears it once the decision succeeds", async () => {
    mount(<ExportApprovals />, { ...pendingOther, post: () => fail(403, STEP_UP) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.type(await screen.findByLabelText(/Note/), "Out of scope");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(here()).toMatch(/^\/step-up\?returnTo=/));
    expect(here()).not.toContain("Out");
    expect(stashedKeys()).toHaveLength(1);
    cleanup();
    markStepUpReturn(RETURN_PATH);
    const { POST } = mount(<ExportApprovals />, pendingOther);
    const note = (await screen.findByLabelText(/Note/)) as HTMLTextAreaElement;
    expect(note.value).toBe("Out of scope");
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(stashedKeys()).toHaveLength(0));
  });

  it("does not restore a note when the person did not come back from step-up", async () => {
    mount(<ExportApprovals />, { ...pendingOther, post: () => fail(403, STEP_UP) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    await user.type(await screen.findByLabelText(/Note/), "Out of scope");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(stashedKeys()).toHaveLength(1));
    cleanup();
    mount(<ExportApprovals />, pendingOther);
    expect(await screen.findByRole("button", { name: "Review" })).toBeTruthy();
    expect(stashedKeys()).toHaveLength(0);
  });

  it("sends ONE request when Approve is clicked twice before the screen updates", async () => {
    const { POST } = mount(<ExportApprovals />, pendingOther);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Review" }));
    const approve = await screen.findByRole("button", { name: "Approve" });
    await act(async () => {
      approve.click();
      approve.click();
    });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("sends ONE cancel when Cancel is clicked twice before the screen updates", async () => {
    const { POST } = mount(<ExportMine />, { mine: () => ok({ jobs: [job()] }) });
    const cancel = await screen.findByRole("button", { name: "Cancel request" });
    await act(async () => {
      cancel.click();
      cancel.click();
    });
    await waitFor(() => expect(POST).toHaveBeenCalled());
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, { error: { code: "EXPORT_ALREADY_DECIDED" } }],
    [404, {}],
  ])("re-reads the list after a %s on cancel", async (status, error) => {
    const mine = vi.fn(() => ok({ jobs: [job()] }));
    mount(<ExportMine />, { mine, post: () => fail(status, error) });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel request" }));
    await waitFor(() => expect(mine).toHaveBeenCalledTimes(2));
  });

  it("hides Download, with a plain line, for a requester without the download permission", async () => {
    mount(<ExportMine />, {
      mine: () => ok({ jobs: [job({ status: "ready", expiresAt: inHours(5) })] }),
    });
    expect(await screen.findByText("You cannot download this export.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
  });

  it("sends a stale step-up on download to the step-up page", async () => {
    mount(
      <ExportMine />,
      {
        mine: () => ok({ jobs: [job({ status: "ready", expiresAt: inHours(5) })] }),
        download: () => fail(403, STEP_UP),
      },
      { permissions: CAN_DOWNLOAD },
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Download" }));
    await waitFor(() => expect(here()).toMatch(/^\/step-up\?returnTo=/));
  });

  it("revokes the object URL a few seconds after saving, and removes the anchor", () => {
    vi.useFakeTimers();
    try {
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: revoke });
      let saved: HTMLAnchorElement | undefined;
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        saved = this;
      });
      saveBlob(new Blob(["{}"]), "chartwarden-messaging-export-a.json");
      expect(saved?.download).toBe("chartwarden-messaging-export-a.json");
      expect(saved?.href).toContain("blob:x");
      expect(document.body.contains(saved ?? null)).toBe(false);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);
      expect(revoke).toHaveBeenCalledWith("blob:x");
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the expiry down, drops Download at expiry, and stops ticking on unmount", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const expiresAt = new Date(Date.now() + 31 * MINUTE).toISOString();
      const { unmount } = mount(
        <ExportMine />,
        { mine: () => ok({ jobs: [job({ status: "ready", expiresAt })] }) },
        { permissions: CAN_DOWNLOAD },
      );
      expect(await screen.findByText("Expires in 31 min")).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2 * MINUTE);
      });
      expect(screen.getByText("Expires in 29 min")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(30 * MINUTE);
      });
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
      expect(screen.queryByText(/Expires in/)).toBeNull();
      expect(screen.getByText("Expired")).toBeTruthy();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no axe violations on the open request dialog, the empty state and the error state", async () => {
    const empty = mount(<ExportMine />);
    await screen.findByText("No exports yet");
    expect((await axe.run(empty.container)).violations).toEqual([]);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Request an export" }));
    const dialog = await screen.findByRole("dialog");
    expect((await axe.run(dialog)).violations).toEqual([]);
    cleanup();
    const failed = mount(<ExportMine />, { mine: () => fail(500) });
    await screen.findByText("Could not load the exports.");
    expect((await axe.run(failed.container)).violations).toEqual([]);
  });
});
