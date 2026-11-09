import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: one memorial service (routes 69-73, 75). Publish / close / edit carry If-Match = the
// version read plus an Idempotency-Key, a 412 reloads, the invitation mailing run is linked once it exists, the invitation list is oversight
// only, attendance once the service started; a 403 renders nothing.
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MemorialServiceDetail } from "./memorial-detail";

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const INVITATION = "44444444-4444-4444-8444-444444444444";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "55555555-5555-4555-8555-555555555555";
const MANAGE = ["bereavement.memorial.rsvp", "bereavement.memorial.manage"];
const SERVICE_PATH = `/api/v1/bereavement/memorials/${SERVICE_ID}`;

const service = (over: Record<string, unknown> = {}) => ({
  serviceId: SERVICE_ID,
  title: "Spring remembrance",
  description: "An evening of music and reflection.",
  startsAt: "2099-04-10T23:00:00.000Z",
  endsAt: "2099-04-11T01:00:00.000Z",
  modality: "in_person",
  venueText: "Garden pavilion",
  hasJoinUrl: false,
  joinUrl: null,
  capacity: 80,
  rsvpBy: "2099-04-01",
  inviteWindowMonths: 13,
  status: "draft",
  publishedAt: null,
  invitedCount: 0,
  rsvpCounts: { invited: 0, yes: 0, no: 0, maybe: 0, attended: 0, noShow: 0, guestsExpected: 0 },
  mailingRunId: null,
  version: 5,
  createdAt: "2099-01-01T00:00:00.000Z",
  ...over,
});

const invitation = (over: Record<string, unknown> = {}) => ({
  invitationId: INVITATION,
  serviceId: SERVICE_ID,
  contactId: CONTACT_ID,
  planId: PLAN_ID,
  displayName: "Marigold Testerson",
  relationshipCode: "spouse",
  delivery: "mailing",
  status: "rsvp_yes",
  guests: 2,
  rsvpSource: "staff_phone",
  rsvpAt: "2099-03-01T10:00:00.000Z",
  attendedAt: null,
  version: 1,
  ...over,
});

interface Req {
  method: string;
  path: string;
  body: unknown;
  ifMatch: string | null;
  idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown };

