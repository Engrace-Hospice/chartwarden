// apps/web/src/modules/22-documents — #91: the M22 write controls must not be inert.
//
// Before this change `apps/web/src/modules/22-documents` issued ZERO mutations — 1537 lines across
// five screens, every one a read — and the staff app had NO FILE INPUT ANYWHERE.
// `grep -rn 'type="file"' apps/web/src apps/admin/src apps/portal/src` returned exactly one hit, in
// the PORTAL: a family member could attach a document to a patient's record and the nurse could not.
//
// Nothing in the repo's gate set can see that. `ui:parity` proves a screen is registered with a
// resolvable permission, `openapi:coverage` proves a ROUTE carries a contract — neither inspects
// whether a control does anything. So the net is a DOM test that CLICKS the control and asserts on
// RECORDED FETCH CALLS, which for M22 also proves something a spy over the api client could not: that
// the bytes go DIRECTLY to object storage and never through the API.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { DocumentExplorer } from "./document-explorer";
import { PatientDocuments } from "./patient-documents";
import { VersionHistory } from "./version-history";

const DOCUMENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const VERSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PATIENT = "cccccccc-3333-4333-8333-cccccccccccc";
const UPLOAD = "dddddddd-4444-4444-8444-dddddddddddd";
const STORAGE_URL = "https://objects.example.test/tenant-bucket/uploads/x?sig=abc";

const documentRow = {
  id: DOCUMENT,
  organizationId: "org-1",
  patientId: PATIENT,
  admissionId: null as string | null,
  retentionClass: "clinical_record",
  aggregateType: "intake_source",
  title: "Signed election statement",
  patientFacing: false,
  attachToDisclosures: false,
  status: "active",
  version: 2,
  versionsCount: 2,
  createdAt: "2026-08-01T09:00:00.000Z",
  updatedAt: "2026-08-20T09:00:00.000Z",
};

const versionRow = {
  id: VERSION,
  documentId: DOCUMENT,
  versionNumber: 2,
  mimeType: "application/pdf",
  byteSize: 20480,
  uploadedAt: "2026-08-20T09:00:00.000Z",
  createdAt: "2026-08-20T09:00:00.000Z",
};

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
/** Set by a test to make the NEXT api write fail; the client captures the stub at construction. */
let writeFailure: { status: number; body: unknown } | null = null;
/** Set to make the OBJECT-STORE PUT fail, which is a different failure from an API one. */
let storageFails = false;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (path === "/api/v1/document-uploads")
    return {
      uploadId: UPLOAD,
      uploadUrl: STORAGE_URL,
      requiredHeaders: { "content-type": "application/pdf", "x-amz-checksum-sha256": "abc" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
  if (path.endsWith("/complete"))
    return { documentId: DOCUMENT, versionId: VERSION, versionNumber: 3 };
  if (method === "PATCH") return { ...documentRow, title: "Corrected title" };
  if (path.endsWith("/content"))
    return {
      url: `${STORAGE_URL}&download=1`,
      expiresAt: "2099-01-01T00:00:00.000Z",
      documentVersionId: VERSION,
      accessKind: "content_download",
    };
  if (path === "/api/v1/documents") return { items: [documentRow], nextCursor: null };
  if (path.endsWith("/versions")) return { items: [versionRow], nextCursor: null };
  if (path.startsWith("/api/v1/documents/")) return documentRow;
  if (path.startsWith("/api/v1/patients/"))
    return {
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    };
  return {};
}

/** Serves BOTH the API and the object store, so a test can tell which one received the bytes. */
async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);

  // The presigned target is not an API route. Recorded separately, and answered without any of the
  // JSON the API returns — an upload that "worked" by hitting the API instead would fail here.
  if (url.startsWith("https://objects.example.test/")) {
    calls.push(`${method} <object-store>`);
    return new Response(null, { status: storageFails ? 403 : 200 });
  }

  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const raw =
      typeof input === "object" && "clone" in input
        ? await (input as Request).clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Not every M22 write sends JSON; recording nothing is the honest answer.
      }
    }
  }
  if (method !== "GET" && writeFailure) {
    return new Response(JSON.stringify(writeFailure.body), {
      status: writeFailure.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, pattern: string, element: JSX.Element) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

/**
 * A PDF the browser reports as `application/pdf`, with bytes so a digest is computable.
 *
 * jsdom's `File` has no `arrayBuffer()` — a jsdom gap, not a browser one (`Blob.arrayBuffer` has been
 * baseline since 2019) — so it is supplied here. The production code no longer THROWS without it
 * (`sha256Hex` returns null and the dialog says why), but a test that exercised that path would be
 * testing jsdom rather than the upload.
 */
function pdf(name = "scan.pdf", size = 2048): File {
  const file = new File([new Uint8Array(size)], name, { type: "application/pdf" });
  if (typeof file.arrayBuffer !== "function") {
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new Uint8Array(size).buffer,
      configurable: true,
    });
  }
  return file;
}

