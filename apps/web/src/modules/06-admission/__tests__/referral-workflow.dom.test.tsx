import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider } from "@wardenx/ui";
import type { ApiClient } from "@wardenx/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { AdmissionCreate } from "../admission-create";
import { ReferralDetail } from "../referral-detail";
import { ReferralInbox } from "../referral-inbox";
import { ReferralNew } from "../referral-new";
import type { ReferralView } from "../referrals-api";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["referral.read", "referral.create", "referral.update", "referral.accept"],
};

const referral: ReferralView = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  state: "under_review",
  status: "under_review",
  version: 4,
  patientId: null,
  patientResolutionStatus: "unresolved",
  patientNameAtReceipt: "Robert Johnson",
  patientDobAtReceipt: "1954-05-08",
  referringDxText: "Lung cancer with rapid decline",
  icd10TerminalPrimary: "C34.90",
  source: "fax",
  referrerName: "Dana Case",
  referrerOrganization: "Mercy General Hospital",
  referrerPhone: "555-0100",
  externalReferralId: "RF-2026-00184",
  priority: "urgent",
  assignedToUserId: null,
  receivedAt: "2026-08-27T09:42:00.000Z",
  reviewedAt: null,
  qualifiedAt: null,
  declinedAt: null,
  convertedAt: null,
  convertedAdmissionId: null,
  rejectionReason: null,
  qualificationBlockers: [
    {
      code: "PATIENT_UNRESOLVED",
      message: "A patient must be confirmed or created before qualification.",
    },
  ],
};

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function clientFor(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/referrals") return ok({ items: [referral], nextCursor: null });
      if (path === "/api/v1/referrals/{id}") return ok(referral);
      if (path === "/api/v1/referrals/{id}/notes")
        return ok({
          items: [
            {
              id: "n1",
              referralId: referral.id,
              authorId: session.userId,
              content: "Packet requested.",
              createdAt: referral.receivedAt,
              updatedAt: referral.receivedAt,
            },
          ],
        });
      if (path === "/api/v1/referrals/{id}/activity")
        return ok({
          items: [
            {
              id: "a1",
              referralId: referral.id,
              actorId: session.userId,
              action: "review_started",
              fromStatus: "received",
              toStatus: "under_review",
              metadata: {},
              createdAt: referral.receivedAt,
            },
          ],
        });
      return ok({ items: [], nextCursor: null });
    }),
    POST: vi.fn(async (path: string) => {
      if (path === "/api/v1/referrals")
        return ok({ id: referral.id, state: "received", version: 1 });
      if (path.endsWith("/convert"))
        return ok({ id: referral.id, state: "converted", version: 5, admissionId: "adm-1" });
      if (path.endsWith("/notes")) return ok({ id: "n2" });
      return ok({ id: referral.id, state: "under_review", version: 5, candidates: [] });
    }),
    PATCH: vi.fn(async () => ok({ id: referral.id, state: "under_review", version: 5 })),
    ...overrides,
  } as unknown as ApiClient;
}

function renderWithShell(ui: JSX.Element, client: ApiClient, initialPath = "/"): void {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/" element={ui} />
            <Route path="/referrals/:id" element={ui} />
            <Route path="/referrals/new" element={ui} />
            <Route path="/admissions/new" element={ui} />
            <Route path="/admissions/:id" element={<div>Admission opened</div>} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe("Referral Phase 2 workflow screens", () => {
  it("renders operational referral data in the inbox and queries server-side search", async () => {
    const client = clientFor();
    renderWithShell(<ReferralInbox />, client);

    await waitFor(() => expect(screen.getByText("Robert Johnson")).toBeTruthy());
    expect(screen.getByText("Mercy General Hospital")).toBeTruthy();
    expect(screen.getAllByText("Urgent").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Not resolved").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Search referrals"), { target: { value: "Mercy" } });
    await waitFor(() =>
      expect(client.GET).toHaveBeenCalledWith(
        "/api/v1/referrals",
        expect.objectContaining({
          params: expect.objectContaining({ query: expect.objectContaining({ q: "Mercy" }) }),
        }),
      ),
    );
  });

  it("creates a referral and navigates to its detail workspace", async () => {
    const client = clientFor();
    renderWithShell(<ReferralNew />, client, "/referrals/new");

    fireEvent.change(screen.getByLabelText("Patient full name"), {
      target: { value: "Robert Johnson" },
    });
    fireEvent.change(screen.getByLabelText("Organization or facility"), {
      target: { value: "Mercy General Hospital" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create referral/i }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith("/api/v1/referrals", expect.anything()),
    );
  });

  it("prefills and pre-links a referral opened from a patient-scoped admission lookup", async () => {
    const patientId = "22222222-2222-4222-8222-222222222222";
    const client = clientFor({
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/patients/{id}")
          return ok({
            firstName: "Ava",
            lastName: "Stone",
            dob: "1950-01-01",
            status: "active",
          });
        return ok({ items: [], nextCursor: null });
      }) as unknown as ApiClient["GET"],
    });
    renderWithShell(<ReferralNew />, client, `/referrals/new?patientId=${patientId}`);

    await waitFor(() =>
      expect((screen.getByLabelText("Patient full name") as HTMLInputElement).value).toBe(
        "Ava Stone",
      ),
    );
    expect((screen.getByLabelText("Date of birth") as HTMLInputElement).value).toBe("1950-01-01");

    fireEvent.click(screen.getByRole("button", { name: /create referral/i }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/referrals",
        expect.objectContaining({
          body: expect.objectContaining({ patientId, patientNameAtReceipt: "Ava Stone" }),
        }),
      ),
    );
  });

  it("prefills direct admission when opened from a patient-scoped admission lookup", async () => {
    const patientId = "22222222-2222-4222-8222-222222222222";
    const client = clientFor();
    renderWithShell(<AdmissionCreate />, client, `/admissions/new?patientId=${patientId}`);

    expect(
      (screen.getByPlaceholderText("Search patient name or MRN...") as HTMLInputElement).value,
    ).toBe(patientId);
  });

  it("shows backend qualification blockers, notes, and activity on detail", async () => {
    const client = clientFor();
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}`);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Robert Johnson" })).toBeTruthy(),
    );
    expect(
      screen.getByText("A patient must be confirmed or created before qualification."),
    ).toBeTruthy();
    expect(screen.getByText("Packet requested.")).toBeTruthy();
    expect(screen.getByText("Review started")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /start admission/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("uses the canonical referral conversion endpoint once a referral is qualified", async () => {
    const qualified = {
      ...referral,
      status: "qualified" as const,
      state: "qualified" as const,
      patientId: "22222222-2222-4222-8222-222222222222",
      patientResolutionStatus: "matched" as const,
      qualificationBlockers: [],
    };
    const client = clientFor({
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/referrals/{id}") return ok(qualified);
        if (path === "/api/v1/referrals/{id}/notes") return ok({ items: [] });
        if (path === "/api/v1/referrals/{id}/activity") return ok({ items: [] });
        return ok({ items: [qualified], nextCursor: null });
      }) as unknown as ApiClient["GET"],
    });
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}`);

    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: /start admission/i }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: /start admission/i }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        `/api/v1/referrals/${referral.id}/convert`,
        expect.objectContaining({
          body: expect.objectContaining({ primaryDiagnosisIcd10: "C34.90", ifVersion: 4 }),
        }),
      ),
    );
    expect(await screen.findByText("Admission opened")).toBeTruthy();
  });
});
