import { ApiClientProvider, ToastProvider } from "@chartwarden/ui";
import type { ApiClient } from "@chartwarden/ui";
// @vitest-environment jsdom
// ADR-0107 staff Signatures tab: list, send, withdraw, accept/reject an uploaded copy, permission hiding, and the refusals.
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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

/** Stands in for the step-up page: shows where it would send the user back to. */
function StepUpProbe() {
  const { search } = useLocation();
  return <p>step-up {new URLSearchParams(search).get("returnTo")}</p>;
}

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
              <Route path="/step-up" element={<StepUpProbe />} />
            </Routes>
          </MemoryRouter>
        </SessionProvider>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { get, post };
}

/** Accept asks for confirmation first: click the row's Accept, then confirm in the dialog. */
async function confirmAccept(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /^Accept the signed copy/ }));
  const dialog = await screen.findByRole("alertdialog", { name: "Accept signed copy" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Accept signed copy" }));
}

const deferred = <T,>() => {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** The text an alertdialog's aria-describedby points at. */
const describedText = (dialog: HTMLElement) =>
  document.getElementById(dialog.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

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
    // A destructive confirmation is an alertdialog, and a screen reader hears its consequence.
    const dialog = await screen.findByRole("alertdialog", { name: "Withdraw request" });
    expect(describedText(dialog)).toMatch(/cannot be undone/);
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

  it("starts each withdrawal from the default reason, never the last row's choice", async () => {
    mount({ items: [row({ id: "w-1" }), row({ id: "w-2" })] });
    const [first, second] = await screen.findAllByRole("button", { name: /^Withdraw/ });
    fireEvent.click(first as HTMLElement);
    let dialog = await screen.findByRole("alertdialog", { name: "Withdraw request" });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "patient_declined" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep request" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(second as HTMLElement);
    dialog = await screen.findByRole("alertdialog", { name: "Withdraw request" });
    expect((within(dialog).getByLabelText("Reason") as HTMLSelectElement).value).toBe(
      "sent_in_error",
    );
  });

  it("accepts and rejects an uploaded copy, and links to the uploaded document", async () => {
    const { post } = mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review", uploadedDocumentId: "doc-9" })],
    });
    // WCAG 2.5.3: the accessible name starts with the visible text, so "click Open uploaded copy" works by voice.
    const link = (await screen.findByRole("link", {
      name: /^Open uploaded copy/,
    })) as HTMLAnchorElement;
    expect(link.getAttribute("aria-label")?.startsWith(link.textContent?.trim() ?? "-")).toBe(true);
    expect(link.getAttribute("href")).toBe("/documents/doc-9/versions");
    await confirmAccept();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0]?.[1] as { body: unknown }).body).toEqual({
      decision: "accepted",
      uploadedDocumentId: "doc-9",
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect((post.mock.calls[1]?.[1] as { body: unknown }).body).toEqual({
      decision: "rejected",
      uploadedDocumentId: "doc-9",
    });
  });

  it("sends the reviewer to step-up when accepting needs a fresh second factor, then back here", async () => {
    mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review" })],
      post: () => ({ error: { error: { code: "STEP_UP_REQUIRED", message: "x" } } }),
    });
    await confirmAccept();
    expect(await screen.findByText("step-up /patients/p-1/signatures")).toBeTruthy();
  });

  it("says the copy changed and reloads the list when a different copy is waiting now", async () => {
    const { get } = mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review", uploadedDocumentId: "doc-9" })],
      post: () => ({ error: { error: { code: "UPLOADED_COPY_CHANGED", message: "x" } } }),
    });
    await confirmAccept();
    expect(
      await screen.findByText(/A different copy was uploaded since this list was loaded/),
    ).toBeTruthy();
    // The first load plus the reload after the refusal.
    await waitFor(() =>
      expect(get.mock.calls.filter(([url]) => url === BASE).length).toBeGreaterThanOrEqual(2),
    );
  });

  it("explains the M06 refusal when an election or notice copy is accepted here", async () => {
    mount({
      items: [row({ id: "e-1", docKind: "election_statement", status: "uploaded_pending_review" })],
      post: () => ({
        error: { error: { code: "M06_DOCUMENT_RECORDED_IN_ADMISSION", message: "x" } },
      }),
    });
    await confirmAccept();
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

  it("asks for confirmation before accepting, and Cancel sends nothing", async () => {
    const { post } = mount({ items: [row({ id: "u-1", status: "uploaded_pending_review" })] });
    fireEvent.click(await screen.findByRole("button", { name: /^Accept the signed copy/ }));
    const dialog = await screen.findByRole("alertdialog", { name: "Accept signed copy" });
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    expect(describedText(dialog)).toMatch(/cannot be undone/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps each row busy on its own call, so two rows in flight cannot double-decide", async () => {
    const calls = new Map<string, ReturnType<typeof deferred<unknown>>>();
    const { post } = mount({
      items: [
        row({ id: "a", status: "uploaded_pending_review" }),
        row({ id: "b", status: "uploaded_pending_review", docKind: "consent_to_treat" }),
      ],
      post: (_url, init) => {
        const id = (init as unknown as { params: { path: { requestId: string } } }).params.path
          .requestId;
        const d = deferred<unknown>();
        calls.set(id, d);
        return d.promise;
      },
    });
    const rejects = await screen.findAllByRole("button", { name: /^Reject/ });
    fireEvent.click(rejects[0] as HTMLElement);
    fireEvent.click(rejects[1] as HTMLElement);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    // Row a's answer arrives first; row b is still in flight and must stay locked.
    calls.get("a")?.resolve({ data: {}, error: undefined });
    await waitFor(() =>
      expect(
        (screen.getAllByRole("button", { name: /^Reject/ })[0] as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const rowB = screen.getAllByRole("button", { name: /^Reject/ })[1] as HTMLButtonElement;
    expect(rowB.disabled).toBe(true);
    fireEvent.click(rowB);
    expect(post).toHaveBeenCalledTimes(2);
    calls.get("b")?.resolve({ data: {}, error: undefined });
  });

  it("reuses the Idempotency-Key when the same decision is retried after a network failure", async () => {
    let attempt = 0;
    const { post } = mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review" })],
      post: () => {
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { data: {}, error: undefined };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    expect(await screen.findByText(/could not reach the server/)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const keyOf = (i: number) =>
      (post.mock.calls[i]?.[1] as unknown as { headers: Record<string, string> }).headers[
        "Idempotency-Key"
      ];
    expect(keyOf(0)).toBeTruthy();
    expect(keyOf(1)).toBe(keyOf(0));
  });

  it("drops the Idempotency-Key after a 5xx answer, so a retry is not replayed the cached failure", async () => {
    let attempt = 0;
    const { post } = mount({
      items: [row({ id: "u-1", status: "uploaded_pending_review" })],
      post: () => {
        attempt += 1;
        return attempt === 1
          ? {
              error: { error: { code: "INTERNAL", message: "x" } },
              response: new Response(null, { status: 503 }),
            }
          : { data: {}, error: undefined };
      },
    });
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: /^Reject/ }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    const keyOf = (i: number) =>
      (post.mock.calls[i]?.[1] as unknown as { headers: Record<string, string> }).headers[
        "Idempotency-Key"
      ];
    expect(keyOf(1)).not.toBe(keyOf(0));
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
