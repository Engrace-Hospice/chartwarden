import { ApiClientProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  sexAssignedAtBirth: "M",
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
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/referrals",
      expect.objectContaining({
        params: expect.objectContaining({
          query: expect.not.objectContaining({ includeConverted: true }),
        }),
      }),
    );

    fireEvent.click(screen.getByLabelText("Show converted referrals"));
    await waitFor(() =>
      expect(client.GET).toHaveBeenCalledWith(
        "/api/v1/referrals",
        expect.objectContaining({
          params: expect.objectContaining({
            query: expect.objectContaining({ includeConverted: true }),
          }),
        }),
      ),
    );

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

  it("sends the Medicare and Medicaid numbers with a new referral", async () => {
    const client = clientFor();
    renderWithShell(<ReferralNew />, client, "/referrals/new");

    fireEvent.change(screen.getByLabelText("Patient full name"), {
      target: { value: "Robert Johnson" },
    });
    fireEvent.change(screen.getByLabelText(/^Medicare number \(MBI\)/), {
      target: { value: "1EG4-TE5-MK73" },
    });
    fireEvent.change(screen.getByLabelText(/^Medicaid number/), {
      target: { value: "OR123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create referral/i }));

    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        "/api/v1/referrals",
        expect.objectContaining({
          body: expect.objectContaining({
            medicareNumberAtReceipt: "1EG4-TE5-MK73",
            medicaidNumberAtReceipt: "OR123456",
          }),
        }),
      ),
    );
  });

  it("blocks a malformed Medicare number before it is sent", async () => {
    const client = clientFor();
    renderWithShell(<ReferralNew />, client, "/referrals/new");

    fireEvent.change(screen.getByLabelText("Patient full name"), {
      target: { value: "Robert Johnson" },
    });
    // 12 characters, starts with a letter: not a CMS MBI.
    fireEvent.change(screen.getByLabelText(/^Medicare number \(MBI\)/), {
      target: { value: "A12B4590N1ZW" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create referral/i }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Medicare number must be the 11-character MBI (e.g. 1EG4-TE5-MK73).",
    );
    expect(client.POST).not.toHaveBeenCalled();
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

  it("allows referral information to be updated before qualification", async () => {
    const client = clientFor();
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}`);

    await screen.findByRole("heading", { name: "Robert Johnson" });
    fireEvent.change(screen.getByLabelText("Organization"), {
      target: { value: "St. Mary's Hospital" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save referral information/i }));

    await waitFor(() =>
      expect(client.PATCH).toHaveBeenCalledWith(
        "/api/v1/referrals/{id}",
        expect.objectContaining({
          body: expect.objectContaining({
            referrerOrganization: "St. Mary's Hospital",
            ifVersion: referral.version,
          }),
        }),
      ),
    );
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
    expect(
      (screen.getByRole("button", { name: /save referral information/i }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Organization") as HTMLInputElement).disabled).toBe(true);
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

describe("Referral Records tab (F-238 — intake starts with the referral)", () => {
  const batch = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    referralId: referral.id,
    patientId: null,
    status: "extraction_complete",
    sourceChannel: "fax",
    identityStatus: "possible",
    sudStatus: "detected",
    recordsRequestConflict: null,
    pages: 14,
    documents: 3,
    candidates: 20,
    review: { id: "r1", status: "in_progress", decided: 5 },
    uploadedAt: "2026-10-01T15:30:00.000Z",
    createdAt: "2026-10-01T15:30:00.000Z",
  };

  function recordsClient(items: unknown[], post?: ApiClient["POST"]): ApiClient {
    const base = clientFor();
    return {
      ...base,
      GET: vi.fn(async (path: string, init?: unknown) => {
        if (path === "/api/v1/intake/referral-batches")
          return ok({ items, nextCursor: null, hasMore: false });
        return (base.GET as unknown as (p: string, i?: unknown) => unknown)(path, init);
      }),
      ...(post ? { POST: post } : {}),
    } as unknown as ApiClient;
  }

  it("lists the batches filed against the referral, linking to their review", async () => {
    const client = recordsClient([batch]);
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}`);

    await screen.findByRole("heading", { name: "Robert Johnson" });
    fireEvent.click(screen.getByRole("tab", { name: "Records" }));

    await screen.findByText("Ready for review");
    expect(client.GET).toHaveBeenCalledWith(
      "/api/v1/intake/referral-batches",
      expect.objectContaining({ params: { query: { referralId: referral.id } } }),
    );
    expect(screen.getByText(/14 pages · 3 documents · 5 of 20 fields reviewed/)).toBeTruthy();
    expect(screen.getByText("Identity: check")).toBeTruthy();
    expect(screen.getByText("SUD flag — unresolved")).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Review Fax received/ }).getAttribute("href")).toBe(
      `/intake/${batch.id}/review`,
    );
    // The Overview content is not on the Records tab.
    expect(screen.queryByText("Packet requested.")).toBeNull();
  });

  it("flags a batch whose records-request code names another referral", async () => {
    const client = recordsClient([
      {
        ...batch,
        recordsRequestConflict: { code: "RR-ACDEFH7", kind: "code_names_another_referral" },
      },
    ]);
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}?tab=records`);
    expect(
      await screen.findByText("Request code is for another referral (RR-ACDEFH7)"),
    ).toBeTruthy();
  });

  it("shows an empty state when nothing has been filed", async () => {
    renderWithShell(<ReferralDetail />, recordsClient([]), `/referrals/${referral.id}?tab=records`);
    expect(await screen.findByText("No records yet")).toBeTruthy();
  });

  it("Add records uploads the file, files it against the referral and starts DocLens", async () => {
    const cryptoValue = { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/api/v1/document-uploads")
        return ok({
          uploadId: "66666666-6666-4666-8666-666666666666",
          uploadUrl: "https://storage.example/upload",
          requiredHeaders: {},
          expiresAt: "2026-10-04T10:05:00.000Z",
        });
      if (path === "/api/v1/document-uploads/{id}/complete")
        return ok({
          documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          versionId: "v1",
          versionNumber: 1,
        });
      if (path === "/api/v1/intake/uploads") return ok({ id: batch.id, status: "uploaded" });
      if (path === "/api/v1/intake/uploads/{id}/extraction/run")
        return ok({ batchId: batch.id, status: "queued" });
      return ok({});
    });
    const client = recordsClient([], post as unknown as ApiClient["POST"]);
    renderWithShell(<ReferralDetail />, client, `/referrals/${referral.id}?tab=records`);

    fireEvent.click(await screen.findByRole("button", { name: "Add records" }));
    const dialog = screen.getByRole("dialog");
    const file = new File(["%PDF-1.7"], "hospital-records.pdf", { type: "application/pdf" });
    fireEvent.change(within(dialog).getByLabelText("Records file"), { target: { files: [file] } });
    fireEvent.change(within(dialog).getByLabelText("Received by"), { target: { value: "email" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and file" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/intake/uploads/{id}/extraction/run",
        expect.objectContaining({ params: { path: { id: batch.id } } }),
      ),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/v1/document-uploads",
      expect.objectContaining({
        body: expect.objectContaining({
          aggregateType: "referral",
          aggregateId: referral.id,
          retentionClass: "intake_artifact",
          sourceMetadata: expect.objectContaining({ sourceChannel: "email" }),
        }),
      }),
    );
    expect(post).toHaveBeenCalledWith(
      "/api/v1/intake/uploads",
      expect.objectContaining({
        body: {
          documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          referralId: referral.id,
          sourceChannel: "email_ingest",
        },
      }),
    );
    expect(await screen.findByText(/Records filed\. WardenLens is reading them/)).toBeTruthy();
  });
});