/** Pick a file into the dialog's `<input type="file">`. */
function choose(file: File): void {
  const input = screen.getByLabelText("File") as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  storageFails = false;
  // jsdom has no WebCrypto SubtleCrypto; the digest is the server's commitment, not this test's
  // subject, so it is stubbed to a fixed 64-hex value and asserted for SHAPE where it matters.
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer },
  });
  // The api client is constructed with `stubFetch`; the object-store PUT uses the BARE global, by
  // design. Both are pointed at the same recorder here — and that they are two different call sites is
  // itself asserted below ("the bytes go to object storage and NEVER through the API"). Before this
  // line the PUT escaped to a real network request, which is the clearest possible proof of the split.
  vi.stubGlobal("fetch", stubFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("#91 — the staff app can upload a document", () => {
  it("Upload document runs the full verified ceremony: reserve → store → commit", async () => {
    mount("/documents", "/documents", <DocumentExplorer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));

    await waitFor(() =>
      expect(writes()).toContain("POST /api/v1/document-uploads/{}/complete".replace("{}", UPLOAD)),
    );
    // The ORDER is the contract: reserve, then store, then commit. A commit before the bytes land
    // would be refused by the server's checksum inspection, so getting this wrong is not cosmetic.
    expect(writes()).toEqual([
      "POST /api/v1/document-uploads",
      "PUT <object-store>",
      `POST /api/v1/document-uploads/${UPLOAD}/complete`,
    ]);
  });

  it("the bytes go to object storage and NEVER through the API", async () => {
    mount("/documents", "/documents", <DocumentExplorer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(calls).toContain("PUT <object-store>"));
    // The presigned URL carries its own signature instead of the session; routing it through the api
    // client would attach this app's headers to a third-party origin and break the signature.
    expect(calls.filter((c) => c.startsWith("PUT /api/"))).toEqual([]);
  });

  it("declares the file's real size and a 64-hex digest to the server", async () => {
    mount("/documents", "/documents", <DocumentExplorer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf("election.pdf", 4096));
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.byteSize).toBe(4096);
    expect(sent.mimeType).toBe("application/pdf");
    expect(String(sent.sha256Hex)).toMatch(/^[0-9a-f]{64}$/);
    expect(sent.mode).toBe("new_document");
    // The filename seeds the title, because a scan is otherwise filed as "".
    expect(sent.title).toBe("election");
  });

  it("a storage failure ABORTS the reservation instead of leaving it pending", async () => {
    storageFails = true;
    mount("/documents", "/documents", <DocumentExplorer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(writes()).toContain(`DELETE /api/v1/document-uploads/${UPLOAD}`));
    // Never committed — the server would have refused, but asking it to is still wrong.
    expect(writes().some((c) => c.endsWith("/complete"))).toBe(false);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("refuses an oversized file before any request is made", async () => {
    mount("/documents", "/documents", <DocumentExplorer />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf("huge.pdf", 26 * 1024 * 1024));
    // A courtesy, not the enforcement point — the server has the same limit — but hashing 26 MB and
    // round-tripping it to be told no is a bad trade.
    expect((screen.getByRole("button", { name: "Upload" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(writes()).toEqual([]);
  });

  it("the patient chart files the upload against that patient", async () => {
    mount(`/patients/${PATIENT}/documents`, "/patients/:patientId/documents", <PatientDocuments />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload document" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    expect((bodies[0] as Record<string, unknown>).patientId).toBe(PATIENT);
  });
});

describe("#91 — the version chain can act on the document it lists", () => {
  it("Upload new version sends mode=new_version against this document", async () => {
    mount(`/documents/${DOCUMENT}/versions`, "/documents/:documentId/versions", <VersionHistory />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Upload new version" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Upload new version" }));
    await waitFor(() => expect(screen.getByLabelText("File")).toBeTruthy());
    choose(pdf());
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(bodies.length).toBeGreaterThan(0));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.mode).toBe("new_version");
    expect(sent.targetDocumentId).toBe(DOCUMENT);
  });

  it("Edit details PATCHes only what changed", async () => {
    mount(`/documents/${DOCUMENT}/versions`, "/documents/:documentId/versions", <VersionHistory />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit details" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const title = await waitFor(() => screen.getByLabelText(/Title/i));
    fireEvent.change(title, { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(writes()).toContain(`PATCH /api/v1/documents/${DOCUMENT}`));
    // `patientFacing` was not touched, so it is not sent: a PATCH that echoes every field back would
    // overwrite a concurrent change to one the user never looked at.
    expect(bodies[0]).toEqual({ title: "Corrected title" });
  });

  it("Save is disabled until something actually changes", async () => {
    mount(`/documents/${DOCUMENT}/versions`, "/documents/:documentId/versions", <VersionHistory />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit details" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeTruthy());
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("#91 — opening a document is a §164.528 accounting event", () => {
  it("Open mints a signed URL against the purpose chosen, and opens it", async () => {
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    mount(`/documents/${DOCUMENT}/versions`, "/documents/:documentId/versions", <VersionHistory />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const purpose = await waitFor(() => screen.getByLabelText(/Reason for access/i));
    fireEvent.change(purpose, { target: { value: "disclosure" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Open" })[1] as HTMLElement);
    await waitFor(() =>
      expect(
        calls.some((c) => c === `GET /api/v1/documents/${DOCUMENT}/versions/${VERSION}/content`),
      ).toBe(true),
    );
    // The purpose is asked for rather than defaulted: recording every look as "treatment" would make
    // the disclosure log a fiction, and the log is the reason this route mints instead of redirecting.
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(String(opened.mock.calls[0]?.[0])).toContain("download=1");
  });
});

describe("#91 — a refusal is rendered, not swallowed", () => {
  it("a 409 legal-hold refusal on the edit keeps the dialog open and shows the server's words", async () => {
    writeFailure = {
      status: 409,
      body: { message: "document is under legal hold and cannot be edited" },
    };
    mount(`/documents/${DOCUMENT}/versions`, "/documents/:documentId/versions", <VersionHistory />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit details" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit details" }));
    const title = await waitFor(() => screen.getByLabelText(/Title/i));
    fireEvent.change(title, { target: { value: "Corrected title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.textContent).toContain("legal hold");
    expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  });
});
