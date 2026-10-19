// M36 ADR-0078 (G-2, G-7) - the supervisor queue: "Sent by" in words on every row (a restricted one too), and the supervisor reassign
// dialog: opened from a row (a restricted row acts on request_ref alone), a REQUIRED reason and a colleague, a fresh Idempotency-Key,
// generic words for every refusal, the list re-read after a save, focus never lost to the page, and a background refresh that never
// disturbs the open dialog.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AckQueueItemDto, AckQueueResponse } from "@wardenx/types";
import { type ApiClient, ApiClientProvider } from "@wardenx/ui";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REASSIGN_CANNOT_TAKE_TEXT,
  REASSIGN_CHANGED_TEXT,
  REASSIGN_EMPTY_TEXT,
  REASSIGN_INDETERMINATE_TEXT,
  REASSIGN_NOT_PERMITTED_TEXT,
  REASSIGN_REASON_TEXT,
  REASSIGN_SAVED_SUPERVISOR_TEXT,
  REASSIGN_TOO_MANY_TEXT,
} from "./ack-reassign-wording";
import { UnacknowledgedQueue } from "./unacknowledged-queue";
import { QUEUE_SENDER_UNKNOWN } from "./unacknowledged-wording";

const QUEUE = "/api/v1/messaging/escalations/unacknowledged";
const CANDIDATES = "/api/v1/messaging/escalations/{id}/supervisor-reassign-candidates";
const REASSIGN = "/api/v1/messaging/escalations/{id}/supervisor-reassign";
const REF_VISIBLE = "cccccccc-cccc-4ccc-8ccc-000000000001";
const REF_RESTRICTED = "cccccccc-cccc-4ccc-8ccc-000000000002";
const PERSON_ID = "11111111-1111-4111-8111-000000000003";
const CHANNEL = "aaaaaaaa-aaaa-4aaa-8aaa-000000000001";
const PATIENT = "99999999-9999-4999-8999-000000000001";

const item = (over: Partial<AckQueueItemDto> = {}): AckQueueItemDto => ({
  restricted: false,
  id: REF_VISIBLE,
  channel_id: CHANNEL,
  message_id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000001",
  patient_id: PATIENT,
  ack_class: "urgent",
  status: "pending",
  assigned_user_id: "dddddddd-dddd-4ddd-8ddd-000000000001",
  assigned_display_name: "Nina Nurse",
  requested_at: "2026-10-18T11:30:00.000Z",
  deadline_at: "2099-01-01T00:00:00.000Z",
  overdue: false,
  overdue_seconds: 0,
  current_tier: 0,
  escalation_note: null,
  delivery_failed: false,
  requester_display_name: "Sam Sender",
  request_ref: REF_VISIBLE,
  ...over,
});
const RESTRICTED = item({
  restricted: true,
  id: null,
  channel_id: null,
  message_id: null,
  patient_id: null,
  assigned_user_id: null,
  assigned_display_name: "Rae Responder",
  requester_display_name: null,
  request_ref: REF_RESTRICTED,
});

const page = (items: AckQueueItemDto[]): { data: AckQueueResponse } => ({
  data: {
    items,
    next_cursor: null,
    audit_request_id: null,
    complete: true,
    filtered: false,
    counts: { unfiltered: items.length, matching: items.length, overdue: 0, failed_unreachable: 0 },
  },
});
const candidatesOk = (list = [{ user_id: PERSON_ID, display_name: "Pat Nurse" }]) => ({
  data: { candidates: list },
  response: { status: 200 },
});

function mount(
  opts: {
    items?: () => AckQueueItemDto[];
    candidates?: () => unknown;
    post?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const GET = vi.fn((path: string, _init?: unknown) =>
    Promise.resolve(
      path === CANDIDATES
        ? (opts.candidates ?? candidatesOk)()
        : page((opts.items ?? (() => [item(), RESTRICTED]))()),
    ),
  );
  const POST = opts.post ?? vi.fn().mockResolvedValue({ data: {}, response: { status: 200 } });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST } as unknown as ApiClient}>
        <main>
          <UnacknowledgedQueue />
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return { GET, POST };
}

