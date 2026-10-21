// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import type { Session } from "../../../shell/session";
import { ReferralDetail } from "../../06-admission/referral-detail";
import { PatientDocuments } from "../patient-documents";

const patientId = "22222222-2222-4222-8222-222222222222";
const referralId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const docId = "33333333-3333-4333-8333-333333333333";
const v1 = "44444444-4444-4444-8444-444444444444";
const v2 = "55555555-5555-4555-8555-555555555555";

const session: Session = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  membershipId: "membership-1",
  displayName: "Sarah Miller",
  permissions: ["documents.read", "documents.upload", "documents.read_history", "referral.read"],
};

const patient = {
  mrn: "MRN-7",
  firstName: "June",
  lastName: "Rivera",
  dob: "1950-02-14",
  status: "active",
};

const referral = {
  id: referralId,
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
  qualificationBlockers: [],
};

function documentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: docId,
    organizationId: "org-1",
    patientId,
    admissionId: null,
    retentionClass: "clinical_record",
    aggregateType: "code_status_directive",
    aggregateId: null,
    title: "Patient POLST",
    patientFacing: false,
    attachToDisclosures: false,
    metadata: { documentType: "code_status_directive", sourceChannel: "manual_upload" },
    status: "active",
    version: 1,
    versionsCount: 1,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function versionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: v1,
    documentId: docId,
    versionNumber: 1,
    mimeType: "application/pdf",
    byteSize: 128,
    uploadedAt: "2026-08-30T10:00:00.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    ...overrides,
  };
}

function ok(data: unknown) {
  return { data, error: undefined, response: new Response(null, { status: 200 }) };
}

function renderPatient(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={[`/patients/${patientId}/documents`]}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route path="/patients/:patientId/documents" element={<PatientDocuments />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

function renderReferral(client: ApiClient): void {
  render(
    <MemoryRouter initialEntries={[`/referrals/${referralId}`]}>
      <ApiClientProvider client={client}>
        <ToastProvider>
          <SessionProvider session={session}>
            <Routes>
              <Route path="/referrals/:id" element={<ReferralDetail />} />
            </Routes>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  const cryptoValue = {
    randomUUID: () => "99999999-9999-4999-8999-999999999999",
    subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) },
  };
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: cryptoValue,
  });
  Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: vi.fn(async () => new Response(null, { status: 200 })),
  });
  Object.defineProperty(window, "open", { configurable: true, value: vi.fn() });
});

