import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CHANNEL_ID = "22222222-2222-4222-8222-222222222222";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderPortal(historyStatus = 200) {
  window.history.replaceState({}, "", `/portal/p/${PATIENT_ID}/messages`);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const path = new URL(request.url).pathname;
      if (path.endsWith("/care-summary"))
        return json({ patient: { layLabel: "Synthetic patient" } });
      if (path.endsWith("/messages/channel"))
        return json({ channelId: CHANNEL_ID, lastReadPointer: null });
      if (path.endsWith("/messages/history"))
        return json(historyStatus === 200 ? { messages: [] } : {}, historyStatus);
      if (path.endsWith("/messages/send")) return json({});
      return json({}, 404);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("PR6.1 — bounded message workspace", () => {
  it("activates a route-scoped layout and keeps the composer after the timeline", async () => {
    const view = renderPortal();
    expect(await screen.findByText("No messages yet")).toBeTruthy();
    const shell = view.container.querySelector(".wx-portal-shell");
    expect(shell?.classList.contains("wx-portal-shell--messages")).toBe(true);
    const page = view.container.querySelector(".wx-portal-message-page");
    expect(page).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Messages" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Conversations" })).toBeTruthy();
    expect(screen.getByRole("searchbox", { name: "Search conversations" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Your care team/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const conversation = view.container.querySelector(".wx-portal-messaging");
    const timeline = conversation?.querySelector(".wx-portal-conversation-body");
    const composer = conversation?.querySelector(".wx-portal-message-composer");
    expect(timeline).toBeTruthy();
    expect(composer).toBeTruthy();
    expect(
      (timeline?.compareDocumentPosition(composer as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Message your care team" }).getAttribute("rows"),
    ).toBe("3");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("filters the available conversation without affecting the active thread", async () => {
    renderPortal();
    await screen.findByText("No messages yet");
    const search = screen.getByRole("searchbox", { name: "Search conversations" });
    fireEvent.change(search, { target: { value: "billing" } });
    expect(screen.getByText("No conversations match your search.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your care team" })).toBeTruthy();
    fireEvent.change(search, { target: { value: "care" } });
    expect(screen.getByRole("button", { name: /Your care team/ })).toBeTruthy();
  });

  it("still exposes a draft and Send when history loading fails", async () => {
    renderPortal(500);
    expect(await screen.findByText("Messages are unavailable")).toBeTruthy();
    const input = screen.getByRole("textbox", {
      name: "Message your care team",
    }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Please contact me when available." } });
    expect(input.value).toBe("Please contact me when available.");
    expect(screen.getByRole("button", { name: "Send message" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/Do not use portal messages for emergencies/)).toBeTruthy();
  });

  it("keeps the message-only shell class off other routes", async () => {
    const view = renderPortal();
    await screen.findByText("No messages yet");
    fireEvent.click(screen.getAllByRole("link", { name: "Home" })[0]!);
    await waitFor(() =>
      expect(
        view.container
          .querySelector(".wx-portal-shell")
          ?.classList.contains("wx-portal-shell--messages"),
      ).toBe(false),
    );
  });
});
