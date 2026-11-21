// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RouterProvider, createMemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
const enable = vi.fn();
const verifyTotp = vi.fn();

vi.mock("../auth-client", () => ({
  authClient: {
    getSession: () => getSession(),
    twoFactor: {
      enable: (...args: unknown[]) => enable(...args),
      verifyTotp: (...args: unknown[]) => verifyTotp(...args),
    },
  },
}));

import { SecurityAuthenticator } from "../security-authenticator";

// Synthetic values: a made-up base32 secret, a made-up password, made-up backup codes. They belong to no account.
const SECRET = "JBSWY3DPEHPK3PXP";
const URI = `otpauth://totp/ChartWarden:demo%40example.test?secret=${SECRET}&issuer=ChartWarden`;
const BACKUP = ["aaaa-1111", "bbbb-2222"];
const PASSWORD = "not-a-real-password";

// A data router: the screen holds in-app navigation (useBlocker) while the backup codes are unsaved.
function mount(entry = "/security/authenticator") {
  const router = createMemoryRouter(
    [
      { path: "/security/authenticator", element: <SecurityAuthenticator /> },
      { path: "/orders", element: <p>Back at orders</p> },
      { path: "/login", element: <p>Signed out</p> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function enterPassword(value = PASSWORD): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/your password/i), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
}

beforeEach(() => {
  getSession.mockResolvedValue({ data: { user: { id: "u1", email: null } }, error: null });
  enable.mockResolvedValue({ data: { totpURI: URI, backupCodes: BACKUP }, error: null });
  verifyTotp.mockResolvedValue({ error: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("authenticator app setup", () => {
  it("asks for the password first, and sends nothing until it is given", async () => {
    mount();
    expect(
      await screen.findByRole("heading", { name: "Turn on the authenticator app" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    expect(enable).not.toHaveBeenCalled();
  });

  it("shows the setup key, hides the password step and clears the password once enrolment starts", async () => {
    mount();
    await enterPassword();
    expect(await screen.findByText("JBSW Y3DP EHPK 3PXP")).toBeTruthy();
    expect(enable).toHaveBeenCalledWith({ password: PASSWORD });
    expect(screen.queryByLabelText(/your password/i)).toBeNull();
    // The QR code is drawn on the page, named for its purpose, and does not repeat the secret in its label.
    const qr = screen.getByRole("img", { name: /QR code for adding ChartWarden/ });
    expect(qr.getAttribute("aria-label")).not.toContain(SECRET);
    // The link is the validated otpauth URI, not anything else the server sent.
    expect(screen.getByRole("link", { name: "open the setup link" }).getAttribute("href")).toBe(
      URI,
    );
  });

  it("turns the factor on only after a code is accepted, then shows the backup codes once", async () => {
    mount();
    await enterPassword();
    const code = await screen.findByLabelText(/6-digit code/i);
    const turnOn = screen.getByRole("button", { name: "Turn on" });
    expect(turnOn.hasAttribute("disabled")).toBe(true);
    fireEvent.change(code, { target: { value: "123 456" } });
    fireEvent.click(turnOn);
    expect(
      await screen.findByRole("heading", { name: "The authenticator app is on" }),
    ).toBeTruthy();
    expect(verifyTotp).toHaveBeenCalledWith({ code: "123456" });
    for (const backupCode of BACKUP) expect(screen.getByText(backupCode)).toBeTruthy();
  });

  it("says so, and stays on the code step, when the code is wrong", async () => {
    verifyTotp.mockResolvedValue({ error: { code: "INVALID_CODE", message: "server detail" } });
    mount();
    await enterPassword();
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/That code is not right/);
    expect(screen.queryByText("server detail")).toBeNull();
    expect(screen.queryByRole("heading", { name: "The authenticator app is on" })).toBeNull();
  });

  it("says so, and stays on the password step, when the password is wrong", async () => {
    enable.mockResolvedValue({ data: null, error: { code: "INVALID_PASSWORD" } });
    mount();
    await enterPassword("wrong");
    expect((await screen.findByRole("alert")).textContent).toMatch(/password is not correct/);
    expect(screen.getByLabelText(/your password/i)).toBeTruthy();
  });

  it("tells an account that has a passkey to sign in with it first, and stays on the password step", async () => {
    enable.mockResolvedValue({
      data: null,
      error: {
        status: 403,
        error: { code: "MFA_VERIFICATION_REQUIRED", message: "server detail" },
      },
    });
    mount();
    await enterPassword();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Sign in again with your passkey first/);
    expect(screen.queryByText("server detail")).toBeNull();
    expect(screen.getByLabelText(/your password/i)).toBeTruthy();
  });

  it("refuses a setup URI that is not an authenticator URI instead of linking to it", async () => {
    enable.mockResolvedValue({
      data: { totpURI: "javascript:alert(1)", backupCodes: BACKUP },
      error: null,
    });
    mount();
    await enterPassword();
    expect((await screen.findByRole("alert")).textContent).toMatch(/nothing was turned on/);
    expect(screen.queryByRole("link", { name: "open the setup link" })).toBeNull();
  });

  it("reports an account that already has the factor on, with nothing to set up", async () => {
    getSession.mockResolvedValue({
      data: { user: { id: "u1", email: null, twoFactorEnabled: true } },
      error: null,
    });
    mount();
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByLabelText(/your password/i)).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });

  it("does not claim anything when the session cannot be read", async () => {
    getSession.mockResolvedValue({ data: null, error: { message: "down" } });
    mount();
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByLabelText(/your password/i)).toBeNull();
  });

  it("offers the way back only to a same-origin path", async () => {
    mount(`/security/authenticator?returnTo=${encodeURIComponent("/orders")}`);
    await enterPassword();
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByRole("heading", { name: "The authenticator app is on" });
    // The way on waits for "I have saved these codes": the codes are not shown again.
    expect(screen.queryByRole("link", { name: "Continue where you left off" })).toBeNull();
    fireEvent.click(screen.getByLabelText(/saved these codes/i));
    const back = await screen.findByRole("link", { name: "Continue where you left off" });
    expect(back.getAttribute("href")).toBe("/orders");
    cleanup();

    mount(`/security/authenticator?returnTo=${encodeURIComponent("//evil.example/phish")}`);
    await enterPassword();
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByRole("heading", { name: "The authenticator app is on" });
    fireEvent.click(screen.getByLabelText(/saved these codes/i));
    // The shared guard turns a foreign path into the app root: the link can never leave the app.
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /left off/ }).getAttribute("href")).toBe("/"),
    );
  });

  it("does not hang when the session request fails to reach the server", async () => {
    getSession.mockRejectedValue(new Error("network down"));
    mount();
    expect(await screen.findByText(/could not be read/)).toBeTruthy();
  });

  it("recovers, and says so, when the password request fails to reach the server", async () => {
    enable.mockRejectedValue(new Error("network down"));
    mount();
    await enterPassword();
    expect((await screen.findByRole("alert")).textContent).toMatch(/nothing was turned on/);
    const field = screen.getByLabelText(/your password/i);
    expect(field.hasAttribute("readonly")).toBe(false);
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("does not claim nothing was turned on when the code request fails to reach the server", async () => {
    verifyTotp.mockRejectedValue(new Error("network down"));
    mount();
    await enterPassword();
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/reload this page to see whether/i);
    expect(alert.textContent).not.toMatch(/nothing was turned on/);
    expect(screen.getByLabelText(/6-digit code/i).getAttribute("aria-invalid")).toBe("true");
  });

  it("shows the account as on when the server says the factor is already enabled", async () => {
    enable.mockResolvedValue({ data: null, error: { code: "TOTP_ALREADY_ENABLED" } });
    mount();
    await enterPassword();
    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.queryByLabelText(/your password/i)).toBeNull();
  });

  it("keeps the input focusable while a request is in flight (read-only, not disabled)", async () => {
    let release: (value: unknown) => void = () => {};
    enable.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    mount();
    await enterPassword();
    await waitFor(() =>
      expect(screen.getByLabelText(/your password/i).hasAttribute("readonly")).toBe(true),
    );
    expect(screen.getByLabelText(/your password/i).hasAttribute("disabled")).toBe(false);
    release({ data: { totpURI: URI, backupCodes: BACKUP }, error: null });
    await screen.findByText("JBSW Y3DP EHPK 3PXP");
  });

  it("copies the setup key and the backup codes the user can already see", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    try {
      mount();
      await enterPassword();
      fireEvent.click(await screen.findByRole("button", { name: "Copy setup key" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(SECRET));
      fireEvent.change(screen.getByLabelText(/6-digit code/i), { target: { value: "123456" } });
      fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
      fireEvent.click(await screen.findByRole("button", { name: "Copy backup codes" }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(BACKUP.join("\n")));
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("says so when the browser refuses to copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
    });
    try {
      mount();
      await enterPassword();
      fireEvent.click(await screen.findByRole("button", { name: "Copy setup key" }));
      expect(await screen.findByText(/Could not copy/)).toBeTruthy();
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("warns before the page is closed while the backup codes are unsaved, and stops once they are", async () => {
    mount();
    await enterPassword();
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByRole("heading", { name: "The authenticator app is on" });
    const unsaved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unsaved);
    expect(unsaved.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByLabelText(/saved these codes/i));
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });

  it("puts focus back on the field after a refused submit", async () => {
    enable.mockResolvedValue({ data: null, error: { code: "INVALID_PASSWORD" } });
    mount();
    await enterPassword("wrong");
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText(/your password/i)),
    );
  });

  async function reachBackupCodes(router: ReturnType<typeof mount>): Promise<void> {
    fireEvent.change(await screen.findByLabelText(/your password/i), {
      target: { value: PASSWORD },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(await screen.findByLabelText(/6-digit code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Turn on" }));
    await screen.findByRole("heading", { name: "The authenticator app is on" });
    expect(router.state.location.pathname).toBe("/security/authenticator");
  }

  it("asks before leaving in-app while the backup codes are unsaved, and lets the user stay or leave", async () => {
    const router = mount();
    await reachBackupCodes(router);
    await act(async () => {
      void router.navigate("/orders");
    });
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(router.state.location.pathname).toBe("/security/authenticator");
    fireEvent.click(screen.getByRole("button", { name: "Stay on this page" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(router.state.location.pathname).toBe("/security/authenticator");
    await act(async () => {
      void router.navigate("/orders");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Leave anyway" }));
    expect(await screen.findByText("Back at orders")).toBeTruthy();
  });

  it("lets the user leave freely once the backup codes are saved, and never holds a shell exit", async () => {
    const router = mount();
    await reachBackupCodes(router);
    await act(async () => {
      void router.navigate("/login");
    });
    expect(await screen.findByText("Signed out")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    cleanup();

    const second = mount();
    await reachBackupCodes(second);
    fireEvent.click(screen.getByLabelText(/saved these codes/i));
    await act(async () => {
      void second.navigate("/orders");
    });
    expect(await screen.findByText("Back at orders")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
