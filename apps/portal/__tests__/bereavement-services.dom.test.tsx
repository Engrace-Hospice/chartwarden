import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// ADR-0109 D10 PR 3 — the bereaved family's memorial-service invitations on the portal bereavement page: the RSVP form while replies are
// open (with an Idempotency-Key), the closed state, the join link only when present, nothing at all when there is no invitation.
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const P1 = "11111111-1111-4111-8111-111111111111";
const INV = "33333333-3333-4333-8333-333333333333";
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const invitation = (over: Record<string, unknown> = {}) => ({
  invitationId: INV,
  title: "Winter Candle Lighting",
  description: "An evening of music and remembrance.",
  startsAt: "2026-12-10T00:30:00.000Z",
  endsAt: "2026-12-10T02:00:00.000Z",
  modality: "in_person",
  venueText: "Garden Chapel, 12 Example Lane",
  joinUrl: null,
  rsvpBy: "2026-12-01",
  status: "invited",
  guests: 0,
  rsvpOpen: true,
  ...over,
});

type Sent = { method: string; path: string; headers: Headers; body: unknown };
function renderPage(memorials: (method: string) => Response | Promise<Response>) {
  window.history.pushState({}, "", `/portal/p/${P1}/bereavement`);
  const sent: Sent[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const path = new URL(req.url).pathname;
      const text = req.method === "GET" ? "" : await req.clone().text();
      sent.push({
        method: req.method,
        path,
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      });
      if (path === "/api/v1/portal/care-summary")
        return json({ patient: { layLabel: "Example patient" } });
      if (path.startsWith("/api/v1/portal/bereavement/memorials")) return memorials(req.method);
      if (path.endsWith("/program") || path.endsWith("/resources")) return json({ items: [] });
      return json({}, 404);
    },
  });
  render(<PortalApp client={client} />);
  return sent;
}
const section = () => screen.getByRole("region", { name: "Memorial services" });

