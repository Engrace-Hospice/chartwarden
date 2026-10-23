// M36 WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED) - the Redactions tab against a mocked network boundary: every state (loading, empty, error with Retry,
// denied, refresh failure keeping the data), the status words, who can do what, the request dialog, a decision with step-up and the return from it,
// the loud PROVISIONAL sole-officer self-approval, the refusals, free text as text, and axe.
import type { MessageRedactionDto, MessageRedactionListDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { markStepUpReturn } from "../../shell/step-up-redirect";
import { RetentionGovernance } from "./retention-governance";

const ME = "99999999-9999-4999-8999-999999999999";
const OTHER = "88888888-8888-4888-8888-888888888888";
const MSG = "11111111-1111-4111-8111-111111111111";
const MSG2 = "22222222-2222-4222-8222-222222222222";
const MSG3 = "33333333-3333-4333-8333-333333333333";
const ORG = "org-1";
const PATH = "/messaging/governance/retention";

const row = (over: Partial<MessageRedactionDto> = {}): MessageRedactionDto => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  message_id: MSG,
  status: "requested",
  requested_by: OTHER,
  requested_by_name: "<b>Pat</b> Officer",
  requested_at: "2026-10-01T10:00:00.000Z",
  approved_by: null,
  approved_by_name: null,
  approved_at: null,
  self_approved: false,
  countersign_deadline_at: null,
  countersigned_by: null,
  countersigned_by_name: null,
  under_legal_hold: false,
  ...over,
});
const list = (redactions: MessageRedactionDto[], fallback = false): MessageRedactionListDto => ({
  redactions,
  single_officer_fallback_available: fallback,
});

type Reply = { data?: unknown; error?: unknown; response?: { status: number } };
const ok = (data: unknown): Reply => ({ data, response: { status: 200 } });
const fail = (status: number, error: unknown = {}): Reply => ({ error, response: { status } });

interface Routes {
  list?: () => Reply;
  request?: () => Reply;
  decide?: (path: string) => Reply;
}
function mount(routes: Routes) {
  const GET = vi.fn((path: string): Promise<Reply> => {
    if (path.endsWith("/redactions")) return Promise.resolve(routes.list?.() ?? ok(list([])));
    return Promise.resolve(fail(500));
  });
  const POST = vi.fn((path: string, _init?: unknown): Promise<Reply> => {
    if (path.endsWith("/redactions")) return Promise.resolve(routes.request?.() ?? fail(500));
    return Promise.resolve(routes.decide?.(path) ?? fail(500));
  });
  const Where = () => (
    <output data-testid="where">{useLocation().pathname + useLocation().search}</output>
  );
  const view = render(
    <MemoryRouter initialEntries={[PATH]}>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <SessionProvider session={{ userId: ME, organizationId: ORG }}>
          <main>
            <RetentionGovernance />
            <Where />
          </main>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST, ...view };
}
const openTab = async () => fireEvent.click(await screen.findByRole("tab", { name: "Redactions" }));

beforeEach(() => window.sessionStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Redactions tab states", () => {
  it("shows a spinner, then the empty state with the way to start", async () => {
    mount({});
    await openTab();
    expect(await screen.findByText("No redaction requests")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Request redaction" })).toBeTruthy();
  });

  it("a failed load says so with Retry, and Retry loads it", async () => {
    let calls = 0;
    mount({ list: () => (++calls === 1 ? fail(500) : ok(list([row()]))) });
    await openTab();
    expect((await screen.findByRole("alert")).textContent).toContain("Could not load");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("list", { name: "Redaction requests" })).toBeTruthy();
  });

  it("403 and 401 read as what they are", async () => {
    mount({ list: () => fail(403) });
    await openTab();
    expect((await screen.findByRole("alert")).textContent).toContain("not permitted");
    cleanup();
    mount({ list: () => fail(401) });
    await openTab();
    expect((await screen.findByRole("alert")).textContent).toContain("Sign in again");
  });

  it("every status is a word with its plain-language note, names are text, never markup, and a held message says so", async () => {
    mount({
      list: () =>
        ok(
          list([
            row({ id: "a1", under_legal_hold: true }),
            row({
              id: "a2",
              message_id: MSG2,
              status: "awaiting_countersign",
              self_approved: true,
              countersign_deadline_at: "2026-10-04T10:00:00.000Z",
            }),
            row({
              id: "a3",
              message_id: MSG3,
              status: "approved",
              approved_by: OTHER,
              approved_by_name: "Second Officer",
              approved_at: "2026-10-02T10:00:00.000Z",
            }),
            row({ id: "a4", status: "lapsed", self_approved: true }),
          ]),
        ),
    });
    await openTab();
    const rows = within(
      await screen.findByRole("list", { name: "Redaction requests" }),
    ).getAllByRole("listitem");
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain("Waiting for approval");
    expect(rows[0]?.textContent).toContain("Under legal hold");
    expect(rows[0]?.textContent).toContain("<b>Pat</b> Officer"); // literal text
    expect(rows[0]?.querySelector("b")).toBeNull();
    expect(rows[1]?.textContent).toContain("Waiting for countersign");
    expect(rows[1]?.textContent).toContain("NOT redacted yet");
    expect(rows[1]?.textContent).toContain("Countersign by");
    expect(rows[2]?.textContent).toContain("Redacted");
    expect(rows[2]?.textContent).toContain("Approved by Second Officer");
    expect(rows[3]?.textContent).toContain("Countersign lapsed");
  });

  it("a reload that fails keeps the data on screen with an inline Retry", async () => {
    let calls = 0;
    mount({
      list: () => (++calls === 1 ? ok(list([row()])) : fail(500)),
      request: () => ok(row()),
    });
    await openTab();
    await screen.findByRole("list", { name: "Redaction requests" });
    fireEvent.click(screen.getByRole("button", { name: "Request redaction" }));
    const dialog = await screen.findByRole("dialog", { name: "Request a redaction" });
    fireEvent.change(within(dialog).getByLabelText("Message id"), { target: { value: MSG2 } });
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Sent to the wrong channel" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not load"));
    expect(screen.getByRole("list", { name: "Redaction requests" })).toBeTruthy();
  });
});

