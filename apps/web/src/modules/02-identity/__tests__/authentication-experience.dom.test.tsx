import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const signInEmail = vi.fn();
const signInUsername = vi.fn();
const signInPasskey = vi.fn();
const signOut = vi.fn(async () => ({ error: null }));
const getSession = vi.fn();

vi.mock("../auth-client", () => ({
  authClient: {
    signIn: {
      email: (...args: unknown[]) => signInEmail(...args),
      username: (...args: unknown[]) => signInUsername(...args),
      passkey: (...args: unknown[]) => signInPasskey(...args),
    },
    signOut: () => signOut(),
    getSession: () => getSession(),
  },
}));

import {
  rememberPendingNotificationLink,
  takePendingNotificationLink,
} from "../../../shell/pending-deep-link";
import { RequiredPasswordChange } from "../required-password-change";
import { SignIn } from "../sign-in";

function authClientFor(
  options: {
    passwordChangeRequired?: boolean;
    postError?: unknown;
  } = {},
): ApiClient {
  return {
    GET: vi.fn(async () => ({
      data: {
        passwordChangeRequired: options.passwordChangeRequired ?? false,
        reason: options.passwordChangeRequired ? "admin_provisioned" : null,
      },
      error: undefined,
    })),
    POST: vi.fn(async () =>
      options.postError
        ? { data: undefined, error: options.postError, response: { status: 400 } }
        : { data: { signInRequired: true }, error: undefined, response: { status: 200 } },
    ),
  } as unknown as ApiClient;
}

function renderSignIn(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/login"]}>
      <ApiClientProvider client={client}>
        <Routes>
          <Route path="/login" element={<SignIn />} />
          <Route path="/login/change-password" element={<p>password change page</p>} />
          <Route path="/login/organization" element={<p>organization page</p>} />
          <Route path="/login/2fa" element={<p>mfa page</p>} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("username/email authentication continuation", () => {
  beforeEach(() => {
    signInEmail.mockReset();
    signInUsername.mockReset();
    signInPasskey.mockReset();
    signOut.mockClear();
    signInEmail.mockResolvedValue({ data: {}, error: null });
    signInUsername.mockResolvedValue({ data: {}, error: null });
  });

  it("uses username sign-in and routes a temporary-password user to mandatory rotation", async () => {
    renderSignIn(authClientFor({ passwordChangeRequired: true }));
    fireEvent.change(screen.getByLabelText("Username or Email"), { target: { value: "jsmith" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Temporary#123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("password change page");
    expect(signInUsername).toHaveBeenCalledWith({ username: "jsmith", password: "Temporary#123" });
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("preserves email sign-in and MFA routing", async () => {
    signInEmail.mockResolvedValue({ data: { twoFactorRedirect: true }, error: null });
    renderSignIn(authClientFor());
    fireEvent.change(screen.getByLabelText("Username or Email"), {
      target: { value: "staff@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "ValidPassword#123" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("mfa page");
    expect(signInEmail).toHaveBeenCalledTimes(1);
  });

  it("uses a generic invalid-credential message", async () => {
    signInUsername.mockResolvedValue({ data: null, error: { message: "unknown user" } });
    renderSignIn(authClientFor());
    fireEvent.change(screen.getByLabelText("Username or Email"), { target: { value: "missing" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Invalid username/email or password.",
    );
  });
});

describe("mandatory password change", () => {
  it("submits the real rotation contract and returns to login after session revocation", async () => {
    const client = authClientFor({ passwordChangeRequired: true });
    render(
      <MemoryRouter initialEntries={["/login/change-password"]}>
        <ApiClientProvider client={client}>
          <Routes>
            <Route path="/login/change-password" element={<RequiredPasswordChange />} />
            <Route path="/login" element={<p>login page</p>} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Change Your Password");
    await waitFor(() => expect(screen.queryByText("Checking your account…")).toBeNull());
    fireEvent.change(screen.getByLabelText("Temporary Password"), {
      target: { value: "Temporary#123" },
    });
    fireEvent.change(screen.getByLabelText("New Password"), {
      target: { value: "A-New-Password#456" },
    });
    fireEvent.change(screen.getByLabelText("Confirm New Password"), {
      target: { value: "A-New-Password#456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change Password" }));
    await screen.findByText("login page");
    expect(client.POST).toHaveBeenCalledWith("/api/v1/auth/password/complete-required-change", {
      body: { currentPassword: "Temporary#123", newPassword: "A-New-Password#456" },
    });
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("finishes a pending notification link when no change is required, and consumes it once", async () => {
    window.sessionStorage.clear();
    rememberPendingNotificationLink("/n/abc-123");
    getSession.mockResolvedValue({ data: { session: { activeOrganizationId: "o-1" } } });
    render(
      <MemoryRouter initialEntries={["/login/change-password"]}>
        <ApiClientProvider client={authClientFor({ passwordChangeRequired: false })}>
          <Routes>
            <Route path="/login/change-password" element={<RequiredPasswordChange />} />
            <Route path="/n/:id" element={<p>landing page</p>} />
            <Route path="/" element={<p>home page</p>} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("landing page");
    expect(takePendingNotificationLink()).toBeNull();
  });

  it("goes home when nothing is pending", async () => {
    window.sessionStorage.clear();
    getSession.mockResolvedValue({ data: { session: { activeOrganizationId: "o-1" } } });
    render(
      <MemoryRouter initialEntries={["/login/change-password"]}>
        <ApiClientProvider client={authClientFor({ passwordChangeRequired: false })}>
          <Routes>
            <Route path="/login/change-password" element={<RequiredPasswordChange />} />
            <Route path="/" element={<p>home page</p>} />
          </Routes>
        </ApiClientProvider>
      </MemoryRouter>,
    );
    await screen.findByText("home page");
  });
});
