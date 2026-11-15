import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { NoeExceptionReview } from "../noe-exception-review";

const NOE = "50000000-0000-4000-8000-000000000001";
const PATIENT = "50000000-0000-4000-8000-000000000002";
const DOC = "50000000-0000-4000-8000-000000000003";
const INACTIVE_DOC = "50000000-0000-4000-8000-000000000004";
const noe = {
  noeId: NOE,
  organizationId: "synthetic-org",
  providerEntityId: "50000000-0000-4000-8000-000000000005",
  patientId: PATIENT,
  admissionId: "50000000-0000-4000-8000-000000000006",
  electionPeriodId: "50000000-0000-4000-8000-000000000007",
  state: "ack_rejected",
  electionEffectiveDate: "2026-10-02",
  windowTargetAt: "2026-10-07",
  windowBreachedAt: "2026-10-08",
  noeControlNumber: "synthetic-control",
  payerNoeControlNumber: null,
  latestSubmissionId: null,
  latestAcknowledgmentId: null,
  confirmationDocumentId: null,
  version: 1,
  createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-08T12:00:00.000Z",
  acceptedAt: null,
  rejectedAt: "2026-10-08T12:00:00.000Z",
  rejectionStage: "999",
  rejectionCodes: ["synthetic"],
  payerStatusDate: null,
  payerStatusDateSource: null,
  correctsNoticeId: null,
  correctionReason: null,
  correctedBy: null,
  externalFiling: null,
};
const document = (id: string, status: "active" | "superseded") => ({
  id,
  organizationId: "synthetic-org",
  patientId: PATIENT,
  admissionId: null,
  retentionClass: "clinical_record",
  aggregateType: "election_statement",
  aggregateId: null,
  title: "Synthetic election evidence",
  patientFacing: false,
  attachToDisclosures: false,
  metadata: { documentType: "election_statement" },
  status,
  version: 1,
  versionsCount: 1,
  createdAt: "2026-10-02T12:00:00.000Z",
  updatedAt: "2026-10-02T12:00:00.000Z",
});
const authorized: Session = {
  userId: "synthetic-user",
  organizationId: "synthetic-org",
  permissions: ["billing.noe.read", "billing.noe.submit"],
};

function mount(client: object, session: Session = authorized): void {
  render(
    <ApiClientProvider client={client as ApiClient}>
      <SessionProvider session={session}>
        <MemoryRouter initialEntries={[`/billing/noe/${NOE}/exception-review`]}>
          <Routes>
            <Route path="/billing/noe/:noeId/exception-review" element={<NoeExceptionReview />} />
            <Route path="/step-up" element={<p>Step-up</p>} />
          </Routes>
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

describe("NOE exception review UI", () => {
  it("uses server deadline data and only active M22 metadata to create a review with idempotency", async () => {
    const GET = vi.fn(async (path: string) => {
      if (path === "/api/v1/noe-records/{id}") return { data: noe as never, error: undefined };
      if (path === "/api/v1/noe-records/{id}/exception-reviews")
        return { data: { items: [] } as never, error: undefined };
      if (path === "/api/v1/documents")
        return {
          data: { items: [document(DOC, "active"), document(INACTIVE_DOC, "superseded")] } as never,
          error: undefined,
        };
      return { data: undefined, error: { error: { code: "NOT_FOUND" } } };
    });
    const POST = vi.fn(async () => ({
      data: { id: "50000000-0000-4000-8000-000000000008" },
      error: undefined,
      response: new Response(null, { status: 201 }),
    }));
    mount({ GET, POST });

    expect(await screen.findByText("2026-10-07")).toBeTruthy();
    expect(screen.getByText(/Server-recorded breach · 2026-10-08/)).toBeTruthy();
    expect(screen.getByText("Not verified")).toBeTruthy();
    expect(screen.getAllByText(/Synthetic election evidence · election statement/)).toHaveLength(2);
    expect(screen.queryByText(INACTIVE_DOC)).toBeNull();
    expect(screen.getByText(/WardenX does not decide exception eligibility/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/Circumstance category/), {
      target: { value: "cms_mac_system_issue" },
    });
    fireEvent.change(screen.getByLabelText("Justification document"), { target: { value: DOC } });
    fireEvent.click(screen.getByRole("button", { name: "Save review" }));
    await waitFor(() =>
      expect(POST).toHaveBeenCalledWith("/api/v1/noe-records/{id}/exception-reviews", {
        params: { path: { id: NOE }, header: { "Idempotency-Key": expect.any(String) } },
        body: {
          category: "cms_mac_system_issue",
          justificationDocumentId: DOC,
          evidenceDocumentIds: [],
        },
      }),
    );
    expect(await screen.findByText(/does not file a notice or verify MAC acceptance/)).toBeTruthy();
    expect(POST).toHaveBeenCalledTimes(1);
  });
});
