import { AFTERHOURS_TRIAGE_LINE_TEXT, type AckRequestDto } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
// M36 ADR-0082 slice S5 - the after-hours triage line under a role-addressed request: closed-map text with an icon, "Triage call not confirmed"
// as a visible state, withheld wording, nothing for a message with no role / a flag-off tenant / a failed read, and no axe violations.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AckForMessage, AckRequestsProvider } from "./ack-request-card";

const LIST = "/api/v1/messaging/channels/{id}/escalations";
const LINES = "/api/v1/messaging/channels/{id}/afterhours-triage";
const request = (over: Partial<AckRequestDto> = {}): AckRequestDto => ({
  id: "r-1",
  message_id: "m-1",
  channel_id: "c-1",
  patient_id: "p-1",
  ack_class: "urgent",
  addressed_role: "rn",
  status: "pending",
  requester_user_id: "u-1",
  assigned_user_id: "u-2",
  requested_at: "2099-10-15T12:00:00.000Z",
  window_started_at: "2099-10-15T12:00:00.000Z",
  deadline_at: "2099-10-15T13:00:00.000Z",
  current_tier: 0,
  acknowledged_at: null,
  acknowledged_by_user_id: null,
  resolved_at: null,
  cancelled_at: null,
  version: 0,
  viewer_actions: { can_acknowledge: false, can_reassign: false, can_resolve: false },
  ...over,
});

function mount(opts: { requests?: AckRequestDto[]; lines?: () => unknown }) {
  const GET = vi.fn((path: string) => {
    if (path === LIST)
      return Promise.resolve({
        data: { requests: opts.requests ?? [request()] },
        response: { status: 200 },
      });
    if (path === LINES)
      return Promise.resolve(opts.lines?.() ?? { error: {}, response: { status: 404 } });
    return Promise.resolve({ error: {}, response: { status: 404 } });
  });
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: vi.fn() } as unknown as ApiClient}>
        <main>
          <AckRequestsProvider channelId="c-1" enabled>
            <AckForMessage messageId="m-1" />
          </AckRequestsProvider>
        </main>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return GET;
}
const answer = (state: string, text = "") => ({
  data: { lines: [{ message_id: "m-1", state, text }] },
  response: { status: 200 },
});

afterEach(() => cleanup());
describe("after-hours triage line", () => {
  it.each(["not_confirmed", "opened", "coalesced", "no_coverage", "withheld"] as const)(
    "shows the closed-map text for %s with an icon",
    async (state) => {
      mount({ lines: () => answer(state) });
      const text = await screen.findByText(AFTERHOURS_TRIAGE_LINE_TEXT[state]);
      const line = text.closest("[data-afterhours-line]");
      expect(line?.getAttribute("data-afterhours-line")).toBe(state);
      expect(line?.querySelector("svg")).toBeTruthy();
    },
  );

  it("says 'Triage call not confirmed' in words and has no axe violations", async () => {
    mount({ lines: () => answer("not_confirmed") });
    await screen.findByText("Triage call not confirmed");
    expect(
      (await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } }))
        .violations,
    ).toEqual([]);
  });

  it("asks only for role-addressed messages, and not at all when there are none", async () => {
    const none = mount({ requests: [request({ addressed_role: null })] });
    await screen.findByText(/Waiting|Pending|waiting/i);
    expect(none.mock.calls.some(([p]) => p === LINES)).toBe(false);
  });

  it.each([
    ["the flag is off (404)", () => ({ error: {}, response: { status: 404 } })],
    ["the read fails", () => Promise.reject(new Error("offline"))],
  ])("shows nothing when %s", async (_n, lines) => {
    const GET = mount({ lines: lines as () => unknown });
    await waitFor(() => expect(GET.mock.calls.some(([p]) => p === LINES)).toBe(true));
    expect(document.querySelector("[data-afterhours-line]")).toBeNull();
  });
});
