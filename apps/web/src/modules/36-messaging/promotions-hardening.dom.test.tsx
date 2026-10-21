// M36 WP 3.7 review fixes: no read without the permission, a failure is remembered briefly, a superseded read never
// overwrites a newer one, the trigger names the message and keeps focus, the filter switch never shows the other
// filter's rows, and the inbox tab needs the flag AND messaging.promote.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AlertInboxProvider } from "../../shell/alert-inbox";
import { SessionProvider } from "../../shell/session";
import { MessagePromotionButton } from "./message-promotion-button";
import { NotificationsInbox } from "./notifications-inbox";
import { PromotionsList } from "./promotions-list";
import { PROMOTION_FIXTURE, listAnswer, mountWithClient } from "./promotions-test-fixture";
import { refreshPromotions, usePromotionsIndex } from "./use-promotions-enabled";

afterEach(cleanup);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("message trigger", () => {
  it("starts its accessible name with the visible text and names the author", async () => {
    mountWithClient(
      <MessagePromotionButton channelId="c1" messageId="m1" authorName="Sam Lead" patientLinked />,
      { list: listAnswer([]) },
    );
    const trigger = await screen.findByRole("button", {
      name: "Propose for chart, message from Sam Lead",
    });
    expect(trigger.textContent).toBe("Propose for chart");
  });

  it("moves focus to the trigger after Withdraw", async () => {
    const post = vi.fn().mockResolvedValue({
      data: { promotion: { ...PROMOTION_FIXTURE, status: "withdrawn", allowed_actions: [] } },
      response: { status: 200 },
    });
    mountWithClient(<MessagePromotionButton channelId="c1" messageId="m1" patientLinked />, {
      list: listAnswer([PROMOTION_FIXTURE]),
      post,
    });
    await userEvent.click(await screen.findByRole("button", { name: "Withdraw proposal" }));
    const trigger = screen.getByRole("button", { name: /^Propose for chart/ });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("reads once for many rows when the read fails (the failure is remembered)", async () => {
    const GET = vi.fn().mockResolvedValue({ data: undefined });
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    const tree = (ids: string[]) => (
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <SessionProvider
            session={{ userId: "u1", organizationId: "o1", permissions: ["messaging.promote"] }}
          >
            {ids.map((id) => (
              <MessagePromotionButton key={id} channelId="c1" messageId={id} patientLinked />
            ))}
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>
    );
    const view = render(tree(["a"]));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    await act(async () => {});
    view.rerender(tree(["a", "b"]));
    await act(async () => {});
    expect(GET).toHaveBeenCalledTimes(1);
  });
});

describe("usePromotionsIndex", () => {
  it("ignores a read that a refresh overtook", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const GET = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    function Probe() {
      const { promotions } = usePromotionsIndex();
      return <p data-testid="ids">{promotions.map((p) => p.id).join(",")}</p>;
    }
    render(
      <ApiClientProvider client={client}>
        <Probe />
      </ApiClientProvider>,
    );
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(1));
    act(() => refreshPromotions(client));
    await waitFor(() => expect(GET).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(listAnswer([{ ...PROMOTION_FIXTURE, id: "new" }])));
    await act(async () => first.resolve(listAnswer([{ ...PROMOTION_FIXTURE, id: "old" }])));
    expect(screen.getByTestId("ids").textContent).toBe("new");
  });
});

describe("PromotionsList filter switch", () => {
  it("shows loading, not the Open rows, while the Closed list is read", async () => {
    const closed = deferred<unknown>();
    const GET = vi.fn((_path: string, init: { params: { query: { status: string } } }) =>
      init.params.query.status === "closed"
        ? closed.promise
        : Promise.resolve(listAnswer([PROMOTION_FIXTURE])),
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    render(
      <MemoryRouter>
        <ApiClientProvider client={client}>
          <PromotionsList />
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByRole("button", { name: "Withdraw proposal" });
    await userEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).toBeNull();
    await act(async () => closed.resolve(listAnswer([])));
    expect(await screen.findByText("You have no closed chart proposals.")).toBeTruthy();
  });

  it("builds the message link with URLSearchParams (ids are encoded)", async () => {
    mountWithClient(<PromotionsList />, {
      list: listAnswer([{ ...PROMOTION_FIXTURE, channel_id: "c&1", message_id: "m 1" }]),
    });
    const link = await screen.findByRole("link", { name: "Open message" });
    expect(link.getAttribute("href")).toBe("/messaging?channelId=c%261&messageId=m+1");
  });
});

describe("Chart proposals inbox tab", () => {
  function mountInbox(options: { enabled: boolean; permissions: string[]; url?: string }) {
    const GET = vi.fn(async (path: string, _init?: unknown) =>
      path === "/api/v1/messaging/chart-promotions"
        ? listAnswer([], options.enabled)
        : { data: { alerts: [] }, error: undefined },
    );
    const client = { GET, POST: vi.fn() } as unknown as ApiClient;
    render(
      <MemoryRouter initialEntries={[options.url ?? "/"]}>
        <ApiClientProvider client={client}>
          <SessionProvider
            session={{ userId: "u1", organizationId: "o1", permissions: options.permissions }}
          >
            <AlertInboxProvider>
              <NotificationsInbox />
            </AlertInboxProvider>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    return GET;
  }

  it("shows when the tenant has proposals on and the viewer can propose", async () => {
    mountInbox({ enabled: true, permissions: ["messaging.promote"] });
    expect(await screen.findByRole("tab", { name: "Chart proposals" })).toBeTruthy();
  });

  it("is absent when the tenant has proposals off, and ?tab=promotions falls back", async () => {
    const GET = mountInbox({
      enabled: false,
      permissions: ["messaging.promote"],
      url: "/?tab=promotions",
    });
    await waitFor(() =>
      expect(GET).toHaveBeenCalledWith("/api/v1/messaging/chart-promotions", expect.anything()),
    );
    await act(async () => {});
    expect(screen.queryByRole("tab", { name: "Chart proposals" })).toBeNull();
    expect(screen.getByRole("tab", { name: /^Notifications/, selected: true })).toBeTruthy();
  });

  it("is absent, and never read, without messaging.promote", async () => {
    const GET = mountInbox({ enabled: true, permissions: [], url: "/?tab=promotions" });
    await act(async () => {});
    expect(screen.queryByRole("tab", { name: "Chart proposals" })).toBeNull();
    expect(GET).not.toHaveBeenCalledWith("/api/v1/messaging/chart-promotions", expect.anything());
  });
});
