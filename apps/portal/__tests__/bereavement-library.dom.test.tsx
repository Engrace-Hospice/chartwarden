import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, within } from "@testing-library/react";
// ADR-0109 D10 PR 3 — the grief library on the portal bereavement page: published items, opened through a freshly minted link (a video plays
// in a <video controls> on the page), the transcript offered only when there is one, an empty state, a failure with a retry.
import { describe, expect, it } from "vitest";
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
});
