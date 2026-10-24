// M36 WP 6.7 (ADR-0099, PROPOSED) - the family contact's page against a mocked network boundary (the global fetch): the fragment is scrubbed and the token is
// never in the DOM or storage, redeem -> verify (the bearer rotates and the new one is used) -> messages -> send, ONE neutral state for every refusal, the
// closed and rate-limited sends, plain-text rendering, the noindex meta, bereavement wording, the not-an-emergency notice in every state, and the counter.
import { FAMILY_NOT_EMERGENCY_TEXT } from "@chartwarden/types";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FamilyPage } from "./family-page";

const ORG = "33333333-3333-4333-8333-333333333333";
const TOKEN = "A".repeat(43);
const ENROL = `${ORG}.${"B".repeat(43)}`;
const ACTIVE = `${ORG}.${"C".repeat(43)}`;
const PHONE = "555-0100";
const STATE_PHONE = "555-0199";
const NO_CONTRAST = { rules: { "color-contrast": { enabled: false } } };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
const calls: Call[] = [];
let handler: (url: string, init: RequestInit) => { status: number; body?: unknown };

const json = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const stateBody = (over: Record<string, unknown> = {}) => ({
  stage: "enrolment",
  mode: "standard",
  agencyName: null,
  agencyPhone: STATE_PHONE,
  bereavementPhone: null,
  language: null,
  closed: false,
  expiresAt: "2026-10-30T10:00:00.000Z",
  ...over,
});
const message = (over: Record<string, unknown> = {}) => ({
  messageId: "m1",
  from: "care_team",
  body: "We will call you tomorrow.",
  createdAt: "2026-10-23T10:05:00.000Z",
  receivedByCareTeam: false,
  ...over,
});

function happy(url: string, init: RequestInit): { status: number; body?: unknown } {
  if (url.endsWith("/redeem")) {
    return {
      status: 200,
      body: { sessionToken: ENROL, stage: "enrolment", expiresAt: "2026-10-30T10:00:00.000Z" },
    };
  }
  if (url.endsWith("/state")) return { status: 200, body: stateBody() };
  if (url.endsWith("/verify")) {
    return { status: 200, body: { ...stateBody({ stage: "active" }), sessionToken: ACTIVE } };
  }
  if (url.includes("/messages") && init.method === "POST") {
    return { status: 201, body: { messageId: "m2", createdAt: "2026-10-23T10:06:00.000Z" } };
  }
  if (url.includes("/messages"))
    return { status: 200, body: { messages: [message()], nextCursor: null } };
  return { status: 404 };
}

function mount(hash = `#t=${TOKEN}&o=${ORG}&n=${PHONE}`) {
  window.history.replaceState(null, "", `/family/open${hash}`);
  return render(<FamilyPage />);
}

const authOf = (call: Call): string | undefined =>
  (call.init.headers as Record<string, string> | undefined)?.Authorization;
const callsTo = (suffix: string, method?: string) =>
  calls.filter((c) => c.url.includes(suffix) && (method ? c.init.method === method : true));

async function enter(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("8-digit code"), "12345678");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText("We will call you tomorrow.");
}

