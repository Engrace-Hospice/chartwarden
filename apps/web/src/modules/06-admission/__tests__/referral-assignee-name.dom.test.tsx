import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// Finding 9 — a referral's assignee is shown by NAME (server-resolved `assignedToDisplayName`), never by an
// 8-character prefix of the staff user id. A missing name falls back to the neutral "Staff member".
import { render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { ReferralDetail } from "../referral-detail";
import { ReferralInbox } from "../referral-inbox";

const ASSIGNEE = "17bed3e5-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "17bed3e5";
const referral = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  state: "under_review",
  status: "under_review",
  version: 4,
  patientId: null,
  patientResolutionStatus: "unresolved",
  patientNameAtReceipt: "Robert Johnson",
  patientDobAtReceipt: "1954-05-08",
  sexAssignedAtBirth: "M",
  referringDxText: "Lung cancer",
  icd10TerminalPrimary: "C34.90",
  source: "fax",
  referrerName: "Dana Case",
  referrerOrganization: "Mercy General Hospital",
  referrerPhone: "555-0100",
  externalReferralId: "RF-1",
  priority: "urgent",
  assignedToUserId: ASSIGNEE as string | null,
  assignedToDisplayName: "Nora Visit, RN" as string | null | undefined,
  receivedAt: "2026-08-27T09:42:00.000Z",
  reviewedAt: null,
  qualifiedAt: null,
  declinedAt: null,
  convertedAt: null,
  convertedAdmissionId: null,
  rejectionReason: null,
  qualificationBlockers: [],
};

function mount(ui: JSX.Element, row: typeof referral): void {
  const ok = (data: unknown) => ({ data, error: undefined, response: { status: 200 } });
  const client = {
    GET: vi.fn(async (path: string) => {
      if (path === "/api/v1/referrals") return ok({ items: [row], nextCursor: null });
      if (path === "/api/v1/referrals/{id}") return ok(row);
      return ok({ items: [], nextCursor: null });
    }),
    POST: vi.fn(),
    PATCH: vi.fn(),
  } as unknown as ApiClient;
  render(
    <MemoryRouter initialEntries={[`/referrals/${row.id}`]}>
      <ApiClientProvider client={client}>
        <SessionProvider
          session={{
            userId: "11111111-1111-4111-8111-111111111111",
            organizationId: "org-1",
            displayName: "Sarah Miller",
            permissions: ["referral.read"],
          }}
        >
          <Routes>
            <Route path="/referrals/:id" element={ui} />
          </Routes>
        </SessionProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

describe.each([
  ["inbox", <ReferralInbox key="i" />],
  ["detail", <ReferralDetail key="d" />],
])("referral %s assignee", (_label, ui) => {
  it("shows the assignee's name and never the id prefix", async () => {
    mount(ui, referral);
    await waitFor(() => expect(screen.getByText(/Assigned to Nora Visit, RN/)).toBeTruthy());
    expect(document.body.textContent).not.toContain(PREFIX);
  });

  it("falls back to a neutral label when no name resolves", async () => {
    mount(ui, { ...referral, assignedToDisplayName: undefined });
    await waitFor(() => expect(screen.getByText(/Assigned to Staff member/)).toBeTruthy());
    expect(document.body.textContent).not.toContain(PREFIX);
  });
});