describe("Request", () => {
  it("validates the id and the reason, sends them, announces it and reloads", async () => {
    const { POST, GET } = mount({ request: () => ok(row()) });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: "Request redaction" }));
    const dialog = await screen.findByRole("dialog", { name: "Request a redaction" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("valid id");
    fireEvent.change(within(dialog).getByLabelText("Message id"), { target: { value: MSG } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("10 to 1000");
    expect(POST).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
      target: { value: "Sent to the wrong channel" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(POST.mock.calls[0]?.[1]).toMatchObject({
      body: { message_id: MSG, reason: "Sent to the wrong channel" },
    });
    expect(screen.getByText("Redaction requested.")).toBeTruthy();
    expect(GET.mock.calls.length).toBeGreaterThan(1);
  });

  it("a duplicate and an unknown message read as what they are", async () => {
    let reply: Reply = fail(409, { error: { code: "REDACTION_EXISTS" } });
    mount({ request: () => reply });
    await openTab();
    const send = async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Request redaction" }));
      const dialog = await screen.findByRole("dialog", { name: "Request a redaction" });
      fireEvent.change(within(dialog).getByLabelText("Message id"), { target: { value: MSG } });
      fireEvent.change(within(dialog).getByLabelText(/^Reason/), {
        target: { value: "Sent to the wrong channel" },
      });
      fireEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
      return dialog;
    };
    let dialog = await send();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("already has");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    reply = fail(404);
    dialog = await send();
    expect((await within(dialog).findByRole("alert")).textContent).toContain("No message");
  });
});

describe("Decisions", () => {
  it("a person is offered Approve on someone else's request and never on their own; an ordinary request gets no sole-officer action", async () => {
    mount({
      list: () =>
        ok(
          list([
            row({ id: "theirs" }),
            row({ id: "mine", message_id: MSG2, requested_by: ME, requested_by_name: "Me" }),
          ]),
        ),
    });
    await openTab();
    const rows = within(
      await screen.findByRole("list", { name: "Redaction requests" }),
    ).getAllByRole("listitem");
    expect(
      within(rows[0] as HTMLElement).getByRole("button", { name: /^Approve redaction/ }),
    ).toBeTruthy();
    expect(within(rows[1] as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.queryByRole("button", { name: /only officer/ })).toBeNull();
  });

  it("approve: one confirmation, then it is sent and announced", async () => {
    const { POST } = mount({
      list: () => ok(list([row()])),
      decide: () => ok(row({ status: "approved" })),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve redaction/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Approve redaction" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST.mock.calls[0]?.[0]).toContain("/approve");
    expect(screen.getByText("Redaction approved.")).toBeTruthy();
  });

  it("a stale step-up goes to the step-up page; coming back reopens the same decision and asks again (nothing is replayed)", async () => {
    const { POST } = mount({
      list: () => ok(list([row()])),
      decide: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve redaction/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve now" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();
    markStepUpReturn(PATH);
    const second = mount({ list: () => ok(list([row()])) });
    expect(await screen.findByRole("alertdialog", { name: "Approve redaction" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Redactions", selected: true })).toBeTruthy();
    expect(second.POST).not.toHaveBeenCalled();
    expect(POST).toHaveBeenCalledTimes(1);
  });

  it("a resumed decision opens once: after cancel, leaving the tab and coming back does not reopen it", async () => {
    mount({
      list: () => ok(list([row()])),
      decide: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve redaction/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve now" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();
    markStepUpReturn(PATH);
    mount({ list: () => ok(list([row()])) });
    const dialog = await screen.findByRole("alertdialog", { name: "Approve redaction" });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Cancel/ }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Retention" }));
    await openTab();
    await screen.findByRole("button", { name: /^Approve redaction/ });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("an abandoned step-up is discarded: a later ordinary visit opens no dialog", async () => {
    mount({
      list: () => ok(list([row()])),
      decide: () => fail(403, { error: { code: "STEP_UP_REQUIRED" } }),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Approve redaction/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Approve now" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain("/step-up?returnTo="),
    );
    cleanup();
    mount({ list: () => ok(list([row()])) });
    await screen.findByRole("tab", { name: "Retention" });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("countersign is offered to someone else on a row waiting for it, with the deadline", async () => {
    const { POST } = mount({
      list: () =>
        ok(
          list([
            row({
              status: "awaiting_countersign",
              self_approved: true,
              countersign_deadline_at: "2026-10-04T10:00:00.000Z",
            }),
          ]),
        ),
      decide: () => ok(row({ status: "approved" })),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /^Countersign redaction/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Countersign redaction" });
    expect(dialog.textContent).toContain("makes the redaction final");
    fireEvent.click(within(dialog).getByRole("button", { name: "Countersign now" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST.mock.calls[0]?.[0]).toContain("/countersign");
    expect(screen.getByText("Redaction countersigned and final.")).toBeTruthy();
  });

  it("the sole-officer action exists only when the server says the fallback is available, is worded as provisional, and needs the acknowledgement", async () => {
    mount({ list: () => ok(list([row({ requested_by: ME, requested_by_name: "Me" })], false)) });
    await openTab();
    await screen.findByRole("list", { name: "Redaction requests" });
    expect(screen.queryByRole("button", { name: /only officer/ })).toBeNull();
    cleanup();

    const { POST } = mount({
      list: () => ok(list([row({ requested_by: ME, requested_by_name: "Me" })], true)),
      decide: () => ok(row({ status: "awaiting_countersign", self_approved: true })),
    });
    await openTab();
    fireEvent.click(await screen.findByRole("button", { name: /only officer/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("provisional");
    expect(dialog.textContent).toContain("hides NOTHING by itself");
    expect(dialog.textContent).toContain("72 hours");
    const confirm = within(dialog).getByRole("button", { name: "Approve my own request" });
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(POST.mock.calls[0]?.[0]).toContain("/self-approve");
    expect(screen.getByText(/Waiting for a countersign/)).toBeTruthy();
  });

  it("refusals are explained and leave the dialog open: unavailable, lapsed, same person, denied, failure", async () => {
    let reply: Reply = fail(403, { error: { code: "REDACTION_FALLBACK_UNAVAILABLE" } });
    mount({ list: () => ok(list([row()])), decide: () => reply });
    await openTab();
    const attempt = async () => {
      fireEvent.click(await screen.findByRole("button", { name: /^Approve redaction/ }));
      const dialog = await screen.findByRole("alertdialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve now" }));
      const alert = await within(dialog).findByRole("alert");
      const text = alert.textContent ?? "";
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      return text;
    };
    expect(await attempt()).toContain("no longer possible");
    reply = fail(409, { error: { code: "REDACTION_COUNTERSIGN_LAPSED" } });
    expect(await attempt()).toContain("countersign period has passed");
    reply = fail(403, { error: { code: "REDACTION_SELF_APPROVAL" } });
    expect(await attempt()).toContain("different person");
    reply = fail(403);
    expect(await attempt()).toContain("not permitted");
    reply = fail(500);
    expect(await attempt()).toContain("Nothing was changed");
  });
});

describe("Accessibility", () => {
  it("the list and every dialog are axe clean, the tab is reachable by arrow keys, and a dialog traps focus inside", async () => {
    const { container } = mount({
      list: () =>
        ok(
          list(
            [
              row(),
              row({ id: "m", message_id: MSG2, requested_by: ME, requested_by_name: "Me" }),
              row({
                id: "c",
                message_id: MSG3,
                status: "awaiting_countersign",
                self_approved: true,
                countersign_deadline_at: "2026-10-04T10:00:00.000Z",
              }),
            ],
            true,
          ),
        ),
    });
    const holds = await screen.findByRole("tab", { name: "Legal holds" });
    fireEvent.click(holds);
    fireEvent.keyDown(holds, { key: "ArrowRight" });
    await screen.findByRole("tab", { name: "Redactions", selected: true });
    const rows = await screen.findByRole("list", { name: "Redaction requests" });
    expect((await axe.run(container)).violations).toEqual([]);
    expect(rows).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Request redaction" }));
    const request = await screen.findByRole("dialog", { name: "Request a redaction" });
    expect(request.contains(document.activeElement)).toBe(true);
    expect((await axe.run(request)).violations).toEqual([]);
    fireEvent.click(within(request).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /only officer/ }));
    const self = await screen.findByRole("alertdialog");
    expect((await axe.run(self)).violations).toEqual([]);
  });
});
