/**
 * WP 2.12 presence/typing in the web client: nothing rendered or requested while the tenant flag is off, the online
 * list and the polite typing indicator when on, no requests from a hidden tab, and a permanent stop on 403.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@wardenx/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceMembers, TypingIndicator } from "./presence-panel";
import { PRESENCE_FLAG_KEY, TYPING_THROTTLE_MS } from "./presence-utils";
import { usePresence } from "./use-presence";

const PRESENCE_PATH = "/api/v1/messaging/channels/{id}/presence";
const ok = (data?: unknown) => ({ data, error: undefined, response: { status: data ? 200 : 204 } });
const refused = {
  data: undefined,
  error: { error: { code: "PRESENCE_DISABLED" } },
  response: { status: 403 },
};

function makeApi(opts: { presence?: Record<string, unknown>; postResult?: unknown } = {}) {
  return {
    GET: vi.fn(async (path: string) =>
      path === PRESENCE_PATH
        ? (opts.presence ?? ok({ present: ["me", "alex"], typing: ["alex"] }))
        : ok({
            members: [
              { userId: "me", displayName: "Me", role: "member", source: "manual" },
              { userId: "alex", displayName: "Alex", role: "member", source: "manual" },
            ],
          }),
    ),
    POST: vi.fn(async () => opts.postResult ?? ok()),
  };
}

function Harness({ draft = "" }: { draft?: string }) {
  const presence = usePresence({ channelId: "ch-1", meId: "me", draft });
  return (
    <>
      <PresenceMembers presence={presence} />
      <TypingIndicator presence={presence} />
    </>
  );
}

const mount = (api: ReturnType<typeof makeApi>, flag: boolean, draft = "") =>
  render(
    <ApiClientProvider client={api as unknown as ApiClient}>
      <FeatureFlagProvider flags={{ [PRESENCE_FLAG_KEY]: flag }}>
        <Harness draft={draft} />
      </FeatureFlagProvider>
    </ApiClientProvider>,
  );

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

let hidden = false;
beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("presence (WP 2.12)", () => {
  it("renders nothing and requests nothing while the tenant flag is off", async () => {
    const api = makeApi();
    const { container } = mount(api, false, "typing away");
    await tick(60_000);
    expect(container.innerHTML).toBe("");
    expect(api.GET).not.toHaveBeenCalled();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("lists who else is online and announces who is typing in a polite live region", async () => {
    mount(makeApi(), true);
    await tick(10);
    expect(screen.getByRole("heading", { name: "Online now" })).toBeTruthy();
    expect(screen.getByText("Alex")).toBeTruthy();
    expect(screen.getByText("(online)")).toBeTruthy(); // text status, not colour alone
    expect(screen.queryByText("Me")).toBeNull(); // not the viewer
    const live = screen.getByText("Alex is typing…");
    expect(live.tagName).toBe("OUTPUT");
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("keeps an empty polite live region mounted when nobody is typing", async () => {
    mount(makeApi({ presence: ok({ present: ["me"], typing: [] }) }), true);
    await tick(10);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.queryByRole("heading", { name: "Online now" })).toBeNull();
  });

  it("sends a heartbeat and polls, then sends no request while the tab is hidden", async () => {
    const api = makeApi();
    mount(api, true);
    await tick(10);
    expect(api.POST).toHaveBeenCalledTimes(1);
    expect(api.POST).toHaveBeenCalledWith(PRESENCE_PATH, expect.objectContaining({ body: {} }));
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    const posts = api.POST.mock.calls.length;
    const gets = api.GET.mock.calls.length;
    await tick(5 * 60_000);
    expect(api.POST.mock.calls.length).toBe(posts);
    expect(api.GET.mock.calls.length).toBe(gets);
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await tick(10);
    expect(api.POST.mock.calls.length).toBe(posts + 1);
  });

  it("sends the typing marker when the composer has text, at most once per throttle window", async () => {
    const api = makeApi();
    const view = mount(api, true, "");
    await tick(10);
    const typingCalls = () =>
      api.POST.mock.calls.filter(
        (call) => (call as unknown as [string, { body: { typing?: boolean } }])[1].body.typing,
      ).length;
    expect(typingCalls()).toBe(0);
    view.rerender(
      <ApiClientProvider client={api as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [PRESENCE_FLAG_KEY]: true }}>
          <Harness draft="hel" />
        </FeatureFlagProvider>
      </ApiClientProvider>,
    );
    await tick(10);
    expect(typingCalls()).toBe(1);
    view.rerender(
      <ApiClientProvider client={api as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [PRESENCE_FLAG_KEY]: true }}>
          <Harness draft="hello" />
        </FeatureFlagProvider>
      </ApiClientProvider>,
    );
    await tick(10);
    expect(typingCalls()).toBe(1); // inside the window
    await tick(TYPING_THROTTLE_MS);
    view.rerender(
      <ApiClientProvider client={api as unknown as ApiClient}>
        <FeatureFlagProvider flags={{ [PRESENCE_FLAG_KEY]: true }}>
          <Harness draft="hello w" />
        </FeatureFlagProvider>
      </ApiClientProvider>,
    );
    await tick(10);
    expect(typingCalls()).toBe(2);
  });

  it("stops for good, and renders nothing, once the server answers 403", async () => {
    const api = makeApi({ presence: refused, postResult: refused });
    const { container } = mount(api, true);
    await tick(10);
    const posts = api.POST.mock.calls.length;
    const gets = api.GET.mock.calls.length;
    await tick(10 * 60_000);
    expect(api.POST.mock.calls.length).toBe(posts);
    expect(api.GET.mock.calls.length).toBe(gets);
    expect(container.innerHTML).toBe("");
  });

  it("keeps retrying (backs off) on a 503 instead of halting", async () => {
    const unavailable = {
      data: undefined,
      error: { error: { code: "DEGRADED" } },
      response: { status: 503 },
    };
    const api = makeApi({ presence: unavailable, postResult: unavailable });
    mount(api, true);
    await tick(10);
    const gets = api.GET.mock.calls.length;
    await tick(10 * 60_000);
    expect(api.GET.mock.calls.length).toBeGreaterThan(gets);
  });
});
