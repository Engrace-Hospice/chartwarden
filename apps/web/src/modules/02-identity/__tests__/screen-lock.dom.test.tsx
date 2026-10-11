// @vitest-environment jsdom
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

import { ScreenLock } from "../screen-lock";

describe("ScreenLock identifiers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getSession.mockReset();
    signInEmail.mockReset();
    signInUsername.mockReset();
    signOut.mockReset();
    signInEmail.mockResolvedValue({ data: {}, error: null });
    signInUsername.mockResolvedValue({ data: {}, error: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function lock(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(60 * 60 * 1000));
    screen.getByRole("alertdialog", { name: "Screen locked" });
  }

  it("reauthenticates a username-only user with the captured username", async () => {
    getSession.mockResolvedValue({
      data: {
        user: { id: "user-1", email: null, username: "jsmith" },
        session: { sessionClass: "staff", activeOrganizationId: "org-1" },
      },
      error: null,
    });
    render(<ScreenLock />);
    await lock();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ValidPassword#123" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
    expect(signInUsername).toHaveBeenCalledWith({
      username: "jsmith",
      password: "ValidPassword#123",
    });
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("keeps existing email-based unlock behavior", async () => {
    getSession.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "staff@example.test", username: "jsmith" },
        session: { sessionClass: "staff", activeOrganizationId: "org-1" },
      },
      error: null,
    });
    render(<ScreenLock />);
    await lock();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ValidPassword#123" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Unlock" })));
    expect(signInEmail).toHaveBeenCalledWith({
      email: "staff@example.test",
      password: "ValidPassword#123",
    });
    expect(signInUsername).not.toHaveBeenCalled();
  });
});
