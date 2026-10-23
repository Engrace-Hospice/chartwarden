// M36 WP 6.6 (ADR-0096 D18) - the member banner: shown while the channel detail carries an active externalShare, gone when it does not, refreshed once a minute
// (and paused while the tab is hidden), kept through a transient failure but cleared on a 403 or 404, never showing another channel's banner, a polite status
// region, and costing ONE request per thread open (it shares the channel-detail read with the presence hook) and one per minute after.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_SHARE_BANNER_REFRESH_MS, ExternalShareBanner } from "./external-share-banner";
import { readChannelDetail } from "./use-channel-detail";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
type Reply = { data?: unknown; response?: { status: number } };
type Step = () => Reply | Promise<Reply>;

function client(steps: Step[]) {
  let n = 0;
  const GET = vi.fn(async (): Promise<Reply> => {
    const step = steps[Math.min(n, steps.length - 1)];
    n += 1;
    return (await step?.()) ?? {};
  });
  return { GET, api: { GET } as unknown as ApiClient };
}

function mount(steps: Step[], channelId = CHANNEL) {
  const c = client(steps);
  const view = render(
    <ApiClientProvider client={c.api}>
      <main>
        <ExternalShareBanner channelId={channelId} />
      </main>
    </ApiClientProvider>,
  );
  return { ...c, ...view };
}

const detail = (externalShare?: unknown): Reply => ({
  data: { channelId: CHANNEL, members: [], ...(externalShare ? { externalShare } : {}) },
  response: { status: 200 },
});
const active = (expiresAt = "2026-10-30T10:00:00.000Z") =>
  detail({ active: true, partnerKind: "pharmacy", expiresAt });
const status = (code: number): Reply => ({ response: { status: code } });

const setHidden = (hidden: boolean): void => {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
};
const tick = async (ms: number): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  setHidden(false);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setHidden(false);
});

describe("ExternalShareBanner", () => {
  it("shows a persistent status line with the end date while access has been granted", async () => {
    mount([() => active()]);
    const banner = await screen.findByTestId("external-share-banner");
    expect(banner.tagName).toBe("OUTPUT");
    expect(banner.textContent).toMatch(
      /An outside partner has been given read access to new messages in this conversation until /,
    );
    expect(banner.textContent).toContain(new Date("2026-10-30T10:00:00.000Z").toLocaleString());
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
  });

  it("renders nothing when the channel has no active share", async () => {
    const { GET } = mount([() => detail()]);
    await act(async () => undefined);
    expect(GET).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("re-reads every minute and drops the banner once the share is revoked or expired", async () => {
    const { GET } = mount([() => active(), () => detail()]);
    await screen.findByTestId("external-share-banner");
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS + 10);
    expect(GET).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("keeps the banner through a network error and a server error, and clears it on a 403 or a 404", async () => {
    const { GET } = mount([
      () => active(),
      () => {
        throw new Error("offline");
      },
      () => status(500),
      () => status(404),
    ]);
    await screen.findByTestId("external-share-banner");
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS + 10); // network error
    expect(screen.getByTestId("external-share-banner")).toBeTruthy();
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS); // 500
    expect(screen.getByTestId("external-share-banner")).toBeTruthy();
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS); // 404: the channel or the share is gone for this reader
    expect(GET).toHaveBeenCalledTimes(4);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("clears on a 403 as well", async () => {
    mount([() => active(), () => status(403)]);
    await screen.findByTestId("external-share-banner");
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS + 10);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("makes no request while the tab is hidden and reads again, once, when it comes back", async () => {
    const { GET } = mount([() => active()]);
    await screen.findByTestId("external-share-banner");
    expect(GET).toHaveBeenCalledTimes(1);
    setHidden(true);
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS * 3);
    expect(GET).toHaveBeenCalledTimes(1);
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(GET).toHaveBeenCalledTimes(2);
  });

  it("never shows one channel's banner on another: switching channels shows nothing until the new read lands", async () => {
    const first = client([() => active()]);
    const second = client([() => detail()]);
    const view = render(
      <ApiClientProvider client={first.api}>
        <ExternalShareBanner channelId={CHANNEL} />
      </ApiClientProvider>,
    );
    await screen.findByTestId("external-share-banner");
    view.rerender(
      <ApiClientProvider client={second.api}>
        <ExternalShareBanner channelId={OTHER} />
      </ApiClientProvider>,
    );
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
    await act(async () => undefined);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("costs ONE request per thread open even when the presence hook asks for the same channel detail, and one per minute after", async () => {
    const c = client([
      () => detail({ active: true, partnerKind: "dme", expiresAt: "2026-10-30T10:00:00.000Z" }),
    ]);
    render(
      <ApiClientProvider client={c.api}>
        <main>
          <ExternalShareBanner channelId={CHANNEL} />
        </main>
      </ApiClientProvider>,
    );
    // What use-presence does on mount, at the same moment:
    const fromPresence = await readChannelDetail(c.api, CHANNEL);
    expect(fromPresence.failed).toBe(false);
    await screen.findByTestId("external-share-banner");
    expect(c.GET).toHaveBeenCalledTimes(1);
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS + 10);
    expect(c.GET).toHaveBeenCalledTimes(2);
    await tick(EXTERNAL_SHARE_BANNER_REFRESH_MS);
    expect(c.GET).toHaveBeenCalledTimes(3);
  });

  it("has no axe violations", async () => {
    const { container } = mount([() => active()]);
    await screen.findByTestId("external-share-banner");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});

describe("readChannelDetail", () => {
  it("shares an in-flight read, retries after a failure, and re-reads once the last read is no longer fresh", async () => {
    let calls = 0;
    const GET = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("offline");
      return detail();
    });
    const api = { GET } as unknown as ApiClient;
    const [a, b] = await Promise.all([
      readChannelDetail(api, CHANNEL),
      readChannelDetail(api, CHANNEL),
    ]);
    expect(GET).toHaveBeenCalledTimes(1);
    expect(a.failed && b.failed).toBe(true);
    const c = await readChannelDetail(api, CHANNEL); // the failure was forgotten: this retries
    expect(c.failed).toBe(false);
    expect(GET).toHaveBeenCalledTimes(2);
    await readChannelDetail(api, CHANNEL);
    expect(GET).toHaveBeenCalledTimes(2); // fresh: shared
    await tick(10_000);
    await readChannelDetail(api, CHANNEL);
    expect(GET).toHaveBeenCalledTimes(3);
  });
});
