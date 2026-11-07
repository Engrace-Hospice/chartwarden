import { createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// ADR-0109 D10 PR 3 — the grief library on the portal bereavement page: published items, opened through a freshly minted link (a video plays
// in a <video controls> on the page), the transcript offered only when there is one, an empty state, a failure with a retry.
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const P1 = "11111111-1111-4111-8111-111111111111";
const READING = "44444444-4444-4444-8444-444444444444";
const VIDEO = "55555555-5555-4555-8555-555555555555";
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

const reading = {
  itemId: READING,
  title: "When the Holidays Feel Hard",
  summary: "Gentle ideas for the first holiday season.",
  category: "holidays_and_anniversaries",
  kind: "pdf",
  hasTranscript: false,
};
const video = {
  itemId: VIDEO,
  title: "Talking With Children About Loss",
  summary: null,
  category: "children_and_teens",
  kind: "video",
  hasTranscript: true,
};

function renderPage(library: (path: string, query: string) => Response | Promise<Response>) {
  window.history.pushState({}, "", `/portal/p/${P1}/bereavement`);
  const gets: string[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const url = new URL(req.url);
      if (url.pathname === "/api/v1/portal/care-summary")
        return json({ patient: { layLabel: "Example patient" } });
      if (url.pathname.startsWith("/api/v1/portal/bereavement/library")) {
        gets.push(`${url.pathname}${url.search}`);
        return library(url.pathname, url.search);
      }
      if (url.pathname.endsWith("/program") || url.pathname.endsWith("/resources"))
        return json({ items: [] });
      return json({}, 404);
    },
  });
  render(<PortalApp client={client} />);
  return gets;
}
const section = () => screen.getByRole("region", { name: "Grief library" });

