import { createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const REQ_PENDING = "22222222-2222-4222-8222-222222222222";
const REQ_PARKED = "33333333-3333-4333-8333-333333333333";
const REQ_SIGNED = "44444444-4444-4444-8444-444444444444";
const UPLOAD = "55555555-5555-4555-8555-555555555555";
const SIGN = `/api/v1/portal/signature-requests/${REQ_PENDING}/sign`;
const ATTEST = "By typing my name I agree to this document.";
const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, code: string): Response =>
  json({ error: { code, message: code } }, status);

const ITEMS = [
  {
    id: REQ_PENDING,
    docKind: "hipaa_npp_acknowledgement",
    status: "pending",
    templateKey: "t",
    templateVersion: "1.0.0",
    requestedAt: "2026-10-01T12:00:00Z",
    signedAt: null,
    signerRole: null,
  },
  {
    id: REQ_PARKED,
    docKind: "notice_of_patient_rights",
    status: "uploaded_pending_review",
    templateKey: "t",
    templateVersion: "1.0.0",
    requestedAt: "2026-10-01T12:00:00Z",
    signedAt: null,
    signerRole: null,
  },
  {
    id: REQ_SIGNED,
    docKind: "election_statement",
    status: "signed",
    templateKey: "t",
    templateVersion: "1.0.0",
    requestedAt: "2026-09-01T12:00:00Z",
    signedAt: "2026-09-02T12:00:00Z",
    signerRole: "patient",
  },
];

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: unknown;
}

function clientFor(handler: (seen: Seen) => Response | Promise<Response>, seen: Seen[] = []) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/portal/sessions/current")
        return json({
          portalAccountId: "66666666-6666-4666-8666-666666666666",
          activePatientId: PATIENT,
          scopeSet: [],
          relationship: "patient_self",
          status: "active",
        });
      if (url.pathname === "/api/v1/portal/care-summary")
        return json({
          patient: { layLabel: "Sample Patient" },
          upcomingVisitsCount: 0,
          recentVisitsCount: 0,
          activeMedicationsCount: 0,
          unreadMessagesCount: 0,
          pendingDocumentSharesCount: 0,
        });
      const raw = await request.clone().text();
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        // a binary upload body stays as text
      }
      const entry = { method: request.method, path: url.pathname, headers: request.headers, body };
      seen.push(entry);
      return handler(entry);
    },
  });
}

/** The default server: the list, one detail, a working step-up, and whatever `extra` answers first. */
const server =
  (extra: (seen: Seen) => Response | undefined = () => undefined) =>
  (seen: Seen): Response => {
    const answered = extra(seen);
    if (answered) return answered;
    if (seen.path === "/api/v1/portal/signature-requests") return json({ items: ITEMS });
    if (seen.path === `/api/v1/portal/signature-requests/${REQ_PENDING}`)
      return json({
        ...ITEMS[0],
        attestationText: ATTEST,
        documentTitle: "Notice of Privacy Practices",
        documentParagraphs: ["You received a copy of the Notice."],
      });
    if (seen.path === "/api/v1/portal/sessions/step-up") return json({ ok: true });
    return json({}, 404);
  };

async function openSigning(): Promise<HTMLElement> {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Review and sign: Notice of privacy practices acknowledgement",
    }),
  );
  return screen.findByRole("dialog", { name: "Sign this document" });
}

function fillAndSubmit(dialog: HTMLElement, name = "Pat Example"): void {
  fireEvent.change(within(dialog).getByLabelText("Your full name"), { target: { value: name } });
  fireEvent.click(within(dialog).getByRole("checkbox"));
  fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
    target: { value: "123456" },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Sign" }));
}

