import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the memorial services list (route 67) and the create form (route 68).
// Rows link to the service; a 403 renders nothing; a failure is announced with a retry; "New memorial service" is oversight only and the
// create carries an Idempotency-Key, then opens the new service.
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MemorialServices } from "./memorial-list";

const SERVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MANAGE = ["bereavement.memorial.rsvp", "bereavement.memorial.manage"];

const service = (over: Record<string, unknown> = {}) => ({
  serviceId: SERVICE_A,
  title: "Autumn remembrance evening",
  description: null,
  startsAt: "2026-11-20T23:00:00.000Z",
  endsAt: "2026-11-21T01:00:00.000Z",
  modality: "in_person",
  venueText: "Community hall",
  hasJoinUrl: false,
  capacity: null,
  rsvpBy: null,
  inviteWindowMonths: 13,
  status: "published",
  publishedAt: "2026-10-01T00:00:00.000Z",
  invitedCount: 12,
  rsvpCounts: { invited: 4, yes: 5, no: 2, maybe: 1, attended: 0, noShow: 0, guestsExpected: 7 },
  mailingRunId: null,
  version: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  ...over,
});

interface Req {
  method: string;
  path: string;
  body: unknown;
  idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown };

function NewServiceProbe(): JSX.Element {
  const { serviceId } = useParams();
  return <p>Opened service {serviceId}</p>;
}

function mount(handler: (req: Req) => Reply, permissions = ["bereavement.memorial.rsvp"]) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const text = req.method !== "GET" ? await req.clone().text() : "";
    const recorded: Req = {
      method: req.method,
      path: new URL(req.url).pathname,
      body: text ? JSON.parse(text) : null,
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
        <MemoryRouter initialEntries={["/bereavement/memorials"]}>
          <Routes>
            <Route path="/bereavement/memorials" element={<MemorialServices />} />
            <Route path="/bereavement/memorials/:serviceId" element={<NewServiceProbe />} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

const page = (data: unknown[]): Reply => ({
  status: 200,
  body: { data, next_cursor: null, has_more: false },
});

describe("memorial services list", () => {
  it("lists each service with its RSVP counts and links to it", async () => {
    mount(() => page([service()]));
    const link = await screen.findByRole("link", { name: "Autumn remembrance evening" });
    expect(link.getAttribute("href")).toBe(`/bereavement/memorials/${SERVICE_A}`);
    const row = within(screen.getByRole("table", { name: "Memorial services" })).getAllByRole(
      "row",
    )[1] as HTMLElement;
    expect(within(row).getByText("Published")).toBeTruthy();
    expect(within(row).getByText("12")).toBeTruthy();
    expect(within(row).getByText("7")).toBeTruthy();
  });

  it("says plainly that there are no services", async () => {
    mount(() => page([]));
    expect(await screen.findByText("No memorial services")).toBeTruthy();
  });

  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a server error is announced with Try again, and the retry loads the services", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : page([service()]);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Autumn remembrance evening" })).toBeTruthy();
  });

  it("does not offer New memorial service without memorial.manage", async () => {
    mount(() => page([service()]));
    await screen.findByRole("table", { name: "Memorial services" });
    expect(screen.queryByRole("button", { name: "New memorial service" })).toBeNull();
  });

  it("creates a service with an Idempotency-Key and opens it", async () => {
    const created = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const { calls } = mount(
      (req) =>
        req.method === "POST"
          ? {
              status: 200,
              body: { ...service({ serviceId: created, status: "draft" }), joinUrl: null },
            }
          : page([]),
      MANAGE,
    );
    fireEvent.click(await screen.findByRole("button", { name: "New memorial service" }));
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Winter candle lighting" },
    });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2026-12-10T18:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2026-12-10T19:30" } });
    fireEvent.change(screen.getByLabelText("Join link (https)"), {
      target: { value: "http://insecure.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toContain("https://");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("Join link (https)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(`Opened service ${created}`)).toBeTruthy();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/bereavement/memorials");
    expect(post?.idempotencyKey).toBeTruthy();
    expect(post?.body).toMatchObject({
      title: "Winter candle lighting",
      modality: "in_person",
      joinUrl: null,
      inviteWindowMonths: 13,
    });
  });
});