describe("portal grief library", () => {
  it("lists the published items with their category", async () => {
    renderPage(() => json({ items: [reading, video] }));
    expect(
      await screen.findByRole("heading", { name: "When the Holidays Feel Hard" }),
    ).toBeTruthy();
    expect(within(section()).getByText("Holidays and anniversaries · Reading")).toBeTruthy();
    expect(within(section()).getByText("Children and teens · Video")).toBeTruthy();
    // a transcript is offered only for the item that has one
    expect(within(section()).getAllByRole("button", { name: "Read the transcript" })).toHaveLength(
      1,
    );
  });

  it("says plainly that the library is empty", async () => {
    renderPage(() => json({ items: [] }));
    expect(await screen.findByText("Nothing in the library yet")).toBeTruthy();
  });

  it("says a failure plainly with a retry", async () => {
    let reads = 0;
    renderPage(() => {
      reads += 1;
      return reads === 1 ? json({}, 500) : json({ items: [reading] });
    });
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "When the Holidays Feel Hard" }),
    ).toBeTruthy();
  });

  it("opens a reading through a minted link in a new tab", async () => {
    const gets = renderPage((path) =>
      path.endsWith("/url")
        ? json({ url: "https://files.example.org/r1?sig=abc", expiresAt: "2026-11-06T22:00:00Z" })
        : json({ items: [reading] }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open When the Holidays Feel Hard" }),
    );
    const link = await screen.findByRole("link", { name: /Open When the Holidays Feel Hard/ });
    expect(link.getAttribute("href")).toBe("https://files.example.org/r1?sig=abc");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(gets).toContain(`/api/v1/portal/bereavement/library/${READING}/url?part=document`);
  });

  it("plays a video in a player on the page, and offers its transcript", async () => {
    const gets = renderPage((path, query) =>
      path.endsWith("/url")
        ? json({
            url: `https://files.example.org/${query.includes("transcript") ? "t" : "v"}1`,
            expiresAt: "2026-11-06T22:00:00Z",
          })
        : json({ items: [video] }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Watch Talking With Children About Loss" }),
    );
    const player = (await within(section()).findByLabelText(
      "Talking With Children About Loss",
    )) as HTMLVideoElement;
    expect(player.tagName).toBe("VIDEO");
    expect(player.controls).toBe(true);
    expect(player.getAttribute("src")).toBe("https://files.example.org/v1");
    fireEvent.click(within(section()).getByRole("button", { name: "Read the transcript" }));
    const link = await screen.findByRole("link", { name: /Open the transcript/ });
    expect(link.getAttribute("href")).toBe("https://files.example.org/t1");
    expect(gets).toContain(`/api/v1/portal/bereavement/library/${VIDEO}/url?part=transcript`);
  });

  it("refuses a link that is not secure", async () => {
    renderPage((path) =>
      path.endsWith("/url")
        ? json({ url: "javascript:alert(1)", expiresAt: "2026-11-06T22:00:00Z" })
        : json({ items: [reading] }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open When the Holidays Feel Hard" }),
    );
    expect((await within(section()).findByRole("alert")).textContent).toContain(
      "We couldn't open this",
    );
    expect(screen.queryByRole("link", { name: /Open When the Holidays Feel Hard/ })).toBeNull();
  });

  it("moves focus to the new link after Open, and to the player after Watch", async () => {
    renderPage((path) =>
      path.endsWith("/url")
        ? json({ url: "https://files.example.org/x1", expiresAt: "2099-01-01T00:00:00Z" })
        : json({ items: [reading, video] }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Open When the Holidays Feel Hard" }),
    );
    const link = await screen.findByRole("link", { name: /Open When the Holidays Feel Hard/ });
    await waitFor(() => expect(document.activeElement).toBe(link));
    fireEvent.click(screen.getByRole("button", { name: "Watch Talking With Children About Loss" }));
    const player = await within(section()).findByLabelText("Talking With Children About Loss");
    await waitFor(() => expect(document.activeElement).toBe(player));
  });

  it("drops a link once it expires, and the next Open mints a fresh one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let minted = 0;
    renderPage((path) => {
      if (!path.endsWith("/url")) return json({ items: [reading] });
      minted += 1;
      return json({
        url: `https://files.example.org/r${minted}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Open When the Holidays Feel Hard" }),
    );
    expect(
      await screen.findByRole("link", { name: /Open When the Holidays Feel Hard \(new tab\)/ }),
    ).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 1);
    });
    expect(screen.queryByRole("link", { name: /Open When the Holidays Feel Hard/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open When the Holidays Feel Hard" }));
    const fresh = await screen.findByRole("link", { name: /Open When the Holidays Feel Hard/ });
    expect(fresh.getAttribute("href")).toBe("https://files.example.org/r2");
  });

  it("renews a video whose link failed mid-way, resumes where it was and says so", async () => {
    let minted = 0;
    const gets = renderPage((path) => {
      if (!path.endsWith("/url")) return json({ items: [video] });
      minted += 1;
      return json({
        url: `https://files.example.org/v${minted}`,
        expiresAt: "2099-01-01T00:00:00Z",
      });
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Watch Talking With Children About Loss" }),
    );
    const player = (await within(section()).findByLabelText(
      "Talking With Children About Loss",
    )) as HTMLVideoElement;
    let position = 42;
    Object.defineProperty(player, "currentTime", {
      configurable: true,
      get: () => position,
      set: (v: number) => {
        position = v;
      },
    });
    fireEvent.error(player);
    await waitFor(() => expect(player.getAttribute("src")).toBe("https://files.example.org/v2"));
    position = 0; // a new source starts at the beginning until it is told otherwise
    fireEvent.loadedMetadata(player);
    expect(position).toBe(42);
    expect(within(section()).getByRole("status").textContent).toContain(
      "renewed it and picked up where you left off",
    );
    expect(gets.filter((g) => g.endsWith("part=document"))).toHaveLength(2);
  });
});

afterEach(() => {
  vi.useRealTimers();
});
