// WP 4.8 (ADR-0075) - the real shell and the real landing screen, a stubbed API.
//   signed out : nothing is rendered or asked of the API; the visitor goes to sign-in and only the opaque id is remembered
//   signed in  : one resolve call, then the thread route with the ids the server named; the /n/ entry is replaced
//   any failure: the SAME generic page (404, 403, 500, a network error, a malformed id) with no id-derived text anywhere
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@wardenx/ui";
import axe from "axe-core";
import { type JSX, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../shell/app";
import { takePendingNotificationLink } from "../../shell/pending-deep-link";
import { createScreenRegistry } from "../../shell/screen-registry";
import type { Session } from "../../shell/session";
import { systemScreens } from "../../shell/system-pages";
import {
  LANDING_FAILED_ACTION,
  LANDING_FAILED_HEADLINE,
  LANDING_GONE_ACTION,
  LANDING_GONE_HEADLINE,
  LANDING_OPENING_TEXT,
  NotificationLanding,
} from "./notification-landing";

const DELIVERY = "9b1f0c2e-aaaa-4bbb-8ccc-0123456789ab";
const CHANNEL = "11111111-2222-4333-8444-555555555555";
const MESSAGE = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const SESSION: Session = {
  userId: "u-1",
  organizationId: "11111111-1111-4111-8111-111111111111",
  membershipId: "22222222-2222-4222-8222-222222222222",
  displayName: "Landing Test",
  organizationName: "Test Org",
  roles: [],
  isAdmin: false,
  permissions: ["messaging.read"],
};

const Stub = (label: string) => (): JSX.Element => <p>{label}</p>;

function mount(path: string, session: Session | null, answer?: () => Response, strict = false) {
  window.history.pushState({}, "", path);
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register({
    moduleId: 36,
    slug: "36-messaging",
    screens: [
      {
        id: "messaging.notification-landing",
        path: "/n/:id",
        title: "n",
        screen: NotificationLanding,
      },
      { id: "stub.thread", path: "/messaging", title: "Messaging", screen: Stub("THREAD SCREEN") },
      {
        id: "stub.login",
        path: "/login",
        title: "Login",
        chrome: false,
        screen: Stub("SIGN IN SCREEN"),
      },
    ],
  });
  const calls: string[] = [];
  const respond = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const resolveAnswer: () => Response =
    answer ??
    (() => respond(200, { channel_id: CHANNEL, message_id: MESSAGE, ack_request_id: null }));
  const fetchStub = async (input: Request | string | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.includes("/auth/context")) return respond(401, { error: { code: "UNAUTHORIZED" } });
    if (url.includes("/deliveries/")) return resolveAnswer();
    return respond(404, { error: { code: "NOT_FOUND" } });
  };
  const shell = (
    <AppShell
      registry={registry}
      client={createApiClient({ baseUrl: "http://localhost", fetch: fetchStub })}
      session={session}
    />
  );
  const view = render(strict ? <StrictMode>{shell}</StrictMode> : shell);
  return { ...view, calls };
}

const where = (): string => `${window.location.pathname}${window.location.search}`;
const resolveCalls = (calls: string[]) => calls.filter((c) => c.includes("/deliveries/"));

