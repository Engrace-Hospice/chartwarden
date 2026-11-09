import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10 PR 3: the contact detail's memorial-invitations panel (routes 74 and 76).
// Without `bereavement.memorial.rsvp` nothing is requested or shown; a 403 renders nothing; a phone RSVP is offered only while the service is
// published and carries an Idempotency-Key.
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { ContactMemorialInvitationsCard } from "./contact-memorial-invitations-card";

const CONTACT = "c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0";
const INVITATION = "11111111-1111-4111-8111-111111111111";

const invitation = (over: Record<string, unknown> = {}) => ({
  invitationId: INVITATION,
  serviceId: "22222222-2222-4222-8222-222222222222",
  serviceTitle: "Autumn Remembrance Evening",
  startsAt: "2026-11-20T23:00:00.000Z",
  serviceStatus: "published",
  delivery: "mailing",
  status: "invited",
  guests: 0,
  rsvpSource: null,
  rsvpAt: null,
  version: 1,
  ...over,
});

type Reply = { status: number; body?: unknown };
type Sent = { method: string; path: string; headers: Headers; body: unknown };

function mount(answer: (method: string) => Reply, permissions = ["bereavement.memorial.rsvp"]) {
  const sent: Sent[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const text = req.method === "GET" ? "" : await req.clone().text();
    sent.push({
      method: req.method,
      path: new URL(req.url).pathname,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    });
    const reply = answer(req.method);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter>
          <ContactMemorialInvitationsCard contactId={CONTACT} />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { sent, ...view };
}

describe("contact memorial-invitations panel", () => {
  it("lists each invitation with its answer", async () => {
    mount(() => ({ status: 200, body: [invitation({ status: "rsvp_yes", guests: 2 })] }));
    const table = await screen.findByRole("table", { name: "Memorial invitations" });
    expect(within(table).getByText("Autumn Remembrance Evening")).toBeTruthy();
    expect(within(table).getByText("Coming")).toBeTruthy();
    expect(within(table).getByText("2")).toBeTruthy();
  });

  it("says plainly that there are no invitations", async () => {
    mount(() => ({ status: 200, body: [] }));
    expect(
      await screen.findByText("This family has not been invited to a memorial service."),
    ).toBeTruthy();
  });

  it("a server error is said with Try again", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1
        ? { status: 503, body: { error: { code: "UNAVAILABLE", message: "down for a moment" } } }
        : { status: 200, body: [invitation()] };
    });
    expect((await screen.findByRole("alert")).textContent).toContain("down for a moment");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Autumn Remembrance Evening")).toBeTruthy();
  });

  it("a 403 renders nothing", async () => {
    const { container } = mount(() => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("without the rsvp permission nothing is requested or shown", () => {
    const { container, sent } = mount(
      () => ({ status: 200, body: [] }),
      ["bereavement.memorial.manage"],
    );
    expect(container.firstChild).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("offers no phone RSVP once the service is no longer published", async () => {
    mount(() => ({ status: 200, body: [invitation({ serviceStatus: "held" })] }));
    await screen.findByText("Autumn Remembrance Evening");
    expect(screen.queryByRole("button", { name: "Record phone RSVP" })).toBeNull();
  });

  it("records a phone RSVP with the guest count and an Idempotency-Key", async () => {
    const { sent } = mount((method) =>
      method === "PUT"
        ? {
            status: 200,
            body: invitation({
              status: "rsvp_yes",
              guests: 3,
              rsvpSource: "staff_phone",
              rsvpAt: "2026-11-06T15:00:00.000Z",
            }),
          }
        : { status: 200, body: [invitation()] },
    );
    fireEvent.click(await screen.findByRole("button", { name: "Record phone RSVP" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save RSVP" }));
    await screen.findByText("RSVP recorded: Coming.");
    const put = sent.find((s) => s.method === "PUT");
    expect(put?.path).toBe(
      `/api/v1/bereavement/contacts/${CONTACT}/memorial-invitations/${INVITATION}/rsvp`,
    );
    expect(put?.body).toEqual({ response: "yes", guests: 3 });
    expect(put?.headers.get("Idempotency-Key")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("refuses a guest count above ten before sending anything", async () => {
    const { sent } = mount(() => ({ status: 200, body: [invitation()] }));
    fireEvent.click(await screen.findByRole("button", { name: "Record phone RSVP" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByRole("spinbutton"), { target: { value: "11" } });
    expect(
      (within(dialog).getByRole("button", { name: "Save RSVP" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(sent.filter((s) => s.method === "PUT")).toHaveLength(0);
  });

  it("a 409 refusal is said in place and the list is read again", async () => {
    let reads = 0;
    mount((method) => {
      if (method === "PUT")
        return {
          status: 409,
          body: { error: { code: "MEMORIAL_RSVP_CLOSED", message: "Replies have closed." } },
        };
      reads += 1;
      return { status: 200, body: [invitation()] };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Record phone RSVP" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Save RSVP" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Replies have closed.",
    );
    await waitFor(() => expect(reads).toBe(2));
  });
});
