// apps/web/src/modules/16-bereavement — ADR-0109 D6: the physician condolence letter review section embedded in the intake queue.
// Pending letters with an age badge; approve with an optional personal note (and an internal clinician picker when the care team
// resolved nobody); decline with a documented reason; a reader without the key sees nothing at all. Refused, raced and lost
// writes: the list reloads, the dialog cannot be dismissed mid-request, and a retry reuses the attempt's Idempotency-Key.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { BereavementIntakeQueue } from "./intake-queue";

const DAY = 86_400_000;
const ATTENDING = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLINICIAN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER_CLINICIAN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const letter = (over: Record<string, unknown> = {}) => ({
  letterId: "11111111-1111-4111-8111-111111111111",
  planId: "22222222-2222-4222-8222-222222222222",
  patientId: "33333333-3333-4333-8333-333333333333",
  status: "pending_review",
  dueAt: new Date(Date.now() + DAY).toISOString(),
  createdAt: new Date(Date.now() - DAY).toISOString(),
  attendingUserId: ATTENDING,
  hasPersonalNote: false,
  declineReason: null,
  reviewedAt: null,
  renderedDocumentId: null,
  version: 3,
  ...over,
});

interface Recorded {
  readonly path: string;
  readonly method: string;
  readonly ifMatch: string | null;
  readonly idempotencyKey: string | null;
  readonly body: unknown;
}

/** The permissions a letter reviewer holds: the letter key, and the member list the clinician picker reads. */
const REVIEWER = ["bereavement.letter.read", "member.manage"];

function mount(opts: {
  letters?: unknown[];
  listStatus?: number;
  /** The first list request fails like a dropped connection (the fetch rejects); later ones succeed. */
  listRejectsOnce?: boolean;
  /** The list is held until `release()` is called. */
  holdList?: boolean;
  hasMore?: boolean;
  members?: unknown[] | "forbidden";
  actionResponse?: { status: number; body: unknown };
  /** The first write fails like a dropped connection (the fetch rejects); later ones answer normally. */
  actionRejectsOnce?: boolean;
  /** The first write is held until `release()` is called. */
  holdAction?: boolean;
  permissions?: string[];
}): { calls: Recorded[]; gets: string[]; release: () => void } {
  const calls: Recorded[] = [];
  const gets: string[] = [];
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejected = false;
  let listRejected = false;
  let pending = [...(opts.letters ?? [])];
  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (method === "POST") {
      const body = req ? await req.clone().json() : undefined;
      calls.push({
        path,
        method,
        ifMatch: req?.headers.get("if-match") ?? null,
        idempotencyKey: req?.headers.get("idempotency-key") ?? null,
        body,
      });
      if (opts.actionRejectsOnce && !rejected) {
        rejected = true;
        throw new TypeError("network down");
      }
      if (opts.holdAction && calls.length === 1) await held;
      const r = opts.actionResponse ?? { status: 200, body: letter({ status: "approved" }) };
      // a decided letter (by us, or by someone else: 409/412/404) is no longer pending
      if (r.status === 200 || r.status === 409 || r.status === 412 || r.status === 404)
        pending = [];
      return json(r.status, r.body);
    }
    gets.push(path);
    if (path === "/api/v1/bereavement/physician-letters") {
      if (opts.listRejectsOnce && !listRejected) {
        listRejected = true;
        throw new TypeError("network down");
      }
      if (opts.holdList) await held;
      const status = opts.listStatus ?? 200;
      return status === 200
        ? json(200, { data: pending, next_cursor: null, has_more: opts.hasMore ?? false })
        : json(status, { error: { code: "FORBIDDEN", message: "forbidden" } });
    }
    if (path.endsWith("/members")) {
      return opts.members === "forbidden" || opts.members === undefined
        ? json(403, { error: { code: "FORBIDDEN", message: "forbidden" } })
        : json(200, { members: opts.members, pendingInvitations: 0 });
    }
    return json(200, { data: [], next_cursor: null, has_more: false });
  };
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider
        session={{
          userId: "reviewer-1",
          organizationId: "org-1",
          permissions: opts.permissions ?? REVIEWER,
        }}
      >
        <MemoryRouter>
          <BereavementIntakeQueue />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, gets, release };
}

