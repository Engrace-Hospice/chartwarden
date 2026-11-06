import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: one support group (routes 55-66).
// Open / close / cancel-session carry the version READ in If-Match plus an Idempotency-Key; attendance carries the picked contacts under an
// Idempotency-Key and only for a started session; the roster (it names families) is never requested without `bereavement.group.run`, and
// the volunteer projection says what it withholds. A 403 renders nothing; other failures are announced with a retry; a 412 reloads.
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SupportGroupDetail } from "./group-detail";

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION_PAST = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SESSION_FUTURE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GROUP_PATH = `/api/v1/bereavement/groups/${GROUP_ID}`;
const ALL_KEYS = ["bereavement.group.read", "bereavement.group.manage", "bereavement.group.run"];

const group = (over: Record<string, unknown> = {}) => ({
  groupId: GROUP_ID,
  name: "Thursday morning circle",
  description: "A gentle space to share.",
  format: "recurring",
  modality: "in_person",
  enrollmentRequired: true,
  facilitatorKind: "staff",
  facilitatorUserId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  coFacilitatorUserId: null,
  capacity: 10,
  status: "open",
  recurrence: {
    firstDate: "2026-10-01",
    startTime: "10:00",
    durationMinutes: 60,
    intervalWeeks: 2,
    count: 6,
  },
  timezone: "America/Chicago",
  venueText: "Garden room",
  hasJoinUrl: false,
  enrolledCount: 2,
  nextSessionAt: "2099-01-01T16:00:00.000Z",
  openedAt: "2026-09-20T00:00:00.000Z",
  closedAt: null,
  version: 5,
  createdAt: "2026-09-01T00:00:00.000Z",
  joinUrl: null,
  ...over,
});
const sessions = () => [
  {
    sessionId: SESSION_PAST,
    groupId: GROUP_ID,
    sessionNo: 1,
    startsAt: "2026-10-01T15:00:00.000Z",
    endsAt: "2026-10-01T16:00:00.000Z",
    status: "scheduled",
    attendeeCount: 0,
    version: 1,
  },
  {
    sessionId: SESSION_FUTURE,
    groupId: GROUP_ID,
    sessionNo: 2,
    startsAt: "2099-01-01T16:00:00.000Z",
    endsAt: "2099-01-01T17:00:00.000Z",
    status: "scheduled",
    attendeeCount: 0,
    version: 3,
  },
];
const staffRoster = {
  groupId: GROUP_ID,
  projection: "staff",
  entries: [
    {
      contactId: CONTACT_A,
      displayName: "Marlo Quinby",
      enrollmentStatus: "enrolled",
      attendedSessions: 0,
      relationshipCode: "spouse",
      planId: PLAN_ID,
    },
    {
      contactId: CONTACT_B,
      displayName: "Tessaly Vorn",
      enrollmentStatus: "enrolled",
      attendedSessions: 1,
      relationshipCode: "child",
      planId: PLAN_ID,
    },
  ],
};
const volunteerRoster = {
  groupId: GROUP_ID,
  projection: "volunteer",
  entries: [
    {
      contactId: CONTACT_A,
      displayName: "Marlo Quinby",
      enrollmentStatus: "enrolled",
      attendedSessions: 0,
    },
  ],
};

interface Req {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly ifMatch: string | null;
  readonly idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown };
type Handler = (req: Req) => Reply | undefined;
const ok = (body: unknown): Reply => ({ status: 200, body });
const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});