const calls = (fn: ReturnType<typeof vi.fn>, path: string) =>
  fn.mock.calls.filter((c) => c[0] === path);
const rowButton = async (name: RegExp) =>
  (await screen.findAllByRole("button", { name }))[0] as HTMLElement;
const restrictedRowButton = () =>
  screen.findByRole("button", { name: "Reassign, assigned to Rae Responder" });
const confirm = () =>
  within(screen.getByRole("dialog")).getByRole("button", { name: /^Reassign request|^Saving/ });

async function fillDialog(reason = REASSIGN_REASON_TEXT.assignee_off_shift) {
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(await within(dialog).findByRole("radio", { name: reason }));
  fireEvent.click(await within(dialog).findByRole("radio", { name: "Pat Nurse" }));
  return dialog;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("queue rows - sender (G-7)", () => {
  it("states who sent each request in words, on a restricted row too, and when it is unknown", async () => {
    mount();
    const rows = await screen.findAllByRole("listitem");
    expect(within(rows[0] as HTMLElement).getByText("Sent by Sam Sender.")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(QUEUE_SENDER_UNKNOWN)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Assigned to Rae Responder.")).toBeTruthy();
  });

  it("shows the sender of a restricted row when the server names one", async () => {
    mount({ items: () => [{ ...RESTRICTED, requester_display_name: "Sam Sender" }] });
    expect(await screen.findByText("Sent by Sam Sender.")).toBeTruthy();
  });
});

describe("supervisor reassign (G-2)", () => {
  it("offers Reassign on every row; opening reads only the candidates for the request_ref", async () => {
    const { GET, POST } = mount();
    expect(await screen.findAllByRole("button", { name: /^Reassign, assigned to/ })).toHaveLength(
      2,
    );
    fireEvent.click(await restrictedRowButton());

    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("radio", { name: "Pat Nurse" });
    const read = GET.mock.calls.find((c) => c[0] === CANDIDATES);
    expect(read?.[1]).toEqual({ params: { path: { id: REF_RESTRICTED } } });
    expect(POST).not.toHaveBeenCalled();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByText(/does not acknowledge anything/)).toBeTruthy();
    expect(within(dialog).getByText(/does not open the conversation/)).toBeTruthy();
    expect(within(dialog).getByText(/must then sign in and take responsibility/)).toBeTruthy();
    // none of the six reasons is preselected
    for (const label of Object.values(REASSIGN_REASON_TEXT)) {
      expect((within(dialog).getByRole("radio", { name: label }) as HTMLInputElement).checked).toBe(
        false,
      );
    }
    expect(document.body.textContent).not.toContain(PERSON_ID);
    expect(await axe.run(document.body)).toHaveProperty("violations", []);
  });

  it("keeps Confirm inert, with its explanation, until a reason AND a colleague are chosen", async () => {
    const { POST } = mount();
    fireEvent.click(await restrictedRowButton());
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("radio", { name: "Pat Nurse" });

    expect(confirm().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(dialog).getByRole("radio", { name: "Pat Nurse" }));
    expect(confirm().getAttribute("aria-disabled")).toBe("true");
    expect(within(dialog).getByText("Choose a reason to continue.")).toBeTruthy();
    fireEvent.click(confirm());
    expect(POST).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("radio", { name: REASSIGN_REASON_TEXT.workload }));
    expect(confirm().getAttribute("aria-disabled")).toBeNull();
  });

  it("says nobody can take it when there are no colleagues", async () => {
    mount({ candidates: () => candidatesOk([]) });
    fireEvent.click(await restrictedRowButton());
    expect(await screen.findByText(REASSIGN_EMPTY_TEXT)).toBeTruthy();
  });

  it("posts the reason and colleague with an Idempotency-Key, announces, re-reads the list and keeps focus on the row button", async () => {
    const { GET, POST } = mount();
    const trigger = await restrictedRowButton();
    fireEvent.click(trigger);
    await fillDialog(REASSIGN_REASON_TEXT.coverage_change);
    const before = calls(GET, QUEUE).length;
    fireEvent.click(confirm());

    await waitFor(() => expect(POST).toHaveBeenCalledTimes(1));
    const [path, init] = POST.mock.calls[0] as [string, Record<string, any>];
    expect(path).toBe(REASSIGN);
    expect(init.params.path.id).toBe(REF_RESTRICTED);
    expect(init.body).toEqual({ assigned_user_id: PERSON_ID, reason_code: "coverage_change" });
    expect(init.params.header["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);

    expect(await screen.findByText(REASSIGN_SAVED_SUPERVISOR_TEXT)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(calls(GET, QUEUE).length).toBeGreaterThan(before));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("hands focus to the list when the reassigned row leaves it", async () => {
    let rows = [item(), RESTRICTED];
    const { GET } = mount({ items: () => rows });
    const trigger = await restrictedRowButton();
    fireEvent.click(trigger);
    await fillDialog();
    rows = [item()];
    fireEvent.click(confirm());

    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
    await waitFor(() => {
      expect(document.activeElement).not.toBe(document.body);
      expect(document.activeElement?.getAttribute("aria-label")).toBeTruthy();
    });
    expect(calls(GET, QUEUE).length).toBeGreaterThan(1);
  });

  it.each([
    [403, REASSIGN_NOT_PERMITTED_TEXT, true],
    [404, REASSIGN_CHANGED_TEXT, false],
    [409, REASSIGN_CHANGED_TEXT, false],
    [422, REASSIGN_CANNOT_TAKE_TEXT, true],
    [429, REASSIGN_TOO_MANY_TEXT, true],
    [500, REASSIGN_INDETERMINATE_TEXT, false],
  ])("answers %s with generic words (dialog stays open: %s)", async (status, text, stays) => {
    const post = vi
      .fn()
      .mockResolvedValue({ error: { error: { code: "X" } }, response: { status } });
    const { GET } = mount({ post });
    const before = 1;
    fireEvent.click(await restrictedRowButton());
    await fillDialog();
    fireEvent.click(confirm());

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByRole("dialog") !== null).toBe(stays);
    expect(document.body.textContent).not.toMatch(
      /ineligible|not on the care team|restricted from/i,
    );
    if (!stays) await waitFor(() => expect(calls(GET, QUEUE).length).toBeGreaterThan(before));
  });

  it("returns focus to the triggering button on Cancel and on Escape, sending nothing", async () => {
    const { POST } = mount();
    const trigger = await restrictedRowButton();
    fireEvent.click(trigger);
    let dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(POST).not.toHaveBeenCalled();
  });

  it("does not disturb the open dialog or steal focus when the list refreshes in the background", async () => {
    const { GET } = mount();
    fireEvent.click(await restrictedRowButton());
    const dialog = await fillDialog();
    const radio = within(dialog).getByRole("radio", { name: "Pat Nurse" });
    radio.focus();
    const before = calls(GET, QUEUE).length;

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(calls(GET, QUEUE).length).toBeGreaterThan(before));

    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(document.activeElement).toBe(radio);
    expect((radio as HTMLInputElement).checked).toBe(true);
  });

  it("shows no channel, message, patient or request id anywhere for a restricted row", async () => {
    mount({ items: () => [RESTRICTED] });
    fireEvent.click(await restrictedRowButton());
    await fillDialog();
    for (const hidden of [CHANNEL, PATIENT, REF_RESTRICTED, PERSON_ID]) {
      expect(document.body.innerHTML).not.toContain(hidden);
    }
  });
});
