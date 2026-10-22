import { ACK_REQUESTS_FLAG_KEY, ROLE_SEND_FLAG_KEY } from "@chartwarden/types";
import { type ApiClient, ApiClientProvider, FeatureFlagProvider } from "@chartwarden/ui";
/**
 * Phase 5 gate: "offline never falsely delivered" (WP 5.1). A plain message with no connection waits in memory as "Not sent"
 * and is never shown as delivered; Urgent clinical, Needs a response and Message on-call role are never queued, so while the
 * browser reports no network they are aria-disabled with the telephone-procedure wording; a replay with the same
 * idempotency key leaves exactly one delivered row; axe is clean offline.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Session, SessionProvider } from "../../shell/session";
import { STORE_PATHS, calls, mountThread, sendButton } from "./attachments-test-support";
import { NEEDS_RESPONSE_LABEL } from "./needs-response";
import { NeedsResponseControl, useNeedsResponse } from "./needs-response-control";
import { RoleSendButton } from "./role-send-button";
import { ROLE_SEND_BUTTON_LABEL } from "./role-send-wording";
import { UrgentMessageButton } from "./urgent-message-button";
import { OPTIONS_PATH, optionsAnswer } from "./urgent-test-fixture";
import { NEEDS_CONNECTION_TEXT, URGENT_BUTTON_LABEL } from "./urgent-wording";

const MESSAGES = STORE_PATHS.messages;
const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  organizationName: "North Hospice",
  isAdmin: false,
  permissions: ["messaging.send", "messaging.urgent.send", "messaging.oncall.send"],
};

const setOnline = (online: boolean) => {
  Object.defineProperty(navigator, "onLine", { configurable: true, value: online });
  act(() => {
    window.dispatchEvent(new Event(online ? "online" : "offline"));
  });
};
const box = () => screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement;
const noAxe = { rules: { "color-contrast": { enabled: false } } };

function Controls(): JSX.Element {
  const needs = useNeedsResponse("c1", "care_team");
  return (
    <main>
      <form>
        <UrgentMessageButton channelId="c1" kind="care_team" />
        <RoleSendButton channelId="c1" kind="care_team" />
        <NeedsResponseControl state={needs} />
      </form>
    </main>
  );
}

function mountControls(post = vi.fn()) {
  const GET = vi.fn((path: string) =>
    Promise.resolve(
      path === OPTIONS_PATH ? optionsAnswer() : { error: {}, response: { status: 404 } },
    ),
  );
  render(
    <MemoryRouter>
      <ApiClientProvider client={{ GET, POST: post } as unknown as ApiClient}>
        <SessionProvider session={session}>
          <FeatureFlagProvider
            flags={{ [ACK_REQUESTS_FLAG_KEY]: true, [ROLE_SEND_FLAG_KEY]: true }}
          >
            <Controls />
          </FeatureFlagProvider>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return post;
}

afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("Phase 5 gate: offline never falsely delivered", () => {
  it("shows an offline plain send as Not sent and never as a delivered row", async () => {
    mountThread({
      POST: (path) =>
        path === MESSAGES ? Promise.reject(new TypeError("Failed to fetch")) : undefined,
    });
    await screen.findByRole("textbox", { name: "Message" });
    setOnline(false);
    fireEvent.change(box(), { target: { value: "hello team" } });
    await act(async () => {
      fireEvent.click(sendButton());
    });

    expect(await screen.findByText("Not sent")).toBeTruthy();
    expect(document.querySelectorAll("[data-pending-message]")).toHaveLength(1);
    expect(document.querySelector("[data-message-id]")).toBeNull();
  });

  it("disables Urgent clinical, Needs a response and Message on-call role with the telephone wording", async () => {
    const post = mountControls();
    const urgent = await screen.findByRole("button", { name: URGENT_BUTTON_LABEL });
    const role = await screen.findByRole("button", { name: ROLE_SEND_BUTTON_LABEL });
    const needs = await screen.findByRole("checkbox", { name: NEEDS_RESPONSE_LABEL });
    await waitFor(() => expect(urgent).toHaveProperty("disabled", false));

    setOnline(false);

    for (const control of [urgent, role, needs]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      const hint = (control.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" ");
      expect(hint).toContain(NEEDS_CONNECTION_TEXT);
    }
    fireEvent.click(urgent);
    fireEvent.click(role);
    fireEvent.click(needs);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect((needs as HTMLInputElement).checked).toBe(false);
    expect(post).not.toHaveBeenCalled();

    setOnline(true);
    expect(urgent.getAttribute("aria-disabled")).toBeNull();
    expect(role.getAttribute("aria-disabled")).toBeNull();
    expect(needs.getAttribute("aria-disabled")).toBeNull();
  });

  it("yields one delivered row when the same idempotency key is replayed", async () => {
    let attempts = 0;
    const { api } = mountThread({
      POST: (path) => {
        if (path !== MESSAGES) return undefined;
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : {
              data: { messageId: "m-9", channelId: "dm-1", createdAt: "2026-10-10T10:00:00.000Z" },
              error: undefined,
              response: { status: 200 },
            };
      },
    });
    await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(box(), { target: { value: "hello team" } });
    await act(async () => {
      fireEvent.click(sendButton());
    });
    await screen.findByText("Not sent");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry sending message" }));
    });

    await waitFor(() => expect(screen.queryByText("Not sent")).toBeNull());
    const [first, second] = calls(api, MESSAGES);
    expect(second![1].params.header["Idempotency-Key"]).toBe(
      first![1].params.header["Idempotency-Key"],
    );
    expect(document.querySelectorAll("[data-message-id]")).toHaveLength(1);
    expect(document.querySelectorAll("[data-pending-message]")).toHaveLength(0);
  });

  it("has no axe violations offline", async () => {
    mountControls();
    await screen.findByRole("button", { name: URGENT_BUTTON_LABEL });
    await screen.findByRole("button", { name: ROLE_SEND_BUTTON_LABEL });
    await screen.findByRole("checkbox", { name: NEEDS_RESPONSE_LABEL });
    setOnline(false);
    expect((await axe.run(document.body, noAxe)).violations).toEqual([]);
  });
});
