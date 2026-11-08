import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10 PR 3: the contact detail's support-groups panel (routes 53, 63, 64, 66).
// Without `bereavement.group.enroll` nothing is requested or shown; a 403 renders nothing; enroll picks an open group and withdraw records why,
// each write carrying an Idempotency-Key.
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ContactSupportGroupsCard } from "./contact-support-groups-card";

const CONTACT = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const GROUP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GROUP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const enrollment = (over: Record<string, unknown> = {}) => ({
  enrollmentId: "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1",
  groupId: GROUP_A,
  groupName: "Tuesday Evening Circle",
  groupStatus: "open",
  contactId: CONTACT,
  status: "enrolled",
  withdrawnReason: null,
  enrolledAt: "2026-10-01T10:00:00.000Z",
  withdrawnAt: null,
  ...over,
});
const group = (over: Record<string, unknown> = {}) => ({
  groupId: GROUP_B,
  name: "Saturday Morning Walk",
  description: null,
  format: "drop_in",
  modality: "in_person",
  enrollmentRequired: true,
  facilitatorKind: "staff",
  facilitatorUserId: "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1",
  coFacilitatorUserId: null,
  capacity: 12,
  status: "open",
  recurrence: null,
  timezone: "America/Chicago",
  venueText: "Community room",
  hasJoinUrl: false,
  enrolledCount: 3,
  nextSessionAt: null,
  openedAt: "2026-09-01T00:00:00.000Z",
  closedAt: null,
  version: 2,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

type Reply = { status: number; body?: unknown };
type Sent = { method: string; path: string; headers: Headers; body: unknown };

function mount(
  answer: (method: string, path: string) => Reply,
  permissions = ["bereavement.group.enroll", "bereavement.group.read"],
) {
  const sent: Sent[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const path = new URL(req.url).pathname;
    const text = req.method === "GET" ? "" : await req.clone().text();
    sent.push({
      method: req.method,
      path,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    const reply = answer(req.method, path);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter>
          <ContactSupportGroupsCard contactId={CONTACT} />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { sent, ...view };
}

const ENROLLMENTS = `/api/v1/bereavement/contacts/${CONTACT}/support-groups`;

describe("contact support-groups panel", () => {
  it("lists the family's enrollments with a link to each group", async () => {
    mount(() => ({ status: 200, body: [enrollment()] }));
    const link = await screen.findByRole("link", { name: "Tuesday Evening Circle" });
    expect(link.getAttribute("href")).toBe(`/bereavement/groups/${GROUP_A}`);
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeTruthy();
  });

  it("says plainly that the family is in no group", async () => {
    mount(() => ({ status: 200, body: [] }));
    expect(await screen.findByText("This family is not in any support group.")).toBeTruthy();
  });

  it("a server error is said with Try again", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : { status: 200, body: [enrollment()] };
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Tuesday Evening Circle" })).toBeTruthy();
  });

  it("a 403 renders nothing", async () => {
    const { container } = mount(() => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("without the enroll permission nothing is requested or shown", async () => {
    const { container, sent } = mount(
      () => ({ status: 200, body: [] }),
      ["bereavement.group.read"],
    );
    expect(container.firstChild).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("enrolls into an open group the family is not already in, with an Idempotency-Key", async () => {
    const { sent } = mount((method, path) => {
      if (path === ENROLLMENTS) return { status: 200, body: [enrollment()] };
      if (path === "/api/v1/bereavement/groups")
        return {
          status: 200,
          body: {
            data: [group({ groupId: GROUP_A, name: "Tuesday Evening Circle" }), group()],
            next_cursor: null,
            has_more: false,
          },
        };
      if (method === "POST")
        return {
          status: 200,
          body: enrollment({ groupId: GROUP_B, groupName: "Saturday Morning Walk" }),
        };
      return { status: 404 };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Enroll in a group" }));
    const dialog = await screen.findByRole("dialog");
    const select = (await within(dialog).findByRole("combobox", {
      name: "Group",
    })) as HTMLSelectElement;
    // the group the family is already in is not offered again
    expect([...select.options].map((o) => o.textContent)).toEqual(["Saturday Morning Walk"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Enroll" }));
    await screen.findByText("Enrolled in Saturday Morning Walk.");
    const post = sent.find((s) => s.method === "POST");
    expect(post?.path).toBe(`/api/v1/bereavement/groups/${GROUP_B}/enrollments`);
    expect(post?.body).toEqual({ contactId: CONTACT });
    expect(post?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(post?.headers.get("If-Match")).toBeNull();
  });

  it("withdraws with the chosen reason", async () => {
    const { sent } = mount((method) =>
      method === "POST"
        ? {
            status: 200,
            body: enrollment({ status: "withdrawn", withdrawnReason: "staff_removed" }),
          }
        : { status: 200, body: [enrollment()] },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toContain("no longer on its roster");
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Reason" }), {
      target: { value: "staff_removed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    await screen.findByText("Withdrawn from Tuesday Evening Circle.");
    const post = sent.find((s) => s.method === "POST");
    expect(post?.path).toBe(
      `/api/v1/bereavement/groups/${GROUP_A}/enrollments/${CONTACT}/withdraw`,
    );
    expect(post?.body).toEqual({ reason: "staff_removed" });
    expect(post?.headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("a 409 refusal on withdraw closes the dialog, is said in the panel and the list is read again", async () => {
    let reads = 0;
    mount((method) => {
      if (method === "POST")
        return {
          status: 409,
          body: { error: { code: "ENROLLMENT_NOT_ACTIVE", message: "Already withdrawn." } },
        };
      reads += 1;
      return { status: 200, body: [enrollment()] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Already withdrawn.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("a 409 refusal on enroll closes the dialog, is said in the panel and the list is read again", async () => {
    let reads = 0;
    mount((method, path) => {
      if (method === "POST")
        return {
          status: 409,
          body: { error: { code: "GROUP_FULL", message: "The group is full." } },
        };
      if (path === "/api/v1/bereavement/groups")
        return { status: 200, body: { data: [group()], next_cursor: null, has_more: false } };
      reads += 1;
      return { status: 200, body: [enrollment()] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Enroll in a group" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Group" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enroll" }));
    expect(await screen.findByText("The group is full.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("a non-stale enroll failure is said in the dialog, which stays open", async () => {
    mount((method, path) => {
      if (method === "POST")
        return { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } };
      if (path === "/api/v1/bereavement/groups")
        return { status: 200, body: { data: [group()], next_cursor: null, has_more: false } };
      return { status: 200, body: [enrollment()] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Enroll in a group" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByRole("combobox", { name: "Group" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Enroll" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("boom");
  });
});
