// apps/web/src/modules/16-bereavement — ADR-0109 D6: the physician condolence letter review section embedded in the intake queue.
// Pending letters with an age badge; approve with an optional personal note (and an internal clinician picker when the care team
// resolved nobody); decline with a documented reason; a reader without the key sees nothing at all.
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

function mount(opts: {
  letters?: unknown[];
  listStatus?: number;
  members?: unknown[] | "forbidden";
  actionResponse?: { status: number; body: unknown };
}): { calls: Recorded[] } {
  const calls: Recorded[] = [];
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
      const r = opts.actionResponse ?? { status: 200, body: letter({ status: "approved" }) };
      if (r.status === 200) pending = [];
      return json(r.status, r.body);
    }
    if (path === "/api/v1/bereavement/physician-letters") {
      const status = opts.listStatus ?? 200;
      return status === 200
        ? json(200, { data: pending, next_cursor: null, has_more: false })
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
      <SessionProvider session={{ userId: "reviewer-1", organizationId: "org-1" }}>
        <MemoryRouter>
          <BereavementIntakeQueue />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls };
}

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
