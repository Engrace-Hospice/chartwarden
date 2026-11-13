import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { IntakeWorkspace } from "../intake-workspace";
import type { ReferralView } from "../referrals-api";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  displayName: "Sarah Miller",
  permissions: ["referral.read", "referral.update", "referral.accept"],
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
  sexAssignedAtBirth: "M",
  referringDxText: "Lung cancer with rapid decline",
  icd10TerminalPrimary: null,
  source: "fax",
  referrerName: "Dana Case",
  referrerOrganization: "Mercy General Hospital",
  referrerPhone: null,
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
    { code: "PATIENT_UNRESOLVED", message: "Confirm or create the patient before qualification." },
  ],
};

function clientFor(value: ReferralView = referral): ApiClient {
  let current = value;
  return {
    GET: vi.fn(async (path: string) => ({
      data: path === "/api/v1/referrals/{id}" ? current : { items: [] },
      error: undefined,
      response: new Response(null, { status: 200 }),
    })),
    POST: vi.fn(async (path: string) => {
      if (path.endsWith("/review")) {
        current = {
          ...current,
          state: "under_review",
          status: "under_review",
          version: current.version + 1,
        };
      }
      if (path.endsWith("/qualify")) {
        current = {
          ...current,
          state: "qualified",
          status: "qualified",
          version: current.version + 1,
          qualificationBlockers: [],
        };
      }
      return {
        data: { id: current.id, state: current.status, version: current.version },
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    }),
    PATCH: vi.fn(async (_path: string, options: { body?: Record<string, unknown> }) => {
      const referringDxText =
        typeof options.body?.referringDxText === "string"
          ? options.body.referringDxText
          : current.referringDxText;
      const referrerName =
        typeof options.body?.referrerName === "string"
          ? options.body.referrerName
          : current.referrerName;
      const referrerOrganization =
        typeof options.body?.referrerOrganization === "string"
          ? options.body.referrerOrganization
          : current.referrerOrganization;
      current = {
        ...current,
        patientDobAtReceipt:
          typeof options.body?.patientDobAtReceipt === "string"
            ? options.body.patientDobAtReceipt
            : current.patientDobAtReceipt,
        referringDxText,
        referrerName,
        referrerOrganization,
        qualificationBlockers:
          referringDxText && (referrerName || referrerOrganization)
            ? []
            : current.qualificationBlockers,
        version: current.version + 1,
      };
      return {
        data: { id: current.id, state: current.status, version: current.version },
        error: undefined,
        response: new Response(null, { status: 200 }),
      };
    }),
  } as unknown as ApiClient;
}

function renderWorkspace(
  value?: ReferralView,
  entry = `/referrals/${referral.id}/intake`,
): ApiClient {
  const client = clientFor(value);
  render(
    <MemoryRouter initialEntries={[entry]}>
      <ApiClientProvider client={client}>
        <SessionProvider session={session}>
          <Routes>
            <Route path="/referrals/:id/intake" element={<IntakeWorkspace />} />
            <Route path="/referrals/:id" element={<div>Referral detail opened</div>} />
            <Route path="/admissions/:id" element={<div>Admission opened</div>} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
  return client;
}

describe("IntakeWorkspace", () => {
  it("shows server blockers, ownership, and one stage-specific primary action", async () => {
    renderWorkspace();

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Robert Johnson" })).toBeTruthy(),
    );
    expect(screen.getByText("Confirm or create the patient before qualification.")).toBeTruthy();
    expect(screen.getByText(/Unassigned · Canonical status/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resolve patient match" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /match patient/i })).toHaveProperty(
      "ariaCurrent",
      "step",
    );
    expect(await screen.findByRole("heading", { name: "Patient Resolution" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Referral Information" })).toBeNull();
  });

  it("uses the returned admission id for a converted referral", async () => {
    renderWorkspace({
      ...referral,
      state: "converted",
      status: "converted",
      patientResolutionStatus: "matched",
      convertedAdmissionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      qualificationBlockers: [],
    });

    expect(await screen.findByRole("button", { name: "View admission" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Resolve patient match" })).toBeNull();
  });

  it("keeps the guided steps visible when the primary action opens the review controls", async () => {
    renderWorkspace({ ...referral, state: "received", status: "received" });

    const review = await screen.findByRole("button", { name: "Start review & continue" });
    expect(await screen.findByRole("button", { name: "Start review" })).toBeTruthy();
    fireEvent.click(review);

    expect(screen.getByRole("navigation", { name: "Intake progress" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /verify information/i })).toHaveProperty(
        "ariaCurrent",
        "step",
      ),
    );
    expect(screen.getByRole("heading", { name: "Verify the referral information" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Patient Resolution" })).toBeNull();
    expect(screen.queryByText("Referral detail opened")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save & continue to patient matching" }));
    expect(await screen.findByRole("heading", { name: "Patient Resolution" })).toBeTruthy();
  });

  it("lets staff reopen completed steps, go back, and return to the current required step", async () => {
    renderWorkspace();

    await screen.findByRole("heading", { name: "Patient Resolution" });
    fireEvent.click(screen.getByRole("button", { name: /receive referral/i }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Return to Match patient" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /verify information/i }));
    expect(
      await screen.findByRole("heading", { name: "Verify the referral information" }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Date of birth"), {
      target: { value: "1958-06-24" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & return to Match patient" }));
    expect(await screen.findByRole("heading", { name: "Patient Resolution" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /verify information/i }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Return to Match patient" }));
    expect(await screen.findByRole("heading", { name: "Patient Resolution" })).toBeTruthy();
  });

  it("restores the document-capture step from a DocLens return link", async () => {
    renderWorkspace(referral, `/referrals/${referral.id}/intake?step=receive`);

    expect(
      await screen.findByRole("heading", { name: "Review the received referral" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Records" })).toBeTruthy();
    expect(screen.getByText("No records yet")).toBeTruthy();
    expect(screen.getAllByText(/continue with manual review/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Return to Match patient" })).toBeTruthy();
  });

  it("keeps View full referral as the distinct full-record route", async () => {
    renderWorkspace();

    fireEvent.click(await screen.findByRole("button", { name: "View full referral" }));
    expect(await screen.findByText("Referral detail opened")).toBeTruthy();
  });

  it("shows the exact review fields that block progress and saves them before qualification", async () => {
    const client = renderWorkspace({
      ...referral,
      patientId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      patientResolutionStatus: "created",
      patientDobAtReceipt: null,
      referringDxText: "",
      referrerName: null,
      referrerOrganization: null,
      qualificationBlockers: [
        {
          code: "CLINICAL_INDICATION_MISSING",
          message: "A referral reason or clinical indication is required before qualification.",
        },
        {
          code: "SOURCE_INFORMATION_MISSING",
          message: "Referral source information is required before qualification.",
        },
      ],
    });

    expect(
      await screen.findByRole("heading", { name: "Complete these required items" }),
    ).toBeTruthy();
    expect(screen.getByText("Enter a referral reason or clinical indication.")).toBeTruthy();
    expect(
      screen.getByText("Enter either the referring organization or referrer name."),
    ).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Referral reason or diagnosis"), {
      target: { value: "Metastatic lung cancer with rapid functional decline" },
    });
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value: "Mercy General Hospital" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save review information" }));

    expect(client.PATCH).toHaveBeenCalledWith(
      "/api/v1/referrals/{id}",
      expect.objectContaining({
        body: expect.objectContaining({ patientDobAtReceipt: undefined }),
      }),
    );

    const complete = await screen.findByRole("button", { name: "Complete referral review" });
    fireEvent.click(complete);
    expect(
      await screen.findByRole("heading", { name: "Review and start the admission" }),
    ).toBeTruthy();
  });

  it("returns a pending-information referral to review from the primary action", async () => {
    renderWorkspace({
      ...referral,
      state: "pending_information",
      status: "pending_information",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Return to referral review" }));

    expect(
      await screen.findByRole("heading", { name: "Resolve the patient identity" }),
    ).toBeTruthy();
  });

  it("opens history for a terminal referral without marking intermediate steps complete", async () => {
    renderWorkspace({
      ...referral,
      state: "declined",
      status: "declined",
      qualificationBlockers: [],
    });

    const verifyStep = await screen.findByRole("button", { name: /verify information/i });
    expect(verifyStep.textContent).not.toContain("✓");
    fireEvent.click(screen.getByRole("button", { name: "View referral history" }));

    expect(await screen.findByText("Referral detail opened")).toBeTruthy();
  });
});
