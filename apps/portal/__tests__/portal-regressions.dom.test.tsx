import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";
import { PortalPatientContext, usePortalPatient } from "../src/patient-context";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "33333333-3333-4333-8333-333333333333";
const VISIT_A = "44444444-4444-4444-8444-444444444444";
const VISIT_B = "55555555-5555-4555-8555-555555555555";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderAt(path: string, fetcher: (request: Request) => Promise<Response> | Response) {
  window.history.pushState({}, "", `/portal${path}`);
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      if (new URL(request.url).pathname === "/api/v1/portal/care-summary") {
        return json({ patient: { layLabel: "Synthetic patient" } });
      }
      return fetcher(request);
    },
  });
  return render(<PortalApp client={client} />);
}

describe("PR5 portal cross-screen regression checks", () => {
  it("recovers from a thrown patient-summary network failure without displaying stale PHI", async () => {
    let requests = 0;
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async () => {
        requests++;
        if (requests === 1) throw new Error("connection unavailable");
        return json({ patient: { layLabel: "Recovery patient" } });
      },
    });
    function Probe(): JSX.Element {
      const context = usePortalPatient();
      return (
        <div>
          <output>{context.loading ? "Loading" : context.summary?.patient.layLabel ?? context.error}</output>
          <button type="button" onClick={context.retry}>Retry patient information</button>
        </div>
      );
    }
    render(
      <ApiClientProvider client={client}>
        <PortalPatientContext patientId={A}><Probe /></PortalPatientContext>
      </ApiClientProvider>,
    );
    expect(await screen.findByText(/We could not load this right now/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry patient information" }));
    expect(await screen.findByText("Recovery patient")).toBeTruthy();
    expect(requests).toBe(2);
  });

  it("preserves an unsent message draft after refreshing its conversation", async () => {
    let historyRequests = 0;
    renderAt(`/p/${A}/messages`, (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/channel")) return json({ channelId: CHANNEL, lastReadPointer: null });
      if (path.endsWith("/history")) { historyRequests++; return json({ messages: [] }); }
      return json({}, 404);
    });
    await screen.findByText("No messages yet");
    const input = screen.getByRole("textbox", { name: /Message your care team/ }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Please call when convenient." } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh conversation" }));
    await waitFor(() => expect(historyRequests).toBe(2));
    expect(input.value).toBe("Please call when convenient.");
  });

  it("does not claim an acknowledged message send failed when the subsequent history refresh fails", async () => {
    let historyRequests = 0;
    let sends = 0;
    renderAt(`/p/${A}/messages`, (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/channel")) return json({ channelId: CHANNEL, lastReadPointer: null });
      if (path.endsWith("/history")) {
        historyRequests++;
        if (historyRequests > 1) throw new Error("history offline");
        return json({ messages: [] });
      }
      if (path.endsWith("/send")) { sends++; return json({ messageId: "accepted" }); }
      return json({}, 404);
    });
    await screen.findByText("No messages yet");
    const input = screen.getByRole("textbox", { name: /Message your care team/ }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "I have a question." } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByText(/Message sent/);
    expect(input.value).toBe("");
    expect(sends).toBe(1);
    expect(screen.queryByText(/could not confirm that your message was sent/i)).toBeNull();
  });

  it("handles a rejected Telehealth join without an indefinite loading state", async () => {
    let attempts = 0;
    renderAt(`/p/${A}/visits/${VISIT_A}/telehealth`, (request) => {
      if (new URL(request.url).pathname.endsWith("/join")) {
        attempts++;
        throw new Error("connection down");
      }
      return json({}, 404);
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Join visit" }));
    expect(await screen.findByText(/We couldn't connect to the video visit/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Join visit" })).not.toBeDisabled();
    expect(attempts).toBe(1);
  });

  it("does not retain a video ticket when navigating to another visit", async () => {
    renderAt(`/p/${A}/visits/${VISIT_A}/telehealth`, (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/join")) {
        return json({
          vendor: "daily_co",
          vendorJoinUrl: "https://sample.daily.co/private-room",
          vendorParticipantToken: "synthetic-token",
          tokenExpiresAt: "2099-01-01T00:00:00Z",
          recordingActive: false,
          audioOnlyFallbackActive: false,
        });
      }
      return json({}, 404);
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Join visit" }));
    expect(await screen.findByTitle("Video visit")).toBeTruthy();
    await act(async () => {
      window.history.pushState({}, "", `/portal/p/${B}/visits/${VISIT_B}/telehealth`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.queryByTitle("Video visit")).toBeNull();
    expect(screen.getByRole("heading", { name: "Before you join" })).toBeTruthy();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
});
