import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import type { Session } from "../../shell/session";
import { stepUpDraftKeys } from "../../shell/step-up-redirect";
import { ClinicianCredentials } from "./clinician-credentials";

/** The step-up route: shows where the ceremony was asked to return to. */
function StepUpProbe(): JSX.Element {
  const location = useLocation();
  return (
    <>
      <h1>Step-up ceremony</h1>
      <output data-testid="step-up-search">{location.search}</output>
    </>
  );
}

const session: Session = {
  userId: "user-1",
  organizationId: "org-1",
  roles: [],
  permissions: [
    "membership_credential.read",
    "membership_credential.grant",
    "membership_credential.revoke",
  ],
};

function renderCredentials(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={["/scheduling/clinician-credentials?membership=member-1"]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <ClinicianCredentials />
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Clinician credentials page", () => {
  it("shows a credential table and keeps date validation inside the add dialog", async () => {
    const client = {
      GET: vi.fn(async () => ({
        data: [
          {
            id: "cred-1",
            membershipId: "member-1",
            credentialType: "rn",
            status: "active",
            effectiveAt: "2026-01-01",
            expiresAt: "2027-01-01",
            revokedAt: null,
            revokedReason: null,
            issuingBody: "State board",
          },
        ],
      })),
      POST: vi.fn(async () => ({ data: {} })),
      DELETE: vi.fn(async () => ({})),
    } as unknown as ApiClient;
    renderCredentials(client);

    expect(await screen.findByRole("table", { name: /clinical credentials/i })).toBeTruthy();
    expect(screen.getByText("Registered Nurse (RN)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Expiration date"), { target: { value: "2020-01-01" } });
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Add clinical credential" })).getByRole("button", {
        name: "Add credential",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Expiration date must be on or after the effective date.",
    );
    expect(client.POST).not.toHaveBeenCalled();
  });

  it("says why a licence on the caller's own membership was refused, and keeps the dialog open", async () => {
    const client = {
      GET: vi.fn(async () => ({ data: [] })),
      POST: vi.fn(async () => ({
        error: { error: { code: "CREDENTIAL_SELF_GRANT_REFUSED", message: "refused" } },
      })),
      DELETE: vi.fn(async () => ({})),
    } as unknown as ApiClient;
    renderCredentials(client);

    fireEvent.click(await screen.findByRole("button", { name: /add credential/i }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Add clinical credential" })).getByRole("button", {
        name: "Add credential",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "You cannot record a license on your own membership. Ask another administrator to record it.",
    );
    expect(screen.getByRole("dialog", { name: "Add clinical credential" })).toBeTruthy();
  });

  it("sends the user to the step-up ceremony when the grant needs a fresh step-up", async () => {
    const client = {
      GET: vi.fn(async () => ({ data: [] })),
      POST: vi.fn(async () => ({
        error: { error: { code: "STEP_UP_REQUIRED", message: "re-authenticate" } },
      })),
      DELETE: vi.fn(async () => ({})),
    } as unknown as ApiClient;
    render(
      <MemoryRouter initialEntries={["/scheduling/clinician-credentials?membership=member-1"]}>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <Routes>
              <Route path="/scheduling/clinician-credentials" element={<ClinicianCredentials />} />
              <Route path="/step-up" element={<StepUpProbe />} />
            </Routes>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /add credential/i }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Add clinical credential" })).getByRole("button", {
        name: "Add credential",
      }),
    );

    expect(await screen.findByRole("heading", { name: "Step-up ceremony" })).toBeTruthy();
    // it comes back to the same clinician, and nothing was stashed across the ceremony
    expect(screen.getByTestId("step-up-search").textContent).toBe(
      `?returnTo=${encodeURIComponent("/scheduling/clinician-credentials?membership=member-1")}`,
    );
    expect(stepUpDraftKeys()).toEqual([]);
  });

  it("sends the user to the step-up ceremony when the revoke needs a fresh step-up", async () => {
    const client = {
      GET: vi.fn(async () => ({
        data: [
          {
            id: "cred-1",
            membershipId: "member-1",
            credentialType: "rn",
            status: "active",
            effectiveAt: "2026-01-01",
            expiresAt: null,
            revokedAt: null,
            revokedReason: null,
            issuingBody: null,
          },
        ],
      })),
      POST: vi.fn(async () => ({ data: {} })),
      DELETE: vi.fn(async () => ({
        error: { error: { code: "STEP_UP_REQUIRED", message: "re-authenticate" } },
      })),
    } as unknown as ApiClient;
    render(
      <MemoryRouter initialEntries={["/scheduling/clinician-credentials?membership=member-1"]}>
        <ApiClientProvider client={client}>
          <SessionProvider session={session}>
            <Routes>
              <Route path="/scheduling/clinician-credentials" element={<ClinicianCredentials />} />
              <Route path="/step-up" element={<StepUpProbe />} />
            </Routes>
          </SessionProvider>
        </ApiClientProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText("Reason for revocation"), {
      target: { value: "Expired license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));

    expect(await screen.findByRole("heading", { name: "Step-up ceremony" })).toBeTruthy();
  });

  it("keeps the generic message for a 403 that is not a step-up or a self-grant", async () => {
    const client = {
      GET: vi.fn(async () => ({ data: [] })),
      POST: vi.fn(async () => ({ error: { error: { code: "FORBIDDEN", message: "no" } } })),
      DELETE: vi.fn(async () => ({})),
    } as unknown as ApiClient;
    renderCredentials(client);

    fireEvent.click(await screen.findByRole("button", { name: /add credential/i }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Add clinical credential" })).getByRole("button", {
        name: "Add credential",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Credential could not be added. Review the details and try again.",
    );
  });

  it("keeps a failed revocation open with an actionable error", async () => {
    const client = {
      GET: vi.fn(async () => ({
        data: [
          {
            id: "cred-1",
            membershipId: "member-1",
            credentialType: "rn",
            status: "active",
            effectiveAt: "2026-01-01",
            expiresAt: null,
            revokedAt: null,
            revokedReason: null,
            issuingBody: null,
          },
        ],
      })),
      POST: vi.fn(async () => ({ data: {} })),
      DELETE: vi.fn(async () => ({ error: { message: "Unavailable" } })),
    } as unknown as ApiClient;
    renderCredentials(client);

    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText("Reason for revocation"), {
      target: { value: "Expired license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));
    await waitFor(() => expect(client.DELETE).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Credential could not be revoked. Please try again.",
    );
    expect(screen.getByRole("dialog", { name: "Revoke clinical credential" })).toBeTruthy();
  });
});
