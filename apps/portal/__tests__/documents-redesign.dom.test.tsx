import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const DOC_A = "22222222-2222-4222-8222-222222222222";
const DOC_B = "33333333-3333-4333-8333-333333333333";
const UPLOAD = "44444444-4444-4444-8444-444444444444";
const json = (data: unknown, status = 200): Response => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function clientFor(handler: (url: URL, method: string) => Response | Promise<Response>) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.pathname === "/api/v1/portal/sessions/current") return json({ portalAccountId: "55555555-5555-4555-8555-555555555555", activePatientId: PATIENT, scopeSet: [], relationship: "patient_self", status: "active" });
      if (url.pathname === "/api/v1/portal/care-summary") return json({ patient: { layLabel: "Sample Patient" }, upcomingVisitsCount: 0, recentVisitsCount: 0, activeMedicationsCount: 0, unreadMessagesCount: 0, pendingDocumentSharesCount: 0 });
      return handler(url, request.method);
    },
  });
}

describe("portal documents redesign", () => {
  beforeEach(() => {
    window.history.pushState({}, "", `/p/${PATIENT}/documents`);
    vi.restoreAllMocks();
  });

  it("sorts shared documents newest first and provides descriptive downloads", async () => {
    render(<PortalApp client={clientFor((url) => url.pathname === "/api/v1/portal/documents" ? json({ items: [
      { documentId: DOC_A, title: "Older guide", documentType: "care_guide", sharedAt: "2026-09-01T12:00:00Z" },
      { documentId: DOC_B, title: "Newer plan", sharedAt: "2026-10-01T12:00:00Z" },
    ] }) : json({}, 404))} />);
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("heading").map((node) => node.textContent)).toEqual(["Newer plan", "Older guide"]);
    expect(screen.getByRole("button", { name: "Download Newer plan" })).toBeTruthy();
    expect(screen.getByText("Document type unavailable")).toBeTruthy();
  });

  it("distinguishes an empty library from a failed request and supports retry", async () => {
    let calls = 0;
    render(<PortalApp client={clientFor((url) => {
      if (url.pathname !== "/api/v1/portal/documents") return json({}, 404);
      calls += 1;
      return calls === 1 ? json({ error: { code: "DEGRADED" } }, 503) : json({ items: [] });
    })} />);
    expect(await screen.findByRole("heading", { name: "Documents are unavailable" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("heading", { name: "No documents shared yet" })).toBeTruthy();
  });

  it("opens an accessible upload dialog and rejects an unsupported file locally", async () => {
    render(<PortalApp client={clientFor((url) => url.pathname === "/api/v1/portal/documents" ? json({ items: [] }) : json({}, 404))} />);
    await screen.findByRole("heading", { name: "No documents shared yet" });
    fireEvent.click(screen.getAllByRole("button", { name: "Send a document" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Send a document" });
    expect(within(dialog).getByRole("combobox", { name: "What kind of document is this?" })).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Choose a file"), { target: { files: [new File(["notes"], "notes.txt", { type: "text/plain" })] } });
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Choose a PDF");
    expect((within(dialog).getByRole("button", { name: "Send document" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("preserves init, authenticated content transfer, and completion order", async () => {
    const requests: string[] = [];
    render(<PortalApp client={clientFor((url, method) => {
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname === "/api/v1/portal/documents" && method === "GET") return json({ items: [] });
      if (url.pathname === "/api/v1/portal/documents/upload-init") return json({ uploadId: UPLOAD, signedUploadUrl: `/api/v1/portal/documents/uploads/${UPLOAD}/content`, signedUploadUrlExpiresAt: "2026-10-13T23:00:00Z" });
      if (url.pathname.endsWith(`/uploads/${UPLOAD}/content`)) return json({ uploadId: UPLOAD, status: "staged", byteSize: 4 });
      if (url.pathname.endsWith(`/upload-complete/${UPLOAD}`)) return json({ uploadId: UPLOAD, status: "submitted" });
      return json({}, 404);
    })} />);
    await screen.findByRole("heading", { name: "No documents shared yet" });
    fireEvent.click(screen.getAllByRole("button", { name: "Send a document" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Send a document" });
    fireEvent.change(within(dialog).getByLabelText("Choose a file"), { target: { files: [new File(["%PDF"], "record.pdf", { type: "application/pdf" })] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Send document" }));
    expect(await within(dialog).findByText("Your document was submitted for secure processing.")).toBeTruthy();
    expect(requests.filter((request) => request.includes("/documents/upload"))).toEqual([
      "POST /api/v1/portal/documents/upload-init",
      `PUT /api/v1/portal/documents/uploads/${UPLOAD}/content`,
      `POST /api/v1/portal/documents/upload-complete/${UPLOAD}`,
    ]);
  });

  it("refuses unsafe download URL schemes", async () => {
    const close = vi.fn();
    const popup = { close, opener: window, location: { replace: vi.fn() } } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(popup);
    render(<PortalApp client={clientFor((url) => {
      if (url.pathname === "/api/v1/portal/documents") return json({ items: [{ documentId: DOC_A, title: "Guide" }] });
      if (url.pathname.endsWith("/download-url")) return json({ url: "javascript:alert(1)", expiresAt: "2026-10-13T23:00:00Z", patientId: PATIENT });
      return json({}, 404);
    })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Download Guide" }));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be opened securely");
    expect(open).toHaveBeenCalledWith("about:blank", "_blank");
    expect(close).toHaveBeenCalledOnce();
    expect(popup.location.replace).not.toHaveBeenCalled();
  });
});
