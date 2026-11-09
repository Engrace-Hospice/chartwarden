import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the support groups list (routes 53-54).
// Rows that link to the group, a status filter, an empty state, a 403 that renders nothing, an announced failure with a retry, and the
// "New group" form, offered only with `bereavement.group.manage`, that creates a draft under an Idempotency-Key and opens it.
import axe from "axe-core";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { SupportGroups } from "./group-list";

const GROUPS_PATH = "/api/v1/bereavement/groups";
const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FACILITATOR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const group = (over: Record<string, unknown> = {}) => ({
  groupId: GROUP_A,
  name: "Tuesday evening circle",
  description: null,
  format: "recurring",
  modality: "in_person",
  enrollmentRequired: true,
  facilitatorKind: "staff",
  facilitatorUserId: FACILITATOR,
  coFacilitatorUserId: null,
  capacity: 12,
  status: "open",
  recurrence: {
    firstDate: "2026-11-10",
    startTime: "18:00",
    durationMinutes: 90,
    intervalWeeks: 1,
    count: 8,
  },
  timezone: "America/Chicago",
  venueText: "Community room",
  hasJoinUrl: false,
  enrolledCount: 4,
  nextSessionAt: "2026-11-10T00:00:00.000Z",
  openedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  version: 2,
  createdAt: "2026-10-30T00:00:00.000Z",
  ...over,
});

interface Req {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown } | "reject";

function mount(answer: (req: Req) => Reply, permissions = ["bereavement.group.read"]) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(String(input));
    const url = new URL(req.url, "http://localhost");
    const text = req.method === "GET" ? "" : await req.clone().text();
    const recorded: Req = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : null,
      idempotencyKey: req.headers.get("idempotency-key"),
    };
    calls.push(recorded);
    const reply = answer(recorded);
    if (reply === "reject") throw new TypeError("network down");
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter initialEntries={["/bereavement/groups"]}>
          <Routes>
            <Route path="/bereavement/groups" element={<SupportGroups />} />
            <Route path="/bereavement/groups/:groupId" element={<p>Group page</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

const page = (data: unknown[], next: string | null = null): Reply => ({
  status: 200,
  body: { data, next_cursor: next, has_more: next !== null },
});
const refused = (status: number, code: string, message = "refused"): Reply => ({
  status,
  body: { error: { code, message } },
});
const MANAGE = ["bereavement.group.read", "bereavement.group.manage"];

describe("support groups — what it shows", () => {
  it("lists each group with its status, enrollment and a link to it", async () => {
    mount(() => page([group()]));
    const link = await screen.findByRole("link", { name: "Tuesday evening circle" });
    expect(link.getAttribute("href")).toBe(`/bereavement/groups/${GROUP_A}`);
    const row = within(screen.getByRole("table", { name: "Support groups" })).getAllByRole(
      "row",
    )[1];
    expect(within(row as HTMLElement).getByText("Open")).toBeTruthy();
    expect(within(row as HTMLElement).getByText("4 / 12")).toBeTruthy();
  });

  it("says plainly that there are no groups", async () => {
    mount(() => page([]));
    expect(await screen.findByText("No support groups")).toBeTruthy();
  });

  it("filters by status", async () => {
    const { calls } = mount(() => page([group()]));
    await screen.findByRole("table", { name: "Support groups" });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "draft" } });
    await waitFor(() => expect(calls.at(-1)?.query.get("status")).toBe("draft"));
  });

  it("does not offer New group without bereavement.group.manage", async () => {
    mount(() => page([group()]));
    await screen.findByRole("table", { name: "Support groups" });
    expect(screen.queryByRole("button", { name: "New group" })).toBeNull();
  });
});

describe("support groups — who sees it, and how it fails", () => {
  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => refused(403, "FORBIDDEN"));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a server error is announced with Try again, and the retry loads the groups", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1 ? refused(500, "INTERNAL", "boom") : page([group()]);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Tuesday evening circle" })).toBeTruthy();
  });
});

describe("support groups — create a draft", () => {
  it("creates a recurring draft with an Idempotency-Key and opens it", async () => {
    const { calls } = mount(
      (req) =>
        req.method === "POST"
          ? { status: 200, body: { ...group(), status: "draft", joinUrl: null } }
          : page([]),
      MANAGE,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Spring circle" } });
    fireEvent.change(within(dialog).getByLabelText("Facilitator membership id"), {
      target: { value: FACILITATOR },
    });
    fireEvent.change(within(dialog).getByLabelText("First date"), {
      target: { value: "2027-03-02" },
    });
    fireEvent.change(within(dialog).getByLabelText("Time zone"), {
      target: { value: "America/Chicago" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create draft group" }));
    expect(await screen.findByText("Group page")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST" && c.path === GROUPS_PATH);
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({
      name: "Spring circle",
      format: "recurring",
      facilitatorUserId: FACILITATOR,
      timezone: "America/Chicago",
      joinUrl: null,
      recurrence: {
        firstDate: "2027-03-02",
        startTime: "18:00",
        durationMinutes: 90,
        intervalWeeks: 1,
        count: 8,
      },
    });
  });

  it("refuses a join link that is not https before sending anything", async () => {
    const { calls } = mount(() => page([]), MANAGE);
    fireEvent.click(await screen.findByRole("button", { name: "New group" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Format"), { target: { value: "drop_in" } });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Drop-in" } });
    fireEvent.change(within(dialog).getByLabelText("Facilitator membership id"), {
      target: { value: FACILITATOR },
    });
    fireEvent.change(within(dialog).getByLabelText("Join link (https, optional)"), {
      target: { value: "http://example.test/room" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create draft group" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("https://");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("support groups — accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = mount(() => page([group()]), MANAGE);
    await screen.findByRole("table", { name: "Support groups" });
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" ")}`),
    ).toEqual([]);
  });
});
