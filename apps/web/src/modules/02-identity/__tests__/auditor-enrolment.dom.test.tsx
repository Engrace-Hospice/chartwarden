// @vitest-environment jsdom
// The auditor enrolment screen (M2 §7.7): terms first-class, a first-time authenticator setup that ends in
// one-time recovery codes, a challenge for a returning auditor, plain refusals, and a lockout that disables entry.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuditorEnrolment } from "../auditor-enrolment";

const TERMS = {
  version: "2026-10-v1",
  title: "Business associate and engagement access terms",
  text: "First paragraph.\n\nSecond paragraph.",
  sha256: "a".repeat(64),
};

function view(over: Record<string, unknown> = {}) {
  return {
    stage: "enrolment",
    engagementId: "e1",
    terms: TERMS,
    baaAccepted: false,
    secondFactor: "enrol",
    totpPending: false,
    lockedUntil: null,
    expiresAt: "2030-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderPage(client: { GET: unknown; POST: unknown }): void {
  render(
    <MemoryRouter initialEntries={["/auditor/enrol"]}>
      <ApiClientProvider client={client as unknown as ApiClient}>
        <Routes>
          <Route path="/auditor/enrol" element={<AuditorEnrolment />} />
          <Route path="/" element={<p>home</p>} />
        </Routes>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("AuditorEnrolment", () => {
  it("accepts the terms only with a name and the box ticked, posting the exact version and hash", async () => {
    const get = vi.fn(async () => ({ data: view(), error: undefined }));
    const post = vi.fn(async () => ({ data: view({ baaAccepted: true }), error: undefined }));
    renderPage({ GET: get, POST: post });

    const accept = (await screen.findByRole("button", {
      name: "Accept terms",
    })) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect((screen.getByLabelText(TERMS.title) as HTMLTextAreaElement).value).toContain(
      "Second paragraph.",
    );
    fireEvent.change(screen.getByLabelText("Your full name"), { target: { value: "Ada Auditor" } });
    expect(accept.disabled).toBe(true); // still not agreed
    fireEvent.click(screen.getByLabelText("I have read and accept these terms."));
    expect(accept.disabled).toBe(false);
    fireEvent.click(accept);

    await waitFor(() => expect(screen.getByText("Terms accepted.")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/api/v1/auditors/enrolment/baa", {
      body: { termsVersion: TERMS.version, termsSha256: TERMS.sha256, acceptedName: "Ada Auditor" },
    });
  });

  it("sets up an authenticator, confirms the first code and shows the recovery codes once", async () => {
    const get = vi.fn(async () => ({ data: view({ baaAccepted: true }), error: undefined }));
    const post = vi.fn(async (path: string) => {
      if (path.endsWith("/totp/begin")) {
        return {
          data: {
            otpauthUri: "otpauth://totp/ChartWarden:a@b.test?secret=KEY",
            manualEntryKey: "KEY123",
          },
          error: undefined,
        };
      }
      return {
        data: {
          recoveryCodes: ["AAAAA-BBBBB-CCCCC-DDDDD", "EEEEE-FFFFF-GGGGG-HHHHH"],
          state: view({ stage: "active", baaAccepted: true, secondFactor: "verified" }),
        },
        error: undefined,
      };
    });
    renderPage({ GET: get, POST: post });

    fireEvent.click(await screen.findByRole("button", { name: "Set up authenticator" }));
    expect((await screen.findByLabelText("Authenticator setup key")).textContent).toBe("KEY123");
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm code" }));

    expect(await screen.findByText("AAAAA-BBBBB-CCCCC-DDDDD")).toBeTruthy();
    expect(post).toHaveBeenCalledWith("/api/v1/auditors/enrolment/totp/confirm", {
      body: { code: "123456" },
    });
    // the auditor cannot move on until they confirm the codes are saved
    const cont = screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I have saved these codes somewhere safe."));
    expect(cont.disabled).toBe(false);
    fireEvent.click(cont);
    await waitFor(() => expect(screen.getByText("You’re set")).toBeTruthy());
  });

  it("challenges a returning auditor for a code, with a recovery-code alternative", async () => {
    const get = vi.fn(async () => ({
      data: view({ baaAccepted: true, secondFactor: "challenge" }),
      error: undefined,
    }));
    const post = vi.fn(async () => ({
      data: view({ stage: "active", baaAccepted: true, secondFactor: "verified" }),
      error: undefined,
    }));
    renderPage({ GET: get, POST: post });

    await screen.findByText("Enter the 6-digit code from your authenticator app.");
    fireEvent.click(screen.getByRole("button", { name: "Use a recovery code" }));
    fireEvent.change(screen.getByLabelText("Recovery code"), {
      target: { value: "AAAAA-BBBBB-CCCCC-DDDDD" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(screen.getByText("You’re set")).toBeTruthy());
    expect(post).toHaveBeenCalledWith("/api/v1/auditors/enrolment/verify", {
      body: { recoveryCode: "AAAAA-BBBBB-CCCCC-DDDDD" },
    });
  });

  it("explains a wrong code in plain language and keeps the form usable", async () => {
    const get = vi.fn(async () => ({
      data: view({ baaAccepted: true, secondFactor: "challenge" }),
      error: undefined,
    }));
    const post = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "AUDITOR_2FA_INVALID" } },
    }));
    renderPage({ GET: get, POST: post });

    fireEvent.change(await screen.findByLabelText("Authenticator code"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toContain("That code is not valid");
  });

  it("disables entry while the factor is locked", async () => {
    const get = vi.fn(async () => ({
      data: view({
        baaAccepted: true,
        secondFactor: "challenge",
        lockedUntil: new Date(Date.now() + 600_000).toISOString(),
      }),
      error: undefined,
    }));
    renderPage({ GET: get, POST: vi.fn() });

    await screen.findByText(/Too many incorrect codes/);
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    expect((screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("tells an auditor with no session to open the link again", async () => {
    const get = vi.fn(async () => ({
      data: undefined,
      error: { error: { code: "UNAUTHORIZED" } },
    }));
    renderPage({ GET: get, POST: vi.fn() });
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Open the link from your email",
    );
  });

  it("offers Continue once the session is active", async () => {
    const get = vi.fn(async () => ({
      data: view({ stage: "active", baaAccepted: true, secondFactor: "verified" }),
      error: undefined,
    }));
    renderPage({ GET: get, POST: vi.fn() });
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    await waitFor(() => expect(screen.getByText("home")).toBeTruthy());
  });
});
