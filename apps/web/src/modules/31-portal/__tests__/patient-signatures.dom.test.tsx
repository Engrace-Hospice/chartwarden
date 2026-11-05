import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// ADR-0107 staff Signatures tab: list, send, withdraw, accept/reject an uploaded copy, permission hiding, and the refusals.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../../shell/session";
import { PatientSignatures } from "../patient-signatures";

afterEach(cleanup);

const BASE = "/api/v1/admin/portal-signature-requests";
const row = (over: Record<string, unknown>) => ({
  id: "r-1",
  patientId: "p-1",
  docKind: "hipaa_npp_acknowledgement",
  status: "pending",
  templateVersion: "1.0.0",
  requestedAt: "2026-11-01T12:00:00.000Z",
  lastRemindedAt: null,
  reminderCount: 0,
  signedAt: null,
  signerRole: null,
  voidReason: null,
  uploadedDocumentId: null,
  reviewOutcome: null,
  ...over,
});
const ALL = [
  "portal.signature_request.read",
  "portal.signature_request.create",
  "portal.signature_request.void",
  "portal.signature_request.review",
];

function mount(opts: {
  items: unknown[];
  permissions?: string[];
  post?: (url: string, init: { body?: unknown }) => unknown;
}) {
  const get = vi.fn(async (url: string) => {
    if (url === BASE) return { data: { items: opts.items }, error: undefined };
    if (url === "/api/v1/patients/{patientId}/election-certification")
      return {
        data: {
          admission: { id: "adm-1" },
          periods: [{ electionStatement: { id: "es-1", status: "drafted" } }],
        },
        error: undefined,
      };
    return { data: undefined, error: { error: { code: "NOT_FOUND" } } };
  });
  const post = vi.fn(async (url: string, init: { body?: unknown }) =>
    opts.post ? opts.post(url, init) : { data: {}, error: undefined },
  );
  render(
    <ApiClientProvider client={{ GET: get, POST: post } as unknown as ApiClient}>
      <ToastProvider>
        <SessionProvider
          session={{
            userId: "u-1",
            organizationId: "o-1",
            roles: [],
            permissions: opts.permissions ?? ALL,
          }}
        >
          <MemoryRouter initialEntries={["/patients/p-1/signatures"]}>
            <Routes>
              <Route path="/patients/:patientId/signatures" element={<PatientSignatures />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { get, post };
}

describe("PatientSignatures", () => {
  it("lists requests with status, reminders and signer role, and never shows signer text", async () => {
    mount({
      items: [
        row({ id: "a", reminderCount: 2, lastRemindedAt: "2026-11-03T14:00:00.000Z" }),
        row({
          id: "b",
          docKind: "consent_to_treat",
          status: "signed",
          signerRole: "caregiver_on_behalf",
          signedAt: "2026-11-02T12:00:00.000Z",
        }),
        row({
          id: "c",
          docKind: "election_statement",
          status: "voided",
          voidReason: "patient_declined",
        }),
      ],
    });
    const table = await screen.findByRole("table", { name: "Signature requests" });
    expect(within(table).getByText("Waiting for signature")).toBeTruthy();
    expect(within(table).getByText(/2 sent, last/)).toBeTruthy();
    expect(within(table).getByText("Signed by: Family caregiver")).toBeTruthy();
    expect(within(table).getByText("Patient declined")).toBeTruthy();
    // No actions on a signed or withdrawn row: only the pending row has Withdraw.
    expect(within(table).getAllByRole("button", { name: /^Withdraw/ })).toHaveLength(1);
  });

  it("sends a privacy notice with an idempotency key and refreshes the list", async () => {
    const { post, get } = mount({ items: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Send for signature" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Send" }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, init] = post.mock.calls[0] as [
      string,
      { body: unknown; headers: Record<string, string> },
    ];
    expect(url).toBe(BASE);
    expect(init.body).toEqual({ patientId: "p-1", docKind: "hipaa_npp_acknowledgement" });
    expect(init.headers["Idempotency-Key"]).toBeTruthy();
    await waitFor(() =>
      expect(get.mock.calls.filter((c) => c[0] === BASE).length).toBeGreaterThan(1),
    );
  });

  it("offers the election and notice of rights with their M06 target, labels consent pending legal review", async () => {
    const { post } = mount({ items: [] });
    fireEvent.click(await screen.findByRole("button", { name: "Send for signature" }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText("Document") as HTMLSelectElement;
    await waitFor(() =>
      expect([...select.options].map((o) => o.text)).toContain("Hospice election statement"),
    );
    expect([...select.options].map((o) => o.text)).toContain(
      "Consent to treat (pending legal review)",
    );
    fireEvent.change(select, { target: { value: "election_statement" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send" }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      patientId: "p-1",
      docKind: "election_statement",
      targetRef: "es-1",
    });
  });

  it("shows the duplicate refusal in the dialog and keeps it open", async () => {
    mount({
      items: [],
      post: () => ({ error: { error: { code: "SIGNATURE_REQUEST_ALREADY_OPEN", message: "x" } } }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Send for signature" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Send" }),
    );
    expect(await screen.findByText(/already open for this patient/)).toBeTruthy();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("withdraws an open request with the chosen coded reason", async () => {
    const { post } = mount({ items: [row({ id: "w-1" })] });
    fireEvent.click(await screen.findByRole("button", { name: /^Withdraw/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "patient_declined" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Withdraw/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, init] = post.mock.calls[0] as [string, { params: unknown; body: unknown }];
    expect(url).toBe(`${BASE}/{requestId}/void`);
    expect(init.params).toEqual({ path: { requestId: "w-1" } });
    expect(init.body).toEqual({ reason: "patient_declined" });
  });

  it("accepts and rejects an uploaded copy, and links to the uploaded document", async () => {
    const { post } = mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review", uploadedDocumentId: "doc-9" })],
    });
    const link = (await screen.findByRole("link", {
      name: /^Open the uploaded copy/,
    })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/documents/doc-9/versions");
    fireEvent.click(screen.getByRole("button", { name: /^Accept/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({ decision: "accepted" });
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect((post.mock.calls[1]?.[1] as { body: unknown }).body).toEqual({ decision: "rejected" });
  });

  it("explains the M06 refusal when an election or notice copy is accepted here", async () => {
    mount({
      items: [row({ id: "e-1", docKind: "election_statement", status: "uploaded_pending_review" })],
      post: () => ({
        error: { error: { code: "M06_DOCUMENT_RECORDED_IN_ADMISSION", message: "x" } },
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Accept/ }));
    expect(
      await screen.findByText(/Record this paper signature in the admission workflow/),
    ).toBeTruthy();
  });

  it("hides actions the viewer lacks the permission for", async () => {
    mount({
      items: [
        row({ id: "p-1" }),
        row({ id: "p-2", status: "uploaded_pending_review", docKind: "consent_to_treat" }),
      ],
      permissions: ["portal.signature_request.read"],
    });
    await screen.findByRole("table", { name: "Signature requests" });
    expect(screen.queryByRole("button", { name: "Send for signature" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Withdraw/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Accept/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reject/ })).toBeNull();
  });

  it("says so when the list cannot be loaded", async () => {
    const get = vi.fn(async () => ({ data: undefined, error: { error: { code: "X" } } }));
    render(
      <ApiClientProvider client={{ GET: get, POST: vi.fn() } as unknown as ApiClient}>
        <ToastProvider>
          <SessionProvider
            session={{ userId: "u", organizationId: "o", roles: [], permissions: ALL }}
          >
            <MemoryRouter initialEntries={["/patients/p-1/signatures"]}>
              <Routes>
                <Route path="/patients/:patientId/signatures" element={<PatientSignatures />} />
              </Routes>
            </MemoryRouter>
          </SessionProvider>
        </ToastProvider>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Signatures unavailable")).toBeTruthy();
  });
});