describe("M22 document workflows", () => {
  it("uploads a patient POLST through verified upload and shows it in the list", async () => {
    let uploaded = false;
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/patients/{id}") return ok(patient);
        if (path === "/api/v1/documents")
          return ok({ items: uploaded ? [documentRow()] : [], nextCursor: null, hasMore: false });
        if (path === "/api/v1/documents/{id}/versions")
          return ok({ items: [versionRow()], nextCursor: null, hasMore: false });
        return ok(null);
      }),
      POST: vi.fn(async (path: string) => {
        if (path === "/api/v1/document-uploads")
          return ok({
            uploadId: "66666666-6666-4666-8666-666666666666",
            uploadUrl: "https://storage.example/upload",
            requiredHeaders: {},
            expiresAt: "2026-08-30T10:05:00.000Z",
          });
        if (path === "/api/v1/document-uploads/{id}/complete") {
          uploaded = true;
          return ok({ documentId: docId, versionId: v1, versionNumber: 1 });
        }
        return ok({});
      }),
      DELETE: vi.fn(async () => ok({})),
    } as unknown as ApiClient;

    renderPatient(client);

    fireEvent.click(await screen.findByRole("button", { name: /upload document/i }));
    const file = new File(["%PDF-1.7"], "polst.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^upload (document|new version)$/i,
      }),
    );

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/document-uploads",
        expect.objectContaining({
          body: expect.objectContaining({
            patientId,
            aggregateType: "code_status_directive",
            sourceMetadata: expect.objectContaining({
              documentType: "code_status_directive",
              sourceChannel: "manual_upload",
            }),
          }),
        }),
      ),
    );
    expect(await screen.findByText("Patient POLST")).toBeTruthy();
    expect(screen.getAllByText("POLST").length).toBeGreaterThan(0);
  });

  it("uploads a new POLST version without creating a new logical document", async () => {
    let upgraded = false;
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/patients/{id}") return ok(patient);
        if (path === "/api/v1/documents")
          return ok({
            items: [documentRow({ version: upgraded ? 2 : 1 })],
            nextCursor: null,
            hasMore: false,
          });
        if (path === "/api/v1/documents/{id}/versions")
          return ok({
            items: upgraded
              ? [versionRow({ id: v2, versionNumber: 2 }), versionRow()]
              : [versionRow()],
            nextCursor: null,
            hasMore: false,
          });
        return ok(null);
      }),
      POST: vi.fn(async (path: string) => {
        if (path === "/api/v1/document-uploads")
          return ok({
            uploadId: "66666666-6666-4666-8666-666666666666",
            uploadUrl: "https://storage.example/upload",
            requiredHeaders: {},
            expiresAt: "2026-08-30T10:05:00.000Z",
          });
        if (path === "/api/v1/document-uploads/{id}/complete") {
          upgraded = true;
          return ok({ documentId: docId, versionId: v2, versionNumber: 2 });
        }
        return ok({});
      }),
      DELETE: vi.fn(async () => ok({})),
    } as unknown as ApiClient;

    renderPatient(client);

    fireEvent.click(await screen.findByRole("button", { name: /more actions for/i }));
    fireEvent.click(screen.getByRole("button", { name: /upload new version/i }));
    const file = new File(["%PDF-1.7 version 2"], "polst-v2.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^upload (document|new version)$/i,
      }),
    );

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/document-uploads",
        expect.objectContaining({
          body: expect.objectContaining({ mode: "new_version", targetDocumentId: docId }),
        }),
      ),
    );
    expect(await screen.findByText(/PDF • v2/i)).toBeTruthy();
  });

  it("uploads referral fax provenance before patient matching", async () => {
    let uploaded = false;
    const client = {
      GET: vi.fn(async (path: string) => {
        if (path === "/api/v1/referrals/{id}") return ok(referral);
        if (path === "/api/v1/referrals/{id}/notes") return ok({ items: [] });
        if (path === "/api/v1/referrals/{id}/activity") return ok({ items: [] });
        if (path === "/api/v1/documents")
          return ok({
            items: uploaded
              ? [
                  documentRow({
                    patientId: null,
                    aggregateType: "referral",
                    aggregateId: referralId,
                    title: "Referral packet",
                    metadata: {
                      documentType: "referral",
                      sourceChannel: "fax",
                      faxReference: "FX-9",
                    },
                  }),
                ]
              : [],
            nextCursor: null,
            hasMore: false,
          });
        if (path === "/api/v1/documents/{id}/versions")
          return ok({ items: [versionRow()], nextCursor: null, hasMore: false });
        return ok(null);
      }),
      POST: vi.fn(async (path: string) => {
        if (path === "/api/v1/document-uploads")
          return ok({
            uploadId: "66666666-6666-4666-8666-666666666666",
            uploadUrl: "https://storage.example/upload",
            requiredHeaders: {},
            expiresAt: "2026-08-30T10:05:00.000Z",
          });
        if (path === "/api/v1/document-uploads/{id}/complete") {
          uploaded = true;
          return ok({ documentId: docId, versionId: v1, versionNumber: 1 });
        }
        return ok({});
      }),
      PATCH: vi.fn(async () => ok({})),
      DELETE: vi.fn(async () => ok({})),
    } as unknown as ApiClient;

    renderReferral(client);

    fireEvent.click(await screen.findByRole("button", { name: /upload document/i }));
    fireEvent.change(screen.getByLabelText("Fax reference"), { target: { value: "FX-9" } });
    const file = new File(["%PDF-1.7"], "referral.pdf", { type: "application/pdf" });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^upload (document|new version)$/i,
      }),
    );

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/document-uploads",
        expect.objectContaining({
          body: expect.objectContaining({
            patientId: undefined,
            aggregateType: "referral",
            aggregateId: referralId,
            sourceMetadata: expect.objectContaining({
              documentType: "referral",
              sourceChannel: "fax",
              faxReference: "FX-9",
            }),
          }),
        }),
      ),
    );
    expect(await screen.findByText("Referral packet")).toBeTruthy();
    expect(screen.getAllByText(/Fax/).length).toBeGreaterThan(0);
  });
});
