// @vitest-environment jsdom
// #589 - Unlock re-authenticates the SAME session through POST /api/v1/auth/unlock. It must never go through
// Better Auth sign-in (that mints a second, org-less session whose first org-scoped call 401s -> /expired).
import { type ApiClient, ApiClientProvider } from "@chartwarden/ui";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const signInEmail = vi.fn();
const signInUsername = vi.fn();
const signOut = vi.fn();

vi.mock("../auth-client", () => ({
  authClient: {
    getSession: () => getSession(),
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      username: (...args: unknown[]) => signInUsername(...args),
    },
    signOut: () => signOut(),
  },
}));

import { getGlobalResponseSignal, setGlobalResponseSignal } from "../../../shell/global-response-signal";
import { ScreenLock } from "../screen-lock";

const post = vi.fn();
const client = { POST: (...args: unknown[]) => post(...args) } as unknown as ApiClient;

const refusal = (status: number, code: string) => ({
  data: undefined,
  error: { error: { code, message: "x" } },
  response: new Response(null, { status }),
});

describe("ScreenLock unlock (#589)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const m of [getSession, signInEmail, signInUsername, signOut, post]) m.mockReset();
    getSession.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "staff@example.test", username: "jsmith" },
        session: { sessionClass: "staff", activeOrganizationId: "org-1" },
      },
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    setGlobalResponseSignal(null);
  });

  async function lockAndSubmit(password = "ValidPassword#123"): Promise<void> {
    render(
      <ApiClientProvider client={client}>
        <ScreenLock />
      </ApiClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    screen.getByRole("alertdialog", { name: "Screen locked" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
  }

  it("posts the password to /auth/unlock, unlocks, and never signs in again or out", async () => {
    post.mockResolvedValue({
      data: { sessionId: "s1", activeOrganizationId: "org-1" },
      error: undefined,
      response: new Response(null, { status: 200 }),
    });
    await lockAndSubmit();

    expect(post).toHaveBeenCalledWith("/api/v1/auth/unlock", { body: { password: "ValidPassword#123" } });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(signInEmail).not.toHaveBeenCalled();
    expect(signInUsername).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("stays locked and clears the field on a wrong password", async () => {
    post.mockResolvedValue(refusal(401, "INVALID_CREDENTIALS"));
    await lockAndSubmit("nope");

    expect(screen.getByRole("alertdialog", { name: "Screen locked" })).toBeTruthy();
    expect(screen.getByText(/didn.t match/i)).toBeTruthy();
    expect(getGlobalResponseSignal()).toBeNull(); // a wrong password must never read as a dead session
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("tells the user to wait when the failed-attempt budget is spent", async () => {
    post.mockResolvedValue(refusal(429, "TOO_MANY_FAILED_ATTEMPTS"));
    await lockAndSubmit();

    expect(screen.getByText(/too many/i)).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Screen locked" })).toBeTruthy();
  });

  it("stays locked with a retry message when the request itself fails", async () => {
    post.mockRejectedValue(new TypeError("network down"));
    await lockAndSubmit();

    expect(screen.getByText(/couldn.t unlock/i)).toBeTruthy();
    expect(screen.getByRole("alertdialog", { name: "Screen locked" })).toBeTruthy();
  });

  it("stays locked when a gateway answers an error with an EMPTY body (openapi-fetch gives error === '')", async () => {
    // A falsy `error` must not read as success: the verdict is the HTTP status, not the truthiness of the body.
    post.mockResolvedValue({ data: undefined, error: "", response: new Response(null, { status: 502 }) });
    await lockAndSubmit();

    expect(screen.getByRole("alertdialog", { name: "Screen locked" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/couldn.t unlock/i);
  });

  it("a bodiless/odd 401 (proxy hiccup on a live session) does not sign the user out or wipe drafts", async () => {
    post.mockResolvedValue({ data: undefined, error: "", response: new Response(null, { status: 401 }) });
    await lockAndSubmit();

    expect(getGlobalResponseSignal()).toBeNull();
    expect(screen.getByRole("alertdialog", { name: "Screen locked" })).toBeTruthy();
  });

  it("a lockout (423): the server ended the session, so the shell is told and the user is not left typing", async () => {
    post.mockResolvedValue(refusal(423, "UNLOCK_LOCKED_OUT"));
    await lockAndSubmit();

    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
    expect(screen.getByRole("alert").textContent).toMatch(/session has ended/i);
  });

  it("hands an idle/absolute-timeout 401 (SESSION_EXPIRED) to the shell too", async () => {
    post.mockResolvedValue(refusal(401, "SESSION_EXPIRED"));
    await lockAndSubmit();

    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
  });

  it("hands a genuinely dead session (plain UNAUTHORIZED) to the shell as session-expired", async () => {
    // /auth/unlock is exempt from the blanket 401 -> expired rule (a wrong password is a 401 too), so the
    // screen has to raise the signal itself when the session is truly gone.
    post.mockResolvedValue(refusal(401, "UNAUTHORIZED"));
    await lockAndSubmit();

    expect(getGlobalResponseSignal()).toEqual({ kind: "session-expired" });
  });
});