const letterListCalls = (gets: string[]): number =>
  gets.filter((p) => p === "/api/v1/bereavement/physician-letters").length;

const member = (userId: string, displayName: string, status = "active") => ({
  membershipId: `m-${userId}`,
  userId,
  organizationId: "org-1",
  organizationName: "Org",
  status,
  isAdmin: false,
  defaultLocationIds: [],
  displayName,
  email: `${displayName.toLowerCase().replace(/\W+/g, ".")}@example.test`,
  username: null,
  credentialState: "active",
  lastLoginAt: null,
  accountStatus: "active",
});

beforeEach(() => {
  window.history.pushState({}, "", "/");
});

describe("ADR-0109 D6 — physician letter review in the intake queue", () => {
  it("lists the pending letters with an age badge and the resolved recipient", async () => {
    mount({
      letters: [
        letter(),
        letter({
          letterId: "44444444-4444-4444-8444-444444444444",
          planId: "55555555-5555-4555-8555-555555555555",
          createdAt: new Date(Date.now() - 4 * DAY).toISOString(),
          dueAt: new Date(Date.now() - 2 * DAY).toISOString(),
          attendingUserId: null,
        }),
      ],
    });
    expect(
      await screen.findByText(/Physician condolence letters awaiting review \(2\)/),
    ).toBeTruthy();
    expect(screen.getByText("1 day old")).toBeTruthy();
    expect(screen.getByText("4 days old · overdue")).toBeTruthy();
    expect(screen.getByText("None resolved")).toBeTruthy();
  });

  it("shows nothing at all to a reader without the review key (403)", async () => {
    mount({ listStatus: 403 });
    await screen.findByText("Bereavement intake");
    await waitFor(() => expect(screen.queryByText(/Physician condolence letters/)).toBeNull());
    expect(screen.queryByText(/No letters are waiting/)).toBeNull();
  });

  it("says plainly that nothing is waiting when the queue is empty", async () => {
    mount({ letters: [] });
    expect(await screen.findByText("No letters are waiting for review.")).toBeTruthy();
  });

  it("approves with a trimmed personal note: If-Match is the version read, no recipient is sent when the care team resolved one", async () => {
    const { calls } = mount({ letters: [letter()] });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Personal note (optional)"), {
      target: { value: "  Thank you for caring for this family.  " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: "/api/v1/bereavement/physician-letters/11111111-1111-4111-8111-111111111111/approve",
      ifMatch: "3",
      body: { personalNote: "Thank you for caring for this family." },
    });
    expect(calls[0]?.idempotencyKey).toBeTruthy();
    expect(calls[0]?.body).not.toHaveProperty("attendingUserId");
    // the approved letter leaves the queue
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("No letters are waiting for review.")).toBeTruthy();
  });

  it("asks for an internal clinician when none is resolved, from the agency's active members, and sends that user", async () => {
    const { calls } = mount({
      letters: [letter({ attendingUserId: null })],
      members: [
        member(OTHER_CLINICIAN, "Dr Ames"),
        member(CLINICIAN, "Dr Bell"),
        member("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "Dr Gone", "suspended"),
      ],
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/no attending clinician on record/i)).toBeTruthy();
    const approve = within(dialog).getByRole("button", { name: "Approve letter" });
    expect((approve as HTMLButtonElement).disabled).toBe(true);

    const picker = await within(dialog).findByLabelText("Internal clinician");
    const options = within(picker)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Choose a clinician…", "Dr Ames", "Dr Bell"]); // active members only, sorted
    fireEvent.change(picker, { target: { value: CLINICIAN } });
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ attendingUserId: CLINICIAN });
  });

  it("falls back to a user-id field when the reviewer may not list members", async () => {
    const { calls } = mount({ letters: [letter({ attendingUserId: null })], members: "forbidden" });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    const field = await within(dialog).findByLabelText("Internal clinician user id");
    fireEvent.change(field, { target: { value: `  ${CLINICIAN}  ` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.body).toEqual({ attendingUserId: CLINICIAN });
  });

  it("blocks a note over 1000 characters before it is sent", async () => {
    const { calls } = mount({ letters: [letter()] });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Personal note (optional)"), {
      target: { value: "x".repeat(1001) },
    });
    expect(within(dialog).getByText(/over 1000 characters/)).toBeTruthy();
    expect(
      (within(dialog).getByRole("button", { name: "Approve letter" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("shows the server's refusal and keeps the dialog open", async () => {
    mount({
      letters: [letter({ attendingUserId: null })],
      members: [member(CLINICIAN, "Dr Bell")],
      actionResponse: {
        status: 422,
        body: {
          error: {
            code: "PHYSICIAN_LETTER_ATTENDING_INVALID",
            message: "the chosen recipient is not an active member of this organization",
          },
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(await within(dialog).findByLabelText("Internal clinician"), {
      target: { value: CLINICIAN },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    expect(
      await within(dialog).findByText(/not an active member of this organization/),
    ).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("opens the picker when the recorded attending has left, then sends the chosen recipient", async () => {
    const { calls } = mount({
      letters: [letter()],
      members: [member(CLINICIAN, "Dr Bell")],
      actionResponse: {
        status: 422,
        body: {
          error: { code: "PHYSICIAN_LETTER_ATTENDING_INVALID", message: "not an active member" },
        },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText("Internal clinician")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await within(dialog).findByText(/no longer an active member\. Choose another/);
    fireEvent.change(await within(dialog).findByLabelText("Internal clinician"), {
      target: { value: CLINICIAN },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.body).toEqual({});
    expect(calls[1]?.body).toEqual({ attendingUserId: CLINICIAN });
  });

  it("declines only with a reason of 20 or more characters, and sends it trimmed", async () => {
    const { calls } = mount({
      letters: [letter()],
      actionResponse: { status: 200, body: letter({ status: "declined" }) },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Decline the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    const decline = within(dialog).getByRole("button", {
      name: "Decline letter",
    }) as HTMLButtonElement;
    const reason = within(dialog).getByLabelText("Reason");
    fireEvent.change(reason, { target: { value: "   too short   " } });
    expect(decline.disabled).toBe(true);
    fireEvent.change(reason, {
      target: { value: "  The attending left the practice in March.  " },
    });
    expect(decline.disabled).toBe(false);
    fireEvent.click(decline);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({
      path: "/api/v1/bereavement/physician-letters/11111111-1111-4111-8111-111111111111/decline",
      ifMatch: "3",
      body: { reason: "The attending left the practice in March." },
    });
  });
});

describe("physician letter review — who sees it, and how it fails", () => {
  it("is not mounted at all for a reader without bereavement.letter.read: no request, no section", async () => {
    const { gets } = mount({ letters: [letter()], permissions: ["member.manage"] });
    await screen.findByText("Bereavement intake");
    expect(screen.queryByText(/Physician condolence letters/)).toBeNull();
    expect(letterListCalls(gets)).toBe(0);
  });

  it("is not refetched when the status filter changes (the section stays mounted outside the plan list's loading)", async () => {
    const { gets } = mount({ letters: [letter()] });
    await screen.findByText(/Physician condolence letters awaiting review \(1\)/);
    fireEvent.change(screen.getByLabelText("Filter by intake status"), {
      target: { value: "active" },
    });
    await waitFor(() =>
      expect(gets.filter((p) => p === "/api/v1/bereavement/plans").length).toBeGreaterThan(1),
    );
    expect(screen.getByText(/Physician condolence letters awaiting review \(1\)/)).toBeTruthy();
    expect(letterListCalls(gets)).toBe(1);
  });

  it("shows a loading placeholder, not nothing, while the first list is on its way", async () => {
    const { release } = mount({ letters: [letter()], holdList: true });
    expect(await screen.findByLabelText("Loading physician letters")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Physician condolence letters" })).toBeTruthy();
    release();
    expect(await screen.findByText(/awaiting review \(1\)/)).toBeTruthy();
  });

  it("a rejected list request is an error card with Try again, not a spinner or silence", async () => {
    const { gets } = mount({ letters: [letter()], listRejectsOnce: true });
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/could not be loaded|connection dropped/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/awaiting review \(1\)/)).toBeTruthy();
    expect(letterListCalls(gets)).toBe(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says a capped list is capped: 100+ when the server has more", async () => {
    mount({ letters: [letter()], hasMore: true });
    expect(await screen.findByText(/awaiting review \(1\+\)/)).toBeTruthy();
  });

  it("skips the member list for a reviewer without member.manage and asks for the user id straight away", async () => {
    const { gets } = mount({
      letters: [letter({ attendingUserId: null })],
      members: [member(CLINICIAN, "Dr Bell")],
      permissions: ["bereavement.letter.read"],
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Internal clinician user id")).toBeTruthy();
    expect(within(dialog).queryByText(/Loading the agency's clinicians/)).toBeNull();
    expect(gets.some((p) => p.endsWith("/members"))).toBe(false);
  });

  it("after an approval the list reloads without unmounting, and focus lands on the status line", async () => {
    mount({ letters: [letter()] });
    const heading = await screen.findByRole("heading", {
      name: /Physician condolence letters awaiting review/,
    });
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    const status = await screen.findByText("The letter was approved and sent to be rendered.");
    await waitFor(() => expect(document.activeElement).toBe(status));
    expect(await screen.findByText("No letters are waiting for review.")).toBeTruthy();
    // the card was never torn down: the same heading element is still in the page
    expect(screen.getByRole("heading", { name: /awaiting review \(0\)/ })).toBe(heading);
  });
});

describe("physician letter review — stale, held and lost writes", () => {
  const openApprove = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /Approve the letter for plan/ }));
    return screen.findByRole("dialog");
  };

  it.each([
    [409, "PHYSICIAN_LETTER_NOT_PENDING"],
    [412, "STALE_VERSION"],
    [404, "PHYSICIAN_LETTER_NOT_FOUND"],
  ])(
    "a %i on approve says someone else decided it, closes the dialog and reloads the list",
    async (status, code) => {
      const { gets } = mount({
        letters: [letter()],
        actionResponse: { status, body: { error: { code, message: "refused" } } },
      });
      const dialog = await openApprove();
      fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
      expect(await screen.findByText(/Someone else already decided that letter/)).toBeTruthy();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(await screen.findByText("No letters are waiting for review.")).toBeTruthy();
      expect(letterListCalls(gets)).toBe(2);
    },
  );

  it("a 409 on decline says the same", async () => {
    mount({
      letters: [letter()],
      actionResponse: {
        status: 409,
        body: { error: { code: "PHYSICIAN_LETTER_NOT_PENDING", message: "not pending" } },
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /Decline the letter for plan/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "The attending left the practice in March." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Decline letter" }));
    expect(await screen.findByText(/Someone else already decided that letter/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("cannot be dismissed while the request is in flight: not by Cancel, Escape or the scrim", async () => {
    const { calls, release } = mount({ letters: [letter()], holdAction: true });
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const cancel = within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a scrim click does not throw away typed text, but still closes an untouched dialog", async () => {
    mount({ letters: [letter()] });
    const dialog = await openApprove();
    fireEvent.change(within(dialog).getByLabelText("Personal note (optional)"), {
      target: { value: "Thank you." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Personal note (optional)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Close", hidden: true }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("a lost response is not 'busy' forever: it says so and the retry reuses the same Idempotency-Key", async () => {
    const { calls } = mount({ letters: [letter()], actionRejectsOnce: true });
    const dialog = await openApprove();
    const approve = within(dialog).getByRole("button", { name: "Approve letter" });
    fireEvent.click(approve);
    expect(await within(dialog).findByText(/connection dropped/i)).toBeTruthy();
    expect((approve as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]?.idempotencyKey).toBeTruthy();
    expect(calls[1]?.idempotencyKey).toBe(calls[0]?.idempotencyKey);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("an edited request after a lost response is a new write with a new key", async () => {
    const { calls } = mount({ letters: [letter()], actionRejectsOnce: true });
    const dialog = await openApprove();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    expect(await within(dialog).findByText(/connection dropped/i)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Personal note (optional)"), {
      target: { value: "Added after the first try." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve letter" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
  });

  it("a refusal the server answered (422) is a definitive no: the next attempt is a new write", async () => {
    const { calls } = mount({
      letters: [letter()],
      actionResponse: {
        status: 422,
        body: { error: { code: "PHYSICIAN_LETTER_NOTE_TOO_LONG", message: "note too long" } },
      },
    });
    const dialog = await openApprove();
    const approve = within(dialog).getByRole("button", { name: "Approve letter" });
    fireEvent.click(approve);
    expect(await within(dialog).findByText("note too long")).toBeTruthy();
    fireEvent.click(approve);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.idempotencyKey).not.toBe(calls[0]?.idempotencyKey);
  });
});