beforeEach(() => {
  calls.length = 0;
  handler = happy;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return json(r.status, r.body);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("FamilyPage - opening", () => {
  it("scrubs the fragment at once, redeems with the token, and keeps the token out of the DOM and storage", async () => {
    const { container } = mount();
    await screen.findByLabelText("8-digit code");
    expect(window.location.hash).toBe("");
    const redeem = callsTo("/redeem")[0]!;
    expect(JSON.parse(String(redeem.init.body))).toEqual({ organizationId: ORG, token: TOKEN });
    expect(redeem.init.credentials).toBe("omit");
    expect(container.innerHTML).not.toContain(TOKEN);
    expect(container.innerHTML).not.toContain(ENROL);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(ENROL);
    expect(authOf(callsTo("/state")[0]!)).toBe(`Bearer ${ENROL}`);
  });

  it("asks for the code with numeric one-time-code input", async () => {
    mount();
    const input = await screen.findByLabelText("8-digit code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
  });

  it("shows the state's number once known (the number in the link is only for the dead page)", async () => {
    mount();
    await screen.findByLabelText("8-digit code");
    expect(screen.getByRole("link", { name: STATE_PHONE })).toBeTruthy();
    expect(screen.queryByRole("link", { name: PHONE })).toBeNull();
  });

  it("sets a neutral title and a noindex meta while mounted, and removes the meta on unmount", async () => {
    const before = document.title;
    const view = mount();
    await screen.findByLabelText("8-digit code");
    expect(document.title).toBe("Secure message");
    expect(document.head.querySelector('meta[name="robots"]')?.getAttribute("content")).toBe(
      "noindex, nofollow",
    );
    view.unmount();
    expect(document.head.querySelector('meta[name="robots"]')).toBeNull();
    expect(document.title).toBe(before);
  });
});

describe("FamilyPage - the conversation", () => {
  it("verifies, rotates the bearer, reads with the new one and sends with the new one", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await enter(user);
    expect(authOf(callsTo("/verify")[0]!)).toBe(`Bearer ${ENROL}`);
    expect(JSON.parse(String(callsTo("/verify")[0]!.init.body))).toEqual({ code: "12345678" });
    expect(authOf(callsTo("/messages", "GET")[0]!)).toBe(`Bearer ${ACTIVE}`);
    await user.type(screen.getByLabelText("Your message"), "Thank you");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callsTo("/messages", "POST")).toHaveLength(1));
    const post = callsTo("/messages", "POST")[0]!;
    expect(authOf(post)).toBe(`Bearer ${ACTIVE}`);
    expect(JSON.parse(String(post.init.body))).toEqual({ body: "Thank you" });
    await screen.findByText("Your message was sent.");
    expect(container.innerHTML).not.toContain(ACTIVE);
  });

  it("labels messages You and Care team (never a staff name) and says when the care team has received one", async () => {
    handler = (url, init) =>
      url.includes("/messages") && init.method !== "POST"
        ? {
            status: 200,
            body: {
              messages: [
                message({ messageId: "a", from: "you", body: "Hello", receivedByCareTeam: true }),
                message({ messageId: "b" }),
              ],
              nextCursor: null,
            },
          }
        : happy(url, init);
    const user = userEvent.setup();
    mount();
    await enter2(user);
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("Care team")).toBeTruthy();
    expect(screen.getByText("Received by the care team")).toBeTruthy();
  });

  it("renders a message as plain text: no script element, no link, line breaks kept", async () => {
    const hostile = "<script>alert(1)</script>\nsee https://evil.example/x";
    handler = (url, init) =>
      url.includes("/messages") && init.method !== "POST"
        ? { status: 200, body: { messages: [message({ body: hostile })], nextCursor: null } }
        : happy(url, init);
    const user = userEvent.setup();
    const { container } = mount();
    await enter2(user);
    const body = await screen.findByText(
      (_, el) => el?.tagName === "P" && el.textContent === hostile,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector('a[href^="http"]')).toBeNull();
    expect(getComputedStyle(body).whiteSpace).toBe("pre-wrap");
  });

  it("loads more messages with the cursor on request and never polls by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    handler = (url, init) => {
      if (url.includes("/messages") && init.method !== "POST") {
        // A refresh follows four pages; the fifth is only reached through "Show more messages".
        const chain: Record<string, string | null> = {
          "": "C1",
          C1: "C2",
          C2: "C3",
          C3: "C4",
          C4: null,
        };
        const cursor = new URL(url, "http://x").searchParams.get("cursor") ?? "";
        const last = cursor === "C4";
        return {
          status: 200,
          body: {
            messages: [
              message({ messageId: `m-${cursor}`, body: last ? "Last page" : `Page ${cursor}` }),
            ],
            nextCursor: chain[cursor] ?? null,
          },
        };
      }
      return happy(url, init);
    };
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await enter2(user);
    const reads = callsTo("/messages", "GET").length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(callsTo("/messages", "GET")).toHaveLength(reads);
    await user.click(screen.getByRole("button", { name: "Show more messages" }));
    await screen.findByText("Last page");
    vi.useRealTimers();
  });

  it("Refresh re-reads the thread", async () => {
    const user = userEvent.setup();
    mount();
    await enter(user);
    const reads = callsTo("/messages", "GET").length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(callsTo("/messages", "GET").length).toBe(reads + 1));
  });

  it("counts characters, sends exactly 2000 and refuses 2001", async () => {
    const user = userEvent.setup();
    mount();
    await enter(user);
    const box = screen.getByLabelText("Your message");
    fireEvent.change(box, { target: { value: "a".repeat(2000) } });
    expect(screen.getByText("2000 of 2000 characters")).toBeTruthy();
    fireEvent.change(box, { target: { value: "a".repeat(2001) } });
    expect(screen.getByText("2001 of 2000 characters")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByText(/longer than 2000 characters/)).textContent).toBeTruthy();
    expect(callsTo("/messages", "POST")).toHaveLength(0);
    fireEvent.change(box, { target: { value: "a".repeat(2000) } });
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(callsTo("/messages", "POST")).toHaveLength(1));
  });

  it("says the conversation is closed when a send gets the closed answer, and offers no attachment or emoji control", async () => {
    handler = (url, init) =>
      url.includes("/messages") && init.method === "POST"
        ? { status: 409, body: { error: { code: "FAMILY_THREAD_CLOSED", message: "server text" } } }
        : happy(url, init);
    const user = userEvent.setup();
    const { container } = mount();
    await enter(user);
    await user.type(screen.getByLabelText("Your message"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText("This conversation is closed, please call the agency.");
    expect(container.textContent).not.toContain("server text");
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("shows a plain wait message on 429", async () => {
    handler = (url, init) =>
      url.includes("/messages") && init.method === "POST" ? { status: 429 } : happy(url, init);
    const user = userEvent.setup();
    mount();
    await enter(user);
    await user.type(screen.getByLabelText("Your message"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/Please wait a little while before sending another message/);
  });

  it("hides the composer when the state says the conversation is closed", async () => {
    handler = (url, init) =>
      url.endsWith("/verify")
        ? {
            status: 200,
            body: { ...stateBody({ stage: "active", closed: true }), sessionToken: ACTIVE },
          }
        : happy(url, init);
    const user = userEvent.setup();
    mount();
    await enter(user);
    expect(screen.queryByLabelText("Your message")).toBeNull();
    expect(
      screen.getAllByText("This conversation is closed, please call the agency.").length,
    ).toBeGreaterThan(0);
  });
});

describe("FamilyPage - bereavement mode", () => {
  it("uses the calmer wording and shows the bereavement support number", async () => {
    handler = (url, init) =>
      url.endsWith("/verify")
        ? {
            status: 200,
            body: {
              ...stateBody({ stage: "active", mode: "bereavement", bereavementPhone: "555-0142" }),
              sessionToken: ACTIVE,
            },
          }
        : happy(url, init);
    const user = userEvent.setup();
    mount();
    await enter2(user);
    expect(screen.getByRole("heading", { name: "Your messages" })).toBeTruthy();
    expect(screen.getByText(/We are thinking of you/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "555-0142" })).toBeTruthy();
    expect(screen.getByText("Support team")).toBeTruthy();
    expect(screen.queryByText("Messages with your care team")).toBeNull();
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
  });
});

describe("FamilyPage - the one neutral state", () => {
  const NEUTRAL = "This link is no longer active. Please call the agency.";

  it("shows it, with the number from the link, for a missing or malformed link and calls nothing", async () => {
    mount("#t=nope&o=nope&n=555-0100");
    await screen.findByText(NEUTRAL);
    expect(screen.getByRole("link", { name: PHONE })).toBeTruthy();
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows it without a number when the link carried none", async () => {
    handler = () => ({ status: 404 });
    mount(`#t=${TOKEN}&o=${ORG}`);
    await screen.findByText(NEUTRAL);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it.each([
    ["redeem", "/redeem"],
    ["state", "/state"],
  ])("a 404 from %s", async (_name, suffix) => {
    handler = (url, init) => (url.endsWith(suffix) ? { status: 404 } : happy(url, init));
    mount();
    await screen.findByText(NEUTRAL);
    expect(screen.getByRole("link", { name: PHONE })).toBeTruthy();
    expect(screen.queryByLabelText("8-digit code")).toBeNull();
  });

  it.each([404, 410])("a %s from the network for any call", async (status) => {
    handler = (url) => (url.endsWith("/redeem") ? { status } : { status: 200, body: {} });
    mount();
    await screen.findByText(NEUTRAL);
  });

  it("a 404 from verify (the fifth wrong code) after earlier wrong codes", async () => {
    let tries = 0;
    handler = (url, init) => {
      if (!url.endsWith("/verify")) return happy(url, init);
      tries += 1;
      return tries < 3
        ? { status: 422, body: { error: { code: "FAMILY_CODE_INVALID" } } }
        : { status: 404 };
    };
    const user = userEvent.setup();
    mount();
    const input = await screen.findByLabelText("8-digit code");
    for (let i = 0; i < 2; i += 1) {
      await user.clear(input);
      await user.type(input, "11111111");
      await user.click(screen.getByRole("button", { name: "Continue" }));
      await screen.findByText("That code is not correct. Please check it and try again.");
    }
    await user.clear(input);
    await user.type(input, "11111111");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(NEUTRAL);
  });

  it("a 404 from reading or sending ends the session and clears the messages", async () => {
    const user = userEvent.setup();
    mount();
    await enter(user);
    handler = (url, init) => (url.includes("/messages") ? { status: 404 } : happy(url, init));
    await user.type(screen.getByLabelText("Your message"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(NEUTRAL);
    expect(screen.queryByText("We will call you tomorrow.")).toBeNull();
  });

  it("never shows server text for a failure", async () => {
    handler = (url, init) =>
      url.endsWith("/verify")
        ? { status: 500, body: { error: { message: "internal secret detail" } } }
        : happy(url, init);
    const user = userEvent.setup();
    const { container } = mount();
    await user.type(await screen.findByLabelText("8-digit code"), "12345678");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(/could not reach the service/);
    expect(container.textContent).not.toContain("internal secret detail");
  });
});

describe("FamilyPage - the not-an-emergency notice", () => {
  it("is visible in the code step, the conversation and the neutral state", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByLabelText("8-digit code");
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
    await user.type(screen.getByLabelText("8-digit code"), "12345678");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText("We will call you tomorrow.");
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
    cleanup();
    mount("#bad");
    await screen.findByText("This link is no longer active. Please call the agency.");
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
  });

  it("is visible while the link is opening, before any answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => undefined)),
    );
    mount();
    expect(screen.getByText(FAMILY_NOT_EMERGENCY_TEXT)).toBeTruthy();
    expect(screen.getByRole("link", { name: PHONE })).toBeTruthy();
  });
});

describe("FamilyPage - accessibility", () => {
  it("has no axe violations in the code step and the conversation", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    await screen.findByLabelText("8-digit code");
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
    await enter(user);
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
  });
});

/** Enters the code and waits for the conversation heading (for tests whose messages differ from the default). */
async function enter2(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("8-digit code"), "12345678");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByLabelText("Your message");
}
