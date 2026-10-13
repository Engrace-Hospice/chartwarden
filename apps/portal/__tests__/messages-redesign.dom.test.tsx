import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@wardenx/ui";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_A = "11111111-1111-4111-8111-111111111111";
const PATIENT_B = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const incoming = {
  messageId: "44444444-4444-4444-8444-444444444444",
  body: "Hello <script>not markup</script>\nHow can we help?",
  sentAt: "2026-10-12T14:00:00.000Z",
  direction: "incoming",
  senderLabel: "Care team",
};
const outgoing = {
  messageId: "55555555-5555-4555-8555-555555555555",
  body: "Thank you.",
  sentAt: "2026-10-12T15:00:00.000Z",
  direction: "outgoing",
  senderLabel: "You",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderMessages(fetcher: (request: Request) => Response | Promise<Response>) {
  window.history.pushState({}, "", `/p/${PATIENT_A}/messages`);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).pathname === "/api/v1/portal/care-summary") return json({}, 404);
      return fetcher(request);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("patient messaging redesign", () => {
  it("renders a safe chronological conversation and an accessible composer", async () => {
    renderMessages((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/channel"))
        return json({ channelId: CHANNEL, lastReadPointer: null });
      if (url.pathname.endsWith("/history")) return json({ messages: [outgoing, incoming] });
      return json({}, 404);
    });
    const timeline = await screen.findByRole("list", { name: "Conversation with your care team" });
    expect(timeline.textContent?.indexOf(incoming.body)).toBeLessThan(
      timeline.textContent?.indexOf(outgoing.body) ?? 0,
    );
    expect(
      screen.getByText("<script>not markup</script>", { exact: false }).querySelector("script"),
    ).toBeNull();
    expect(screen.getByText("Care team")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("distinguishes an empty conversation from an unavailable channel", async () => {
    const view = renderMessages((request) =>
      new URL(request.url).pathname.endsWith("/channel")
        ? json({ channelId: CHANNEL, lastReadPointer: null })
        : json({ messages: [] }),
    );
    expect(await screen.findByText("No messages yet")).toBeTruthy();
    view.unmount();
    renderMessages((request) =>
      new URL(request.url).pathname.endsWith("/channel")
        ? json({ channelId: "", lastReadPointer: null })
        : json({ messages: [] }),
    );
    expect(await screen.findByText("Secure messaging isn't available yet.")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Message your care team" })).toBeNull();
  });

  it("shows a history failure as an error and retries only after user action", async () => {
    let attempts = 0;
    renderMessages((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/channel")) return json({ channelId: CHANNEL, lastReadPointer: null });
      if (path.endsWith("/history")) {
        attempts += 1;
        return attempts === 1 ? json({}, 500) : json({ messages: [incoming] });
      }
      return json({}, 404);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Hello <script>not markup<\/script>/)).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("preserves a draft after failed or ambiguous sends and prevents duplicate submission", async () => {
    let posts = 0;
    const paths: string[] = [];
    renderMessages((request) => {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith("/channel")) return json({ channelId: CHANNEL, lastReadPointer: null });
      if (path.endsWith("/history")) return json({ messages: [] });
      if (path.endsWith("/send")) {
        posts += 1;
        return json({}, 500);
      }
      return json({}, 404);
    });
    await waitFor(() => expect(paths).toContain("/api/v1/portal/messages/history"));
    const textbox = await screen.findByRole("textbox", { name: /Message your care team/ });
    fireEvent.change(textbox, { target: { value: "Please call when available." } });
    const send = screen.getByRole("button", { name: "Send message" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(await screen.findByText(/could not confirm/i)).toBeTruthy();
    expect((textbox as HTMLTextAreaElement).value).toBe("Please call when available.");
    expect(posts).toBe(1);
  });

  it("clears patient-scoped history and draft while stale requests are pending", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    let historyCalls = 0;
    renderMessages((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/channel")) return json({ channelId: CHANNEL, lastReadPointer: null });
      if (path.endsWith("/history")) {
        historyCalls += 1;
        if (historyCalls === 1)
          return new Promise<Response>((resolve) => {
            resolveOld = resolve;
          });
        return json({ messages: [{ ...incoming, body: "New patient conversation" }] });
      }
      return json({}, 404);
    });
    await waitFor(() => expect(historyCalls).toBe(1));
    window.history.pushState({}, "", `/p/${PATIENT_B}/messages`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByText("New patient conversation")).toBeTruthy();
    await act(async () =>
      resolveOld?.(json({ messages: [{ ...incoming, body: "Old patient conversation" }] })),
    );
    expect(screen.queryByText("Old patient conversation")).toBeNull();
  });
});
