import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
// M36 admin screens: every screen has loading / error+retry / empty / 403 states; deliveries paginate by
// `nextBefore`; members list, add and remove through the api module; the integrity tile reads its injected source.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertDeliveries } from "../alert-deliveries";
import { ChannelMembers } from "../channel-members";
import { IntegrityTile } from "../integrity-tile";

const CH = "11111111-1111-4111-8111-111111111111";
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const errBody = { error: { code: "X", message: "x", correlationId: "c" } };

type Handler = (req: Request) => Response | Promise<Response>;

function mount(handler: Handler, ui: JSX.Element, entry = "/x"): void {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
    handler(input instanceof Request ? input : new Request(String(input), init));
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/x" element={ui} />
          <Route path="/m/:id" element={ui} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

const delivery = (id: string, status = "failed") => ({
  deliveryId: id,
  organizationId: "22222222-2222-4222-8222-222222222222",
  alertId: "a",
  alertCategory: `cat-${id}`,
  alertSeverity: "high",
  channel: "sms",
  status,
  failReason: "carrier rejected",
  queuedAt: "2026-10-01T10:00:00.000Z",
  sentAt: null,
  settledAt: null,
});

afterEach(() => cleanup());

describe("Alert deliveries", () => {
  it("shows loading then rows, and loads the next page by nextBefore", async () => {
    const urls: string[] = [];
    mount(
      (req) => {
        urls.push(req.url);
        const before = new URL(req.url).searchParams.get("before");
        return json(
          before
            ? { items: [delivery("d2")], nextBefore: null }
            : { items: [delivery("d1")], nextBefore: "2026-10-01T10:00:00.000Z" },
        );
      },
      <AlertDeliveries />,
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("cat-d1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("cat-d2")).toBeTruthy();
    expect(screen.getByText("cat-d1")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(urls[1]).toContain("before=2026-10-01T10%3A00%3A00.000Z");
  });

  it("drops a late older page when the filter changed meanwhile", async () => {
    let releaseStale: (r: Response) => void = () => {};
    mount(
      (req) => {
        const url = new URL(req.url);
        if (url.searchParams.get("before"))
          return new Promise<Response>((resolve) => {
            releaseStale = resolve;
          });
        return url.searchParams.get("status") === "sent"
          ? json({ items: [delivery("sent1", "sent")], nextBefore: null })
          : json({ items: [delivery("f1")], nextBefore: "2026-10-01T10:00:00.000Z" });
      },
      <AlertDeliveries />,
    );
    await screen.findByText("cat-f1");
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    fireEvent.change(screen.getByLabelText("Filter by delivery status"), {
      target: { value: "sent" },
    });
    await screen.findByText("cat-sent1");
    releaseStale(json({ items: [delivery("stale")], nextBefore: null }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("cat-stale")).toBeNull();
  });

  it("filters by status", async () => {
    const statuses: (string | null)[] = [];
    mount(
      (req) => {
        statuses.push(new URL(req.url).searchParams.get("status"));
        return json({ items: [], nextBefore: null });
      },
      <AlertDeliveries />,
    );
    expect(await screen.findByText("No deliveries match this filter.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter by delivery status"), {
      target: { value: "pending" },
    });
    await waitFor(() => expect(statuses.at(-1)).toBe("pending"));
  });

  it("shows no-access on 403", async () => {
    mount(() => json(errBody, 403), <AlertDeliveries />);
    expect(await screen.findByText(/do not have access to alert deliveries/)).toBeTruthy();
  });

  it("shows an error with a working retry", async () => {
    let calls = 0;
    mount(
      () =>
        ++calls === 1 ? json(errBody, 500) : json({ items: [delivery("d1")], nextBefore: null }),
      <AlertDeliveries />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("cat-d1")).toBeTruthy();
  });
});

describe("Channel members", () => {
  const MEMBERS = {
    members: [
      { userId: "u1", role: "owner", source: "manual", displayName: "Dana Reyes" },
      { userId: "u2", role: "read_only", source: "auto", displayName: null },
    ],
  };

  it("lists members with role and source", async () => {
    mount(() => json(MEMBERS), <ChannelMembers />, `/m/${CH}`);
    expect(await screen.findByText("Dana Reyes")).toBeTruthy();
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(1); // the pill and the add-form option
    expect(screen.getAllByText("Read only").length).toBeGreaterThan(1);
    expect(screen.getByText("auto")).toBeTruthy();
  });

  it("adds a member (POST body) and removes one (DELETE), reloading the list", async () => {
    const calls: string[] = [];
    let body: unknown;
    mount(
      async (req) => {
        const path = new URL(req.url).pathname;
        calls.push(`${req.method} ${path}`);
        if (req.method === "POST") {
          body = await req.json();
          return new Response(null, { status: 204 });
        }
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        return json(MEMBERS);
      },
      <ChannelMembers />,
      `/m/${CH}`,
    );
    await screen.findByText("Dana Reyes");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "u9" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "read_only" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(body).toEqual({ userId: "u9", role: "read_only" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Dana Reyes" }));
    await waitFor(() =>
      expect(calls).toContain(`DELETE /api/v1/messaging/channels/${CH}/members/u1`),
    );
    expect(calls.filter((c) => c.startsWith("GET")).length).toBeGreaterThanOrEqual(3);
  });

  it("shows empty, 403 and error states", async () => {
    mount(() => json({ members: [] }), <ChannelMembers />, `/m/${CH}`);
    expect(await screen.findByText("This channel has no members.")).toBeTruthy();
    cleanup();
    mount(() => json(errBody, 403), <ChannelMembers />, `/m/${CH}`);
    expect(await screen.findByText(/do not have access to this channel/)).toBeTruthy();
    cleanup();
    mount(() => json(errBody, 500), <ChannelMembers />, `/m/${CH}`);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("surfaces a failed write without losing the list", async () => {
    mount(
      (req) => (req.method === "POST" ? json(errBody, 403) : json(MEMBERS)),
      <ChannelMembers />,
      `/m/${CH}`,
    );
    await screen.findByText("Dana Reyes");
    fireEvent.change(screen.getByLabelText("User ID"), { target: { value: "u9" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByText(/do not have permission to add members/)).toBeTruthy();
    expect(screen.getByText("Dana Reyes")).toBeTruthy();
  });
});

describe("Integrity tile", () => {
  it("renders health and findings from the source, with error retry", async () => {
    const source = vi
      .fn()
      .mockResolvedValueOnce({ kind: "error" })
      .mockResolvedValue({
        kind: "ok",
        data: {
          "m36.hash_verify.run": {
            eventType: "m36.hash_verify.run",
            createdAt: "2026-10-02T00:00:00Z",
            outcome: "success",
          },
          "m36.integrity.hash_mismatch": {
            eventType: "m36.integrity.hash_mismatch",
            createdAt: "2026-10-02T00:00:00Z",
            outcome: "failure",
          },
        },
      });
    mount(() => json({}), <IntegrityTile source={source} />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText(/m36\.integrity\.hash_mismatch/)).toBeTruthy();
  });

  it("shows no-access when the source is forbidden", async () => {
    mount(() => json({}), <IntegrityTile source={async () => ({ kind: "forbidden" })} />);
    expect(await screen.findByText(/do not have access to integrity job status/)).toBeTruthy();
  });

  it("reads the audit trail through the client by default", async () => {
    const types: (string | null)[] = [];
    mount(
      (req) => {
        types.push(new URL(req.url).searchParams.get("eventType"));
        return json({ items: [], nextCursor: null });
      },
      <IntegrityTile />,
    );
    expect(await screen.findByText("No runs recorded")).toBeTruthy();
    expect(types).toContain("m36.hash_verify.run");
  });
});