function mount(handler: (req: Req) => Reply, permissions: string[] = MANAGE) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const text = req.method !== "GET" ? await req.clone().text() : "";
    const recorded: Req = {
      method: req.method,
      path: new URL(req.url).pathname,
      body: text ? JSON.parse(text) : null,
      ifMatch: req.headers.get("if-match"),
      idempotencyKey: req.headers.get("idempotency-key"),
    };
    calls.push(recorded);
    const reply = handler(recorded);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter initialEntries={[`/bereavement/memorials/${SERVICE_ID}`]}>
          <Routes>
            <Route path="/bereavement/memorials/:serviceId" element={<MemorialServiceDetail />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

const ok = (body: unknown): Reply => ({ status: 200, body });
/** A server holding `current`, answering invitations with `invites`, and `write` for any POST/PATCH. */
const server =
  (current: () => unknown, invites: unknown[] = [], write?: (req: Req) => Reply) =>
  (req: Req): Reply => {
    if (req.method !== "GET") return write ? write(req) : ok(current());
    if (req.path.endsWith("/invitations")) return ok(invites);
    return ok(current());
  };

describe("memorial service — reads", () => {
  it("shows the summary and the RSVP counts", async () => {
    mount(
      server(() =>
        service({
          rsvpCounts: {
            invited: 1,
            yes: 3,
            no: 0,
            maybe: 2,
            attended: 0,
            noShow: 0,
            guestsExpected: 4,
          },
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: "Spring remembrance" })).toBeTruthy();
    expect(screen.getByText("Garden pavilion")).toBeTruthy();
    expect(screen.getByText("Guests expected")).toBeTruthy();
  });

  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a server error is announced with Try again", async () => {
    let reads = 0;
    mount((req) => {
      if (req.path !== SERVICE_PATH) return ok([]);
      reads += 1;
      return reads === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : ok(service());
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Spring remembrance" })).toBeTruthy();
  });

  it("links the invitation mailing run once the service has one", async () => {
    mount(server(() => service({ status: "published", mailingRunId: RUN_ID })));
    const link = await screen.findByRole("link", { name: "Invitation mailing" });
    expect(link.getAttribute("href")).toBe(`/bereavement/mailings/runs/${RUN_ID}`);
    expect(screen.getByText(/Its wording is written there by staff/)).toBeTruthy();
  });

  it("a reader without memorial.manage sees no actions and the invitations are never requested", async () => {
    const { calls } = mount(
      server(() => service()),
      ["bereavement.memorial.rsvp"],
    );
    await screen.findByRole("heading", { name: "Spring remembrance" });
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.getByText("Your role can view this service but not change it.")).toBeTruthy();
    expect(calls.some((c) => c.path.endsWith("/invitations"))).toBe(false);
  });
});

describe("memorial service — writes", () => {
  it("publishes through an alertdialog with If-Match and an Idempotency-Key", async () => {
    let current = service();
    const { calls } = mount(
      server(
        () => current,
        [],
        () => {
          current = service({
            status: "published",
            version: 6,
            invitedCount: 9,
            mailingRunId: RUN_ID,
          });
          return ok(current);
        },
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("No invitation wording is filled in for you");
    fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("Published. 9 families invited.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${SERVICE_PATH}/publish`);
    expect(post?.ifMatch).toBe("5");
    expect(post?.idempotencyKey).toBeTruthy();
    expect(screen.getByRole("link", { name: "Invitation mailing" })).toBeTruthy();
  });

  it("a 412 on close reloads the service and says it changed", async () => {
    let reads = 0;
    mount((req) => {
      if (req.method === "POST")
        return { status: 412, body: { error: { code: "PRECONDITION_FAILED", message: "moved" } } };
      if (req.path.endsWith("/invitations")) return ok([]);
      reads += 1;
      return ok(service({ status: "published" }));
    });
    fireEvent.click(await screen.findByRole("button", { name: "Cancel service" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, cancel the service" }));
    expect(
      await screen.findByText(/This service changed while you were working on it/),
    ).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("marks the service held with status held and If-Match", async () => {
    const { calls } = mount(
      server(
        () => service({ status: "published" }),
        [],
        () => ok(service({ status: "held", version: 6 })),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Mark held" }));
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Mark held" }),
    );
    expect(await screen.findByText("The service is marked as held.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${SERVICE_PATH}/close`);
    expect(post?.body).toEqual({ status: "held" });
    expect(post?.ifMatch).toBe("5");
  });

  it("edits with a PATCH carrying If-Match", async () => {
    const { calls } = mount(
      server(
        () => service(),
        [],
        (req) => ok(service({ title: (req.body as { title: string }).title, version: 6 })),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Spring gathering" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The service was saved.")).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(SERVICE_PATH);
    expect(patch?.ifMatch).toBe("5");
    expect(patch?.idempotencyKey).toBeTruthy();
    expect(patch?.body).toMatchObject({
      title: "Spring gathering",
      capacity: 80,
      rsvpBy: "2099-04-01",
    });
  });
});

describe("memorial service — invitations", () => {
  it("lists invitations without attendance buttons before the service starts", async () => {
    mount(server(() => service({ status: "published" }), [invitation()]));
    const link = await screen.findByRole("link", { name: "Marigold Testerson" });
    expect(link.getAttribute("href")).toBe(`/bereavement/plans/${PLAN_ID}/contacts/${CONTACT_ID}`);
    expect(
      within(screen.getByRole("table", { name: "Invitations" })).getByText("Coming"),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Marigold Testerson attended" })).toBeNull();
  });

  it("records attendance once the service started, with an Idempotency-Key", async () => {
    const started = {
      status: "published",
      startsAt: "2020-01-01T10:00:00.000Z",
      endsAt: "2020-01-01T12:00:00.000Z",
    };
    const { calls } = mount(
      server(
        () => service(started),
        [invitation()],
        () =>
          ok(
            invitation({ status: "attended", attendedAt: "2020-01-01T11:00:00.000Z", version: 2 }),
          ),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Marigold Testerson attended" }));
    expect(await screen.findByText("Marigold Testerson marked as attended.")).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${SERVICE_PATH}/invitations/${INVITATION}/attendance`);
    expect(post?.body).toEqual({ attended: true });
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.ifMatch).toBeNull();
    // the reader acted inside the invitations table: the announcement does not pull focus to the top of the page
    expect(document.activeElement?.tagName).not.toBe("OUTPUT");
  });
});

describe("memorial service — stale edits and the join link", () => {
  it("a 412 on edit closes the dialog, reloads the service and says why", async () => {
    let reads = 0;
    mount((req) => {
      if (req.method === "PATCH")
        return { status: 412, body: { error: { code: "PRECONDITION_FAILED", message: "moved" } } };
      if (req.path === SERVICE_PATH) reads += 1;
      return ok(service());
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/This service changed while you were editing it/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("an edit that leaves a hidden join link untouched does not send joinUrl (never null)", async () => {
    const { calls } = mount(
      server(
        () => service({ hasJoinUrl: true, joinUrl: null }),
        [],
        () => ok(service({ hasJoinUrl: true, version: 6 })),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The service was saved.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")?.body).not.toHaveProperty("joinUrl");
  });

  it("a write answers without the join link: the service is read again and the link is shown", async () => {
    const LINK = "https://meet.example.org/spring";
    let reads = 0;
    mount((req) => {
      if (req.method === "PATCH")
        return ok(service({ hasJoinUrl: true, joinUrl: null, version: 6 }));
      if (req.path.endsWith("/invitations")) return ok([]);
      reads += 1;
      return ok(service({ hasJoinUrl: true, joinUrl: LINK, version: reads === 1 ? 5 : 6 }));
    });
    expect(await screen.findByText(LINK)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The service was saved.")).toBeTruthy();
    await waitFor(() => expect(reads).toBe(2));
    expect(await screen.findByText(LINK)).toBeTruthy();
  });

  it("an edit that types a join link sends it", async () => {
    const { calls } = mount(
      server(
        () => service(),
        [],
        () => ok(service({ hasJoinUrl: true, version: 6 })),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Join link (https)"), {
      target: { value: "https://meet.example.org/spring" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("The service was saved.")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")?.body).toMatchObject({
      joinUrl: "https://meet.example.org/spring",
    });
  });
});
