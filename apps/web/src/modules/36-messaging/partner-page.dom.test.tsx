// M36 WP 6.6 (ADR-0096 D19-D23, PROPOSED) - the partner-facing page against a mocked network boundary (the global fetch): nothing is redeemed until the
// button is pressed, the fragment is scrubbed, the code step, ONE neutral state for every refusal, the bearer stays in memory only, no PHI in the title,
// storage or console, idle and absolute limits, polling that pauses while hidden, and axe.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PARTNER_IDLE_MS, PartnerPage } from "./partner-page";

const ORG = "33333333-3333-4333-8333-333333333333";
const SHARE = "22222222-2222-4222-8222-222222222222";
const TOKEN = "A".repeat(43);
const SESSION = `${ORG}.${"B".repeat(43)}`;
const ACTIVE = `${ORG}.${"C".repeat(43)}`;
const SECRET_BODY = "Refill ready for pickup at the north desk";
const NO_CONTRAST = { rules: { "color-contrast": { enabled: false } } };

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}
const calls: Call[] = [];
let handler: (url: string, init: RequestInit) => { status: number; body?: unknown };

function json(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const MESSAGES = {
  messages: [
    {
      messageId: "m1",
      authorName: "Dana Reyes",
      body: SECRET_BODY,
      createdAt: "2026-10-23T10:05:00.000Z",
      edited: false,
    },
  ],
  nextCursor: null,
};

function happy(url: string): { status: number; body?: unknown } {
  if (url.endsWith("/redeem"))
    return {
      status: 200,
      body: {
        sessionToken: SESSION,
        shareId: SHARE,
        stage: "enrolment",
        expiresAt: "2026-10-30T10:00:00.000Z",
      },
    };
  if (url.endsWith("/verify"))
    return {
      status: 200,
      body: {
        shareId: SHARE,
        stage: "active",
        partnerName: "Northside Pharmacy",
        expiresAt: "2026-10-30T10:00:00.000Z",
        sessionToken: ACTIVE,
      },
    };
  if (url.includes("/messages")) return { status: 200, body: MESSAGES };
  return { status: 404 };
}

function mount(hash = `#o=${ORG}&t=${TOKEN}`) {
  window.history.replaceState(null, "", `/partner/share${hash}`);
  return render(
    <MemoryRouter>
      <PartnerPage />
    </MemoryRouter>,
  );
}

async function openAndVerify(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
  await user.type(await screen.findByLabelText("Verification code"), "12345678");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByText(SECRET_BODY);
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
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("PartnerPage", () => {
  it("scrubs the fragment and redeems nothing until the button is pressed", async () => {
    mount();
    await screen.findByRole("button", { name: "Open the conversation" });
    expect(window.location.hash).toBe("");
    expect(calls).toHaveLength(0);
  });

  it("shows ONE neutral state for a missing or malformed link, without calling the network", async () => {
    mount("#o=nope&t=nope");
    expect((await screen.findByRole("alert")).textContent).toContain("not available");
    expect(calls).toHaveLength(0);
  });

  it("redeems, asks for the code, verifies with the rotated bearer, then reads with it", async () => {
    const user = userEvent.setup();
    mount();
    await openAndVerify(user);
    const redeem = calls[0]!;
    expect(redeem.url).toBe("/api/v1/messaging/partner/redeem");
    expect(JSON.parse(String(redeem.init.body))).toEqual({ organizationId: ORG, token: TOKEN });
    const verify = calls.find((c) => c.url.endsWith("/verify"))!;
    expect((verify.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SESSION}`);
    expect(JSON.parse(String(verify.init.body))).toEqual({ code: "12345678" });
    const read = calls.find((c) => c.url.includes("/messages"))!;
    expect((read.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ACTIVE}`);
    expect(screen.getByText("Dana Reyes")).toBeTruthy();
  });

  it("never sends cookies or a referrer, and never caches", async () => {
    const user = userEvent.setup();
    mount();
    await openAndVerify(user);
    for (const c of calls) {
      expect(c.init.credentials).toBe("omit");
      expect(c.init.referrerPolicy).toBe("no-referrer");
      expect(c.init.cache).toBe("no-store");
    }
  });

  it("keeps the title fixed and puts no token, code or message in storage or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation(() => undefined),
    );
    const user = userEvent.setup();
    mount();
    await openAndVerify(user);
    expect(document.title).toBe("Secure message");
    const stored =
      JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage });
    for (const secret of [TOKEN, SESSION, ACTIVE, "12345678", SECRET_BODY]) {
      expect(stored).not.toContain(secret);
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(SHARE);
    for (const s of spies) s.mockRestore();
  });

  it("a wrong code says so, keeps the form, and does not claim how many tries are left", async () => {
    handler = (url) =>
      url.endsWith("/verify")
        ? { status: 422, body: { error: { code: "EXTERNAL_SHARE_CODE_INVALID" } } }
        : happy(url);
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
    await user.type(await screen.findByLabelText("Verification code"), "00000000");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("not correct");
    expect(alert.textContent).not.toMatch(/\d+ (tries|attempts)/);
    expect(screen.getByLabelText("Verification code")).toBeTruthy();
  });

  it("the code field rejects anything but eight digits before any request", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
    await user.type(await screen.findByLabelText("Verification code"), "12ab");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/verify"))).toHaveLength(0);
  });

  it.each([404, 401, 403])(
    "a %i on redeem, a revoked share and a never-existed share all show the SAME neutral state",
    async (status) => {
      handler = () => ({ status });
      const user = userEvent.setup();
      mount();
      await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
      const text = (await screen.findByRole("alert")).textContent;
      expect(text).toContain("not available");
      expect(text).not.toMatch(/revoked|expired|locked|exist/i);
    },
  );

  it("a share revoked mid-read drops to the same neutral state and clears every message from the page", async () => {
    const user = userEvent.setup();
    mount();
    await openAndVerify(user);
    handler = () => ({ status: 404 });
    await user.click(await screen.findByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain("not available");
    expect(screen.queryByText(SECRET_BODY)).toBeNull();
    expect(document.body.textContent).not.toContain(SECRET_BODY);
  });

  it("after 30 minutes without input the page drops the bearer, the messages and says it ended for inactivity", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await openAndVerify(user);
    await act(async () => {
      vi.advanceTimersByTime(PARTNER_IDLE_MS + 1000);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("inactivity");
    expect(screen.queryByText(SECRET_BODY)).toBeNull();
  });

  it("polls for new messages while visible and stops polling after the session ended", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    mount();
    await openAndVerify(user);
    const before = calls.filter((c) => c.url.includes("/messages")).length;
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes("/messages")).length).toBeGreaterThan(before),
    );
    handler = () => ({ status: 404 });
    await act(async () => {
      vi.advanceTimersByTime(16_000);
    });
    await screen.findByRole("alert");
    const after = calls.length;
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(calls.length).toBe(after);
  });

  it("announces the conversation as a polite log, labels the code, and has no axe violations", async () => {
    const user = userEvent.setup();
    const { container } = mount();
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
    await user.click(await screen.findByRole("button", { name: "Open the conversation" }));
    await screen.findByLabelText("Verification code");
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
    await user.type(screen.getByLabelText("Verification code"), "12345678");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByText(SECRET_BODY);
    const log = screen.getByRole("log");
    expect(log.getAttribute("aria-live")).toBe("polite");
    expect((await axe.run(container, NO_CONTRAST)).violations).toEqual([]);
  });

  it("is read-only: no composer, no attachment control", async () => {
    const user = userEvent.setup();
    mount();
    await openAndVerify(user);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("input[type=file]")).toBeNull();
  });
});