/** The default server: the group, its sessions, the staff roster; `write` answers POST/PATCH, `over` may answer anything first. */
function mount(opts: { over?: Handler; write?: Handler; permissions?: string[] } = {}) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input));
    const url = new URL(req.url, "http://localhost");
    const text = req.method === "GET" ? "" : await req.clone().text();
    const recorded: Req = {
      method: req.method,
      path: url.pathname,
      body: text ? JSON.parse(text) : null,
      ifMatch: req.headers.get("if-match"),
      idempotencyKey: req.headers.get("idempotency-key"),
    };
    calls.push(recorded);
    const reply =
      opts.over?.(recorded) ??
      (recorded.method !== "GET"
        ? (opts.write?.(recorded) ?? refused(500, "UNEXPECTED"))
        : recorded.path === GROUP_PATH
          ? ok(group())
          : recorded.path.endsWith("/sessions")
            ? ok(sessions())
            : recorded.path.endsWith("/roster")
              ? ok(staffRoster)
              : refused(404, "NOT_FOUND"));
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider
        session={{
          userId: "u-1",
          organizationId: "org-1",
          permissions: opts.permissions ?? ALL_KEYS,
        }}
      >
        <MemoryRouter initialEntries={[`/bereavement/groups/${GROUP_ID}`]}>
          <Routes>
            <Route path="/bereavement/groups/:groupId" element={<SupportGroupDetail />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

describe("support group — what it shows", () => {
  it("shows the details, the sessions and the roster with links to each family", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Thursday morning circle" })).toBeTruthy();
    expect(screen.getByText("A gentle space to share.")).toBeTruthy();
    expect(await screen.findByRole("table", { name: "Group sessions" })).toBeTruthy();
    const roster = await screen.findByRole("table", { name: "Group roster" });
    expect(within(roster).getByRole("link", { name: "Marlo Quinby" }).getAttribute("href")).toBe(
      `/bereavement/plans/${PLAN_ID}/contacts/${CONTACT_A}`,
    );
    expect(within(roster).getByText("Spouse")).toBeTruthy();
  });

  it("says when no session is scheduled and no family is enrolled", async () => {
    mount({
      over: (r) =>
        r.path.endsWith("/sessions")
          ? ok([])
          : r.path.endsWith("/roster")
            ? ok({ ...staffRoster, entries: [] })
            : undefined,
    });
    expect(await screen.findByText("No session is scheduled.")).toBeTruthy();
    expect(await screen.findByText("No family is enrolled in this group yet.")).toBeTruthy();
  });

  it("the volunteer projection names no relationship and links no plan", async () => {
    mount({ over: (r) => (r.path.endsWith("/roster") ? ok(volunteerRoster) : undefined) });
    const roster = await screen.findByRole("table", { name: "Group roster" });
    expect(within(roster).getByText("Not shown to you")).toBeTruthy();
    expect(within(roster).queryByRole("link")).toBeNull();
  });
});