beforeEach(() => {
  window.sessionStorage.clear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

describe("signed out", () => {
  it("shows nothing, asks the API nothing, goes to sign-in and remembers only the opaque id", async () => {
    const { calls, container } = mount(`/n/${DELIVERY}`, null);

    await screen.findByText("SIGN IN SCREEN");

    expect(where()).toBe("/login");
    expect(resolveCalls(calls)).toEqual([]);
    expect(container.textContent).not.toContain(DELIVERY);
    expect(container.textContent).not.toContain(LANDING_GONE_HEADLINE);
    expect(document.title).not.toContain(DELIVERY);
    expect(
      window.history.state === null || !JSON.stringify(window.history.state).includes(DELIVERY),
    ).toBe(true);
    expect(takePendingNotificationLink()).toBe(`/n/${DELIVERY}`);
  });
});

describe("signed in", () => {
  it("resolves once and replaces itself with the thread route for the ids the server named", async () => {
    const { calls } = mount(`/n/${DELIVERY}`, SESSION);

    await screen.findByText("THREAD SCREEN");

    expect(where()).toBe(`/messaging?channelId=${CHANNEL}&messageId=${MESSAGE}`);
    expect(resolveCalls(calls)).toHaveLength(1);
    expect(resolveCalls(calls)[0]).toContain(`/api/v1/messaging/deliveries/${DELIVERY}/target`);
    // the /n/ entry was replaced, not pushed: back does not return to the resolver
    expect(window.location.pathname).not.toContain("/n/");
  });

  it("says only a generic opening line while the answer is pending", async () => {
    const { container } = mount(
      `/n/${DELIVERY}`,
      SESSION,
      () => new Promise<Response>(() => {}) as unknown as Response,
    );

    await screen.findByText(LANDING_OPENING_TEXT);

    expect(container.textContent).not.toContain(DELIVERY);
    expect(screen.queryByText(LANDING_GONE_HEADLINE)).toBeNull();
    expect(screen.queryByText(LANDING_FAILED_HEADLINE)).toBeNull();
    expect(LANDING_OPENING_TEXT).not.toMatch(/patient|message from|urgent/i);
  });

  it.each([
    ["404", () => new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404 })],
    ["403", () => new Response(JSON.stringify({ error: { code: "FORBIDDEN" } }), { status: 403 })],
  ])(
    "shows the one generic gone page for a %s and moves focus to its headline",
    async (_name, make) => {
      const { container } = mount(`/n/${DELIVERY}`, SESSION, make);

      const headline = await screen.findByText(LANDING_GONE_HEADLINE);

      expect(document.activeElement).toBe(headline);
      expect(screen.getByRole("link", { name: LANDING_GONE_ACTION }).getAttribute("href")).toBe(
        "/messaging",
      );
      expect(container.textContent).not.toContain(DELIVERY);
      expect(where()).toBe(`/n/${DELIVERY}`);
      expect(document.title).not.toContain(DELIVERY);
      expect(container.querySelector("[role=alert]")).toBeNull();
      const results = await axe.run(container, { rules: { region: { enabled: false } } });
      expect(results.violations).toEqual([]);
    },
  );

  it.each([
    ["500", () => new Response("boom", { status: 500 })],
    ["429", () => new Response("slow down", { status: 429 })],
    ["408", () => new Response("timeout", { status: 408 })],
    ["rejected promise", () => Promise.reject(new TypeError("offline")) as unknown as Response],
  ])("a %s is a retryable failure, not 'no longer available'", async (_name, make) => {
    const { container, calls } = mount(`/n/${DELIVERY}`, SESSION, make);

    const headline = await screen.findByText(LANDING_FAILED_HEADLINE);

    expect(document.activeElement).toBe(headline);
    expect(screen.queryByText(LANDING_GONE_HEADLINE)).toBeNull();
    expect(container.textContent).not.toContain(DELIVERY);
    expect(resolveCalls(calls)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: LANDING_FAILED_ACTION }));
    await waitFor(() => expect(resolveCalls(calls)).toHaveLength(2));
    await screen.findByText(LANDING_FAILED_HEADLINE);
  });

  it("works under StrictMode: resolves and lands on the thread", async () => {
    mount(`/n/${DELIVERY}`, SESSION, undefined, true);

    await screen.findByText("THREAD SCREEN");

    expect(where()).toBe(`/messaging?channelId=${CHANNEL}&messageId=${MESSAGE}`);
  });

  it("answers a malformed id with the same page and never calls the API", async () => {
    const { calls } = mount("/n/a%20b", SESSION);
    await waitFor(() => expect(screen.getByText(LANDING_GONE_HEADLINE)).toBeTruthy());
    expect(resolveCalls(calls)).toEqual([]);
  });
});