describe("portal memorial services", () => {
  it("shows the invitation with when and where, and no join link without one", async () => {
    renderPage(() => json({ items: [invitation()] }));
    expect(await screen.findByRole("heading", { name: "Winter Candle Lighting" })).toBeTruthy();
    expect(within(section()).getByText("Garden Chapel, 12 Example Lane")).toBeTruthy();
    expect(within(section()).queryByRole("link", { name: /Join/ })).toBeNull();
    expect(within(section()).getByRole("button", { name: "Send my reply" })).toBeTruthy();
  });

  it("offers the join link only when there is one", async () => {
    renderPage(() =>
      json({
        items: [invitation({ modality: "virtual", joinUrl: "https://meet.example.org/candle" })],
      }),
    );
    const link = await screen.findByRole("link", {
      name: "Join online: Winter Candle Lighting (opens in a new tab)",
    });
    expect(link.getAttribute("href")).toBe("https://meet.example.org/candle");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("shows nothing when the family has no invitation", async () => {
    renderPage(() => json({ items: [] }));
    await screen.findByRole("heading", { name: "Helpful resources" });
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Memorial services" })).toBeNull(),
    );
  });

  it("says a failure plainly with a retry", async () => {
    let reads = 0;
    renderPage(() => {
      reads += 1;
      return reads === 1 ? json({}, 503) : json({ items: [invitation()] });
    });
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Winter Candle Lighting" })).toBeTruthy();
  });

  it("sends the reply with the guest count and an Idempotency-Key, then thanks the family", async () => {
    let stored = invitation();
    const sent = renderPage((method) => {
      if (method !== "POST") return json({ items: [stored] });
      stored = invitation({ status: "rsvp_yes", guests: 2 });
      return json(stored);
    });
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "Yes, I plan to come" }));
    fireEvent.change(within(section()).getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect(await within(section()).findByText("Thank you. We have your reply.")).toBeTruthy();
    expect(within(section()).getByText("You told us you plan to come.")).toBeTruthy();
    const post = sent.find((s) => s.method === "POST");
    expect(post?.path).toBe(`/api/v1/portal/bereavement/memorials/${INV}/rsvp`);
    expect(post?.body).toEqual({ response: "yes", guests: 2 });
    expect(post?.headers.get("Idempotency-Key")).toBeTruthy();
  });

  it("sends no guests when the family can't make it", async () => {
    const sent = renderPage((method) =>
      method === "POST"
        ? json(invitation({ status: "rsvp_no" }))
        : json({ items: [invitation({ guests: 3 })] }),
    );
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "I can't make it" }));
    expect(within(section()).queryByRole("spinbutton")).toBeNull();
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    await within(section()).findByText("Thank you. We have your reply.");
    expect(sent.find((s) => s.method === "POST")?.body).toEqual({ response: "no", guests: 0 });
  });

  it("shows the closed state and no form once replies have closed", async () => {
    renderPage(() => json({ items: [invitation({ rsvpOpen: false, status: "rsvp_maybe" })] }));
    expect(await screen.findByText("Replies for this service are closed.")).toBeTruthy();
    expect(screen.getByText("You told us you might come.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send my reply" })).toBeNull();
  });

  it("does not thank the family when the reply fails", async () => {
    renderPage((method) => (method === "POST" ? json({}, 500) : json({ items: [invitation()] })));
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "Maybe" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect((await within(section()).findByRole("alert")).textContent).toContain(
      "We couldn't send your reply",
    );
    expect(within(section()).queryByText("Thank you. We have your reply.")).toBeNull();
  });

  it("chooses no answer for the family: nothing is selected, and Send without an answer asks for one", async () => {
    const sent = renderPage(() => json({ items: [invitation()] }));
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    for (const radio of within(section()).getAllByRole("radio")) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    const send = within(section()).getByRole("button", { name: "Send my reply" });
    expect((send as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(send);
    expect((await within(section()).findByRole("alert")).textContent).toBe(
      "Please choose an answer.",
    );
    expect(sent.some((s) => s.method === "POST")).toBe(false);
  });

  it("a yes re-reads the invitations to show the join link the reply does not carry", async () => {
    const LINK = "https://meet.example.org/candle";
    let stored = invitation({ modality: "virtual" });
    const sent = renderPage((method) => {
      if (method !== "POST") return json({ items: [stored] });
      stored = invitation({ modality: "virtual", status: "rsvp_yes", joinUrl: LINK });
      return json({ ...stored, joinUrl: null });
    });
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    expect(within(section()).queryByRole("link", { name: /Join online/ })).toBeNull();
    fireEvent.click(within(section()).getByRole("radio", { name: "Yes, I plan to come" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect(await within(section()).findByText("Thank you. We have your reply.")).toBeTruthy();
    const link = await within(section()).findByRole("link", { name: /Join online/ });
    expect(link.getAttribute("href")).toBe(LINK);
    expect(sent.filter((s) => s.method === "GET" && s.path.endsWith("/memorials"))).toHaveLength(2);
    // the thank-you survives the re-read
    expect(within(section()).getByText("Thank you. We have your reply.")).toBeTruthy();
  });

  it("a slow post-yes re-read never overwrites a newer answer", async () => {
    let releaseReread: (r: Response) => void = () => undefined;
    let gets = 0;
    let stored = invitation();
    renderPage((method) => {
      if (method === "POST") {
        const yes = stored.status !== "rsvp_yes";
        stored = invitation({ status: yes ? "rsvp_yes" : "rsvp_no" });
        return json(stored);
      }
      gets += 1;
      // the first GET loads the page; the second is the post-yes re-read, which we hold until after a newer "no"
      if (gets === 2) return new Promise<Response>((resolve) => (releaseReread = resolve));
      return json({ items: [stored] });
    });
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "Yes, I plan to come" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect(await within(section()).findByText("You told us you plan to come.")).toBeTruthy();
    fireEvent.click(
      within(section()).getByRole("radio", { name: /can't make it|cannot make it|No/ }),
    );
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect(await within(section()).findByText(/You told us you can't make it/)).toBeTruthy();
    // the stale re-read (taken after the yes) now lands: it must not bring the yes back
    releaseReread(json({ items: [invitation({ status: "rsvp_yes" })] }));
    await new Promise((r) => setTimeout(r, 20));
    expect(within(section()).getByText(/You told us you can't make it/)).toBeTruthy();
    expect(within(section()).queryByText("You told us you plan to come.")).toBeNull();
  });

  it("retries a dropped reply under the same key, and a changed reply under a new one", async () => {
    let posts = 0;
    const sent = renderPage((method) => {
      if (method !== "POST") return json({ items: [invitation()] });
      posts += 1;
      if (posts <= 2) throw new TypeError("network down");
      return json(invitation({ status: "rsvp_yes", guests: 1 }));
    });
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "Yes, I plan to come" }));
    const send = () =>
      fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    send();
    await within(section()).findByText(/couldn't confirm your reply/);
    send();
    await waitFor(() => expect(posts).toBe(2));
    await within(section()).findByText(/couldn't confirm your reply/);
    fireEvent.change(within(section()).getByRole("spinbutton"), { target: { value: "1" } });
    send();
    await within(section()).findByText("Thank you. We have your reply.");
    const keys = sent
      .filter((s) => s.method === "POST")
      .map((s) => s.headers.get("Idempotency-Key"));
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it("tells a reused-key conflict apart from closed replies", async () => {
    let code = "IDEMPOTENCY_CONFLICT";
    renderPage((method) =>
      method === "POST"
        ? json({ error: { code, message: "refused" } }, 409)
        : json({ items: [invitation()] }),
    );
    await screen.findByRole("heading", { name: "Winter Candle Lighting" });
    fireEvent.click(within(section()).getByRole("radio", { name: "Maybe" }));
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    expect((await within(section()).findByRole("alert")).textContent).toContain(
      "Your reply changed while it was being sent",
    );
    code = "MEMORIAL_RSVP_CLOSED";
    fireEvent.click(within(section()).getByRole("button", { name: "Send my reply" }));
    await waitFor(() =>
      expect(within(section()).getByRole("alert").textContent).toContain(
        "Replies for this service have closed",
      ),
    );
  });
});