describe("support group — who sees what", () => {
  it("a 403 on the group renders nothing", async () => {
    const { container } = mount({
      over: (r) => (r.path === GROUP_PATH ? refused(403, "FORBIDDEN") : undefined),
    });
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a read-only reader sees no group actions, no Add session, no roster and no attendance; the roster is never requested", async () => {
    const { calls } = mount({ permissions: ["bereavement.group.read"] });
    await screen.findByRole("table", { name: "Group sessions" });
    expect(screen.queryByRole("button", { name: "Edit group" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mark completed" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add session" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Cancel session/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Record attendance/ })).toBeNull();
    expect(screen.queryByRole("table", { name: "Group roster" })).toBeNull();
    expect(calls.some((c) => c.path.endsWith("/roster"))).toBe(false);
  });

  it("offers Record attendance only for a session that has started", async () => {
    mount();
    expect(
      await screen.findByRole("button", { name: "Record attendance for session 1" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Record attendance for session 2" })).toBeNull();
  });

  it("a server error on the group is announced with Try again, and the retry loads it", async () => {
    let reads = 0;
    mount({
      over: (r) => {
        if (r.path !== GROUP_PATH) return undefined;
        reads += 1;
        return reads === 1 ? refused(500, "INTERNAL", "boom") : undefined;
      },
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Thursday morning circle" })).toBeTruthy();
  });
});

describe("support group — writes", () => {
  it("opens a draft with If-Match = the version read and an Idempotency-Key", async () => {
    const { calls } = mount({
      over: (r) =>
        r.method === "GET" && r.path === GROUP_PATH ? ok(group({ status: "draft" })) : undefined,
      write: (r) =>
        r.path.endsWith("/open") ? ok(group({ status: "open", version: 6 })) : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Open to families" }));
    expect(await screen.findByText("The group is open to families.")).toBeTruthy();
    const post = calls.find((c) => c.path.endsWith("/open"));
    expect(post?.ifMatch).toBe("5");
    expect(post?.idempotencyKey).toBeTruthy();
  });

  it("marks the group completed through an alertdialog with If-Match", async () => {
    const { calls } = mount({
      write: (r) =>
        r.path.endsWith("/close") ? ok(group({ status: "completed", version: 6 })) : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Mark completed" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Mark completed" }));
    expect(await screen.findByText("The group was marked completed.")).toBeTruthy();
    const post = calls.find((c) => c.path.endsWith("/close"));
    expect(post?.body).toEqual({ status: "completed" });
    expect(post?.ifMatch).toBe("5");
    expect(post?.idempotencyKey).toBeTruthy();
  });

  it("a 412 on close closes the dialog, reloads the group and says why", async () => {
    let groupReads = 0;
    mount({
      over: (r) => {
        if (r.method === "GET" && r.path === GROUP_PATH) groupReads += 1;
        return undefined;
      },
      write: () => refused(412, "PRECONDITION_FAILED"),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel group" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Yes, cancel this group",
      }),
    );
    expect(await screen.findByText(/This group changed while you were working on it/)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(groupReads).toBe(2));
  });

  it("cancels a scheduled session with If-Match = that session's version", async () => {
    const { calls } = mount({
      write: (r) =>
        r.path.endsWith("/cancel")
          ? ok({ ...sessions()[1], status: "cancelled", version: 4 })
          : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel session 2" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Yes, cancel this session",
      }),
    );
    expect(await screen.findByText("Session 2 was cancelled.")).toBeTruthy();
    const post = calls.find((c) => c.path.endsWith(`/sessions/${SESSION_FUTURE}/cancel`));
    expect(post?.ifMatch).toBe("3");
    expect(post?.idempotencyKey).toBeTruthy();
  });

  it("records attendance for the picked families under an Idempotency-Key", async () => {
    const { calls } = mount({
      write: (r) =>
        r.path.endsWith("/attendance")
          ? ok({
              sessionId: SESSION_PAST,
              recordedCount: 1,
              alreadyRecordedCount: 0,
              attendeeCount: 1,
            })
          : undefined,
    });
    await screen.findByRole("table", { name: "Group roster" });
    fireEvent.click(await screen.findByRole("button", { name: "Record attendance for session 1" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByLabelText("Tessaly Vorn"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record attendance" }));
    expect(await screen.findByText("Attendance recorded for 1.")).toBeTruthy();
    const post = calls.find((c) => c.path.endsWith(`/sessions/${SESSION_PAST}/attendance`));
    expect(post?.body).toEqual({ contactIds: [CONTACT_B] });
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.ifMatch).toBeNull();
  });

  it("adds a session with an Idempotency-Key", async () => {
    const { calls } = mount({
      write: (r) =>
        r.path.endsWith("/sessions")
          ? ok({ ...sessions()[1], sessionId: crypto.randomUUID(), sessionNo: 3 })
          : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add session" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Starts"), {
      target: { value: "2099-02-01T10:00" },
    });
    fireEvent.change(within(dialog).getByLabelText("Ends"), {
      target: { value: "2099-02-01T11:00" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add session" }));
    expect(await screen.findByText("The session was added.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path.endsWith("/sessions"));
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({ startsAt: expect.any(String), endsAt: expect.any(String) });
  });

  it("edits the group with PATCH and If-Match", async () => {
    const { calls } = mount({
      write: (r) =>
        r.method === "PATCH" ? ok(group({ name: "Renamed circle", version: 6 })) : undefined,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit group" }));
    const dialog = await screen.findByRole("dialog");
    // an open group's schedule is fixed: no recurrence fields
    expect(within(dialog).queryByLabelText("First date")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Renamed circle" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Renamed circle" })).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.ifMatch).toBe("5");
    expect(patch?.idempotencyKey).toBeTruthy();
    expect(patch?.body).not.toHaveProperty("recurrence");
    expect(patch?.body).not.toHaveProperty("format");
  });
});

describe("support group — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount();
    await screen.findByRole("table", { name: "Group roster" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
    ).toEqual([]);
  });
});
