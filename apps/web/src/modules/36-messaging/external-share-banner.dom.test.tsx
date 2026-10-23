// M36 WP 6.6 (ADR-0096 D18) - the member banner: shown while the channel detail carries an active externalShare, gone when it does not, refreshed on a
// timer so a revoke is not shown as live for long, a polite status region, no GET after unmount.
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_SHARE_BANNER_REFRESH_MS, ExternalShareBanner } from "./external-share-banner";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
type Reply = { data?: unknown; response?: { status: number } };

function mount(replies: Array<() => Reply | Promise<Reply>>) {
  let n = 0;
  const GET = vi.fn(async (): Promise<Reply> => {
    const reply = replies[Math.min(n, replies.length - 1)];
    n += 1;
    return (await reply?.()) ?? {};
  });
  const view = render(
    <ApiClientProvider client={{ GET } as unknown as ApiClient}>
      <main>
        <ExternalShareBanner channelId={CHANNEL} />
      </main>
    </ApiClientProvider>,
  );
  return { GET, ...view };
}

const detail = (externalShare?: unknown): Reply => ({
  data: { channelId: CHANNEL, members: [], ...(externalShare ? { externalShare } : {}) },
  response: { status: 200 },
});
const active = (expiresAt = "2026-10-30T10:00:00.000Z") =>
  detail({ active: true, partnerKind: "pharmacy", expiresAt });

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ExternalShareBanner", () => {
  it("shows a persistent status line with the end date while a share is active", async () => {
    mount([() => active()]);
    const banner = await screen.findByTestId("external-share-banner");
    expect(banner.tagName).toBe("OUTPUT");
    expect(banner.textContent).toMatch(
      /An outside partner can read new messages in this conversation until /,
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

  it("renders nothing for a failed or empty read (best effort, no crash)", async () => {
    mount([() => ({ response: { status: 500 } })]);
    await act(async () => undefined);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("re-reads every minute and drops the banner once the share is revoked or expired", async () => {
    const { GET } = mount([() => active(), () => detail()]);
    await screen.findByTestId("external-share-banner");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXTERNAL_SHARE_BANNER_REFRESH_MS + 10);
    });
    expect(GET).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("external-share-banner")).toBeNull();
  });

  it("stops reading after unmount", async () => {
    const { GET, unmount } = mount([() => active()]);
    await screen.findByTestId("external-share-banner");
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EXTERNAL_SHARE_BANNER_REFRESH_MS * 3);
    });
    expect(GET).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    const { container } = mount([() => active()]);
    await screen.findByTestId("external-share-banner");
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });
});