describe("portal documents to sign (ADR-0107)", () => {
  beforeEach(() => {
    window.history.pushState({}, "", `/portal/p/${PATIENT}/signatures`);
    vi.restoreAllMocks();
  });

  it("lists requests in plain words with their status, and offers signing only for the open one", async () => {
    render(<PortalApp client={clientFor(server())} />);
    expect(await screen.findByText("Notice of privacy practices acknowledgement")).toBeTruthy();
    expect(screen.getByText("Needs your signature")).toBeTruthy();
    expect(screen.getByText("Waiting for your care team to review")).toBeTruthy();
    expect(screen.getByText("Hospice election statement")).toBeTruthy();
    expect(screen.getByText(/^Signed 2026|^Signed .*2026/)).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Review and sign/ })).toHaveLength(1);
  });

  it("says plainly when there is nothing to sign", async () => {
    render(
      <PortalApp
        client={clientFor((seen) =>
          seen.path === "/api/v1/portal/signature-requests" ? json({ items: [] }) : json({}, 404),
        )}
      />,
    );
    expect(await screen.findByText("You have nothing to sign right now.")).toBeTruthy();
  });

  it("signs: reads the statement, steps up with the code, then signs with a name, the attestation and an Idempotency-Key", async () => {
    const seen: Seen[] = [];
    render(<PortalApp client={clientFor(server(), seen)} />);
    const dialog = await openSigning();
    expect(await within(dialog).findByText(ATTEST)).toBeTruthy();
    expect(within(dialog).getByText("You received a copy of the Notice.")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Sign" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fillAndSubmit(dialog);
    await waitFor(() => expect(seen.some((s) => s.path === SIGN)).toBe(true));
    const stepUp = seen.find((s) => s.path === "/api/v1/portal/sessions/step-up");
    const sign = seen.find((s) => s.path === SIGN);
    expect(seen.indexOf(stepUp as Seen)).toBeLessThan(seen.indexOf(sign as Seen));
    expect(stepUp?.body).toEqual({ totpCode: "123456" });
    expect(sign?.body).toEqual({ signedTypedName: "Pat Example", attested: true });
    expect(sign?.headers.get("idempotency-key")).toBeTruthy();
  });

  it("does not sign when the authenticator code is refused", async () => {
    const seen: Seen[] = [];
    render(
      <PortalApp
        client={clientFor(
          server((s) => (s.path === "/api/v1/portal/sessions/step-up" ? json({}, 401) : undefined)),
          seen,
        )}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fillAndSubmit(dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "could not verify that code",
    );
    expect(seen.some((s) => s.path === SIGN)).toBe(false);
    expect(
      (
        within(dialog).getByLabelText(
          "6-digit code from your authenticator app",
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("opens 'Signing for someone else?' when the server asks for a relationship, and sends it on the next try with a fresh key", async () => {
    const seen: Seen[] = [];
    let signCalls = 0;
    render(
      <PortalApp
        client={clientFor(
          server((s) => {
            if (s.path !== SIGN) return undefined;
            signCalls += 1;
            return signCalls === 1
              ? refusal(422, "RELATIONSHIP_REQUIRED")
              : json({ request: ITEMS[0], alreadySigned: false });
          }),
          seen,
        )}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    const behalf = dialog.querySelector("details") as HTMLDetailsElement;
    expect(behalf.open).toBe(false);
    fillAndSubmit(dialog, "Dana Example");
    expect((await within(dialog).findByRole("alert")).textContent).toContain("how you are related");
    await waitFor(() => expect(behalf.open).toBe(true));

    fireEvent.change(within(dialog).getByLabelText("How are you related to the patient?"), {
      target: { value: "Daughter" },
    });
    fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
      target: { value: "654321" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(signCalls).toBe(2));
    const signs = seen.filter((s) => s.path === SIGN);
    expect(signs[1]?.body).toMatchObject({ signerRelationshipText: "Daughter" });
    // A definitive refusal ends the attempt, so the retry is a new attempt.
    expect(signs[1]?.headers.get("idempotency-key")).not.toBe(
      signs[0]?.headers.get("idempotency-key"),
    );
  });

  it("reuses the Idempotency-Key when a retry follows a failure that may have landed", async () => {
    const seen: Seen[] = [];
    let signCalls = 0;
    render(
      <PortalApp
        client={clientFor(
          server((s) => {
            if (s.path !== SIGN) return undefined;
            signCalls += 1;
            return signCalls === 1
              ? json({}, 503)
              : json({ request: ITEMS[0], alreadySigned: false });
          }),
          seen,
        )}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fillAndSubmit(dialog);
    await within(dialog).findByRole("alert");
    fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
      target: { value: "111111" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(signCalls).toBe(2));
    const signs = seen.filter((s) => s.path === SIGN);
    expect(signs[1]?.headers.get("idempotency-key")).toBe(signs[0]?.headers.get("idempotency-key"));
  });

  it.each([
    [403, "NOT_AUTHORIZED_FOR_DOCUMENT", "not able to sign this document"],
    [409, "TEMPLATE_PENDING_LEGAL_REVIEW", "not ready to sign yet"],
    [409, "REQUEST_TARGET_MISSING", "not ready to sign yet"],
  ])("answers a %s %s refusal in plain words", async (status, code, words) => {
    render(
      <PortalApp
        client={clientFor(server((s) => (s.path === SIGN ? refusal(status, code) : undefined)))}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fillAndSubmit(dialog);
    expect((await within(dialog).findByRole("alert")).textContent).toContain(words);
  });

  it("uploads a signed paper copy (init, content, complete) then attaches it to the request", async () => {
    const seen: Seen[] = [];
    render(
      <PortalApp
        client={clientFor(
          server((s) => {
            if (s.path === "/api/v1/portal/documents/upload-init")
              return json({
                uploadId: UPLOAD,
                signedUploadUrl: `/api/v1/portal/documents/uploads/${UPLOAD}/content`,
                signedUploadUrlExpiresAt: "2026-10-13T23:00:00Z",
              });
            if (s.path.endsWith(`/uploads/${UPLOAD}/content`))
              return json({ uploadId: UPLOAD, status: "staged", byteSize: 4 });
            if (s.path.endsWith(`/upload-complete/${UPLOAD}`))
              return json({ uploadId: UPLOAD, status: "submitted" });
            if (s.path === `/api/v1/portal/signature-requests/${REQ_PENDING}/signed-copy`)
              return json({ request: { ...ITEMS[0], status: "uploaded_pending_review" } });
            return undefined;
          }),
          seen,
        )}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fireEvent.change(within(dialog).getByLabelText("Choose a file"), {
      target: { files: [new File(["%PDF"], "signed.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send signed copy" }));
    expect(
      await screen.findByText("Your signed copy was sent. Your care team will review it."),
    ).toBeTruthy();

    const calls = seen
      .filter(
        (s) =>
          s.path.includes("/documents/upload") ||
          s.path.endsWith("/signed-copy") ||
          s.path.endsWith("/step-up"),
      )
      .map((s) => `${s.method} ${s.path}`);
    expect(calls).toEqual([
      "POST /api/v1/portal/documents/upload-init",
      `PUT /api/v1/portal/documents/uploads/${UPLOAD}/content`,
      `POST /api/v1/portal/documents/upload-complete/${UPLOAD}`,
      "POST /api/v1/portal/sessions/step-up",
      `POST /api/v1/portal/signature-requests/${REQ_PENDING}/signed-copy`,
    ]);
    expect(seen.find((s) => s.path.endsWith("/upload-init"))?.body).toMatchObject({
      purpose: "signed_admission_document",
    });
    const attach = seen.find((s) => s.path.endsWith("/signed-copy"));
    expect(attach?.body).toEqual({ uploadId: UPLOAD });
    expect(attach?.headers.get("idempotency-key")).toBeTruthy();
  });

  it("retries a failed upload-complete from that step, without sending the file again", async () => {
    const seen: Seen[] = [];
    let completes = 0;
    render(
      <PortalApp
        client={clientFor(
          server((s) => {
            if (s.path === "/api/v1/portal/documents/upload-init")
              return json({
                uploadId: UPLOAD,
                signedUploadUrl: `/api/v1/portal/documents/uploads/${UPLOAD}/content`,
                signedUploadUrlExpiresAt: "2026-10-13T23:00:00Z",
              });
            if (s.path.endsWith(`/uploads/${UPLOAD}/content`))
              return json({ uploadId: UPLOAD, status: "staged", byteSize: 4 });
            if (s.path.endsWith(`/upload-complete/${UPLOAD}`)) {
              completes += 1;
              return completes === 1
                ? refusal(503, "UNAVAILABLE")
                : json({ uploadId: UPLOAD, status: "submitted" });
            }
            if (s.path === `/api/v1/portal/signature-requests/${REQ_PENDING}/signed-copy`)
              return json({ request: { ...ITEMS[0], status: "uploaded_pending_review" } });
            return undefined;
          }),
          seen,
        )}
      />,
    );
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fireEvent.change(within(dialog).getByLabelText("Choose a file"), {
      target: { files: [new File(["%PDF"], "signed.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send signed copy" }));
    await within(dialog).findByText(/could not be submitted/);
    fireEvent.change(within(dialog).getByLabelText("6-digit code from your authenticator app"), {
      target: { value: "123456" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry sending" }));
    expect(
      await screen.findByText("Your signed copy was sent. Your care team will review it."),
    ).toBeTruthy();
    expect(completes).toBe(2);
    expect(seen.filter((s) => s.path.endsWith("/upload-init"))).toHaveLength(1);
    expect(seen.filter((s) => s.path.endsWith(`/uploads/${UPLOAD}/content`))).toHaveLength(1);
  });

  it("rejects an unsupported file locally and never starts an upload", async () => {
    const seen: Seen[] = [];
    render(<PortalApp client={clientFor(server(), seen)} />);
    const dialog = await openSigning();
    await within(dialog).findByText(ATTEST);
    fireEvent.change(within(dialog).getByLabelText("Choose a file"), {
      target: { files: [new File(["x"], "notes.txt", { type: "text/plain" })] },
    });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose a PDF");
    expect(seen.some((s) => s.path.includes("/documents/upload"))).toBe(false);
  });
});
