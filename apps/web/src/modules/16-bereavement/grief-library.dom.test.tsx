import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// apps/web/src/modules/16-bereavement — ADR-0109 D10: the grief library (routes 77-81) and its upload over M22's verified upload.
// A 403 renders nothing; a failure is announced; the preview URL is minted on click and held only as a link; a status change carries
// If-Match; the upload hashes the file, reserves an org-level patient-facing library document, PUTs it with the signed headers, completes
// it and registers the item; a reader without library.manage gets no upload, edit or publish.
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { GriefLibrary } from "./grief-library";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const UPLOAD_ID = "33333333-3333-4333-8333-333333333333";
const MANAGE = ["bereavement.library.read", "bereavement.library.manage"];
const LIBRARY = "/api/v1/bereavement/library";

const item = (over: Record<string, unknown> = {}) => ({
  itemId: ITEM_ID,
  title: "When grief comes in waves",
  summary: "A short guide.",
  category: "coping",
  kind: "pdf",
  mimeType: "application/pdf",
  documentId: DOC_ID,
  transcriptDocumentId: null,
  status: "draft",
  sortOrder: 1,
  publishedAt: null,
  version: 3,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...over,
});

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  ifMatch: string | null;
  idempotencyKey: string | null;
}
type Reply = { status: number; body?: unknown };

function mount(handler: (req: Req) => Reply, permissions: string[] = MANAGE) {
  const calls: Req[] = [];
  const stub = async (input: RequestInfo | URL): Promise<Response> => {
    const req = input as Request;
    const url = new URL(req.url);
    const text = req.method !== "GET" ? await req.clone().text() : "";
    const recorded: Req = {
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      body: text ? JSON.parse(text) : null,
      ifMatch: req.headers.get("if-match"),
      idempotencyKey: req.headers.get("idempotency-key"),
    };
    calls.push(recorded);
    const reply = handler(recorded);
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  };
  const view = render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stub })}>
      <SessionProvider session={{ userId: "u-1", organizationId: "org-1", permissions }}>
        <MemoryRouter>
          <GriefLibrary />
        </MemoryRouter>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return { calls, ...view };
}

const ok = (body: unknown): Reply => ({ status: 200, body });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("grief library — reads", () => {
  it("lists each item with its category, kind and status", async () => {
    mount(() => ok([item()]));
    expect(await screen.findByText("When grief comes in waves")).toBeTruthy();
    expect(screen.getByText("Coping")).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy();
    expect(
      within(screen.getByRole("table", { name: "Grief library" })).getByText("Draft"),
    ).toBeTruthy();
  });

  it("says plainly that the library is empty", async () => {
    mount(() => ok([]));
    expect(await screen.findByText("No library items")).toBeTruthy();
  });

  it("a 403 renders nothing at all", async () => {
    const { container } = mount(() => ({ status: 403, body: { error: { code: "FORBIDDEN" } } }));
    await waitFor(() => expect(container.firstChild).toBeNull());
  });

  it("a server error is announced with Try again", async () => {
    let reads = 0;
    mount(() => {
      reads += 1;
      return reads === 1
        ? { status: 500, body: { error: { code: "INTERNAL", message: "boom" } } }
        : ok([item()]);
    });
    expect((await screen.findByRole("alert")).textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("When grief comes in waves")).toBeTruthy();
  });

  it("filters by status", async () => {
    const { calls } = mount(() => ok([item()]));
    await screen.findByText("When grief comes in waves");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "published" } });
    await waitFor(() =>
      expect(calls.some((c) => c.query.get("status") === "published")).toBe(true),
    );
  });

  it("mints a transcript preview on click and drops the link once used", async () => {
    const { calls } = mount((req) =>
      req.path.endsWith("/url")
        ? ok({
            itemId: ITEM_ID,
            url: "https://files.example/t.pdf",
            expiresAt: "2099-01-01T00:00:00.000Z",
          })
        : ok([item({ transcriptDocumentId: DOC_ID })]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Transcript of When grief comes in waves" }),
    );
    const link = await screen.findByRole("link", { name: "Open preview" });
    expect(link.getAttribute("href")).toBe("https://files.example/t.pdf");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(calls.find((c) => c.path.endsWith("/url"))?.query.get("part")).toBe("transcript");
    fireEvent.click(link);
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
  });

  it("refuses a preview URL that is not https", async () => {
    mount((req) =>
      req.path.endsWith("/url")
        ? ok({
            itemId: ITEM_ID,
            url: "http://evil.example/x",
            expiresAt: "2099-01-01T00:00:00.000Z",
          })
        : ok([item()]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview When grief comes in waves" }),
    );
    expect((await screen.findByRole("alert")).textContent).toContain("not a secure");
    expect(screen.queryByRole("link", { name: "Open preview" })).toBeNull();
  });

  it("a reader without library.manage gets preview only: no upload, edit or publish", async () => {
    mount(() => ok([item()]), ["bereavement.library.read"]);
    await screen.findByText("When grief comes in waves");
    expect(screen.getByRole("button", { name: "Preview When grief comes in waves" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload item" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit When grief comes in waves" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish When grief comes in waves" })).toBeNull();
  });
});

describe("grief library — writes", () => {
  it("publishes a draft with If-Match and an Idempotency-Key", async () => {
    const { calls } = mount((req) =>
      req.method === "POST" ? ok(item({ status: "published", version: 4 })) : ok([item()]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish When grief comes in waves" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, publish it" }));
    expect(await screen.findByText("When grief comes in waves is now published.")).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe(`${LIBRARY}/${ITEM_ID}/status`);
    expect(post?.body).toEqual({ status: "published" });
    expect(post?.ifMatch).toBe("3");
    expect(post?.idempotencyKey).toBeTruthy();
    expect(screen.getByRole("button", { name: "Archive When grief comes in waves" })).toBeTruthy();
  });

  it("offers Republish for an archived item", async () => {
    mount(() => ok([item({ status: "archived" })]));
    expect(
      await screen.findByRole("button", { name: "Republish When grief comes in waves" }),
    ).toBeTruthy();
  });

  it("edits with a PATCH carrying If-Match", async () => {
    const { calls } = mount((req) =>
      req.method === "PATCH" ? ok(item({ title: "Waves of grief", version: 4 })) : ok([item()]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit When grief comes in waves" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Waves of grief" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Waves of grief was saved.")).toBeTruthy();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`${LIBRARY}/${ITEM_ID}`);
    expect(patch?.ifMatch).toBe("3");
    expect(patch?.body).toMatchObject({
      title: "Waves of grief",
      category: "coping",
      sortOrder: 1,
    });
  });

  it("uploads through M22's verified upload, then registers the item", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xab).buffer,
    );
    const puts: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      puts.push({ url, headers: init.headers as Record<string, string> });
      return new Response(null, { status: 200 });
    });
    const { calls } = mount((req) => {
      if (req.path === "/api/v1/document-uploads")
        return {
          status: 201,
          body: {
            uploadId: UPLOAD_ID,
            uploadUrl: "https://store.example/put",
            requiredHeaders: { "x-amz-checksum": "abc" },
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      if (req.path.endsWith("/complete")) return ok({ documentId: DOC_ID });
      if (req.method === "POST" && req.path === LIBRARY)
        return ok(item({ title: "Holiday guide" }));
      return ok([]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    const file = new File(["%PDF-1.4 synthetic"], "guide.pdf", { type: "application/pdf" });
    // jsdom's File has no arrayBuffer() (a jsdom gap, not a browser one).
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Holiday guide" } });
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "holidays_and_anniversaries" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect(
      await screen.findByText("Holiday guide was added to the library as a draft."),
    ).toBeTruthy();

    const initiate = calls.find((c) => c.path === "/api/v1/document-uploads");
    expect(initiate?.body).toMatchObject({
      mode: "new_document",
      aggregateType: "bereavement_library_item",
      retentionClass: "bereavement",
      patientFacing: true,
      title: "Holiday guide",
      mimeType: "application/pdf",
      byteSize: file.size,
      sha256Hex: "ab".repeat(32),
    });
    expect(puts).toEqual([
      { url: "https://store.example/put", headers: { "x-amz-checksum": "abc" } },
    ]);
    expect(calls.some((c) => c.path === `/api/v1/document-uploads/${UPLOAD_ID}/complete`)).toBe(
      true,
    );
    const register = calls.find((c) => c.method === "POST" && c.path === LIBRARY);
    expect(register?.idempotencyKey).toBeTruthy();
    expect(register?.body).toEqual({
      documentId: DOC_ID,
      title: "Holiday guide",
      summary: null,
      category: "holidays_and_anniversaries",
      transcriptDocumentId: null,
      sortOrder: 0,
    });
  });

  /** A synthetic file whose reported size is `size` bytes (jsdom: no arrayBuffer(), so one is supplied). */
  const sizedFile = (name: string, type: string, size: number): File => {
    const file = new File(["synthetic"], name, { type });
    Object.defineProperty(file, "size", { value: size });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
    return file;
  };
  const MB = 1024 * 1024;
  const pickAndUpload = async (file: File, title: string): Promise<void> => {
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: title } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
  };

  it("accepts an MP4 under 500 MB and sends it as video/mp4", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xcd).buffer,
    );
    vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
    const { calls } = mount((req) => {
      if (req.path === "/api/v1/document-uploads")
        return {
          status: 201,
          body: {
            uploadId: UPLOAD_ID,
            uploadUrl: "https://store.example/put",
            requiredHeaders: {},
            expiresAt: "2099-01-01T00:00:00.000Z",
          },
        };
      if (req.path.endsWith("/complete")) return ok({ documentId: DOC_ID });
      if (req.method === "POST" && req.path === LIBRARY)
        return ok(item({ title: "Remembering together", kind: "video", mimeType: "video/mp4" }));
      return ok([]);
    });
    await pickAndUpload(sizedFile("talk.mp4", "video/mp4", 400 * MB), "Remembering together");
    expect(
      await screen.findByText("Remembering together was added to the library as a draft."),
    ).toBeTruthy();
    expect(calls.find((c) => c.path === "/api/v1/document-uploads")?.body).toMatchObject({
      mimeType: "video/mp4",
      byteSize: 400 * MB,
      aggregateType: "bereavement_library_item",
    });
  });

  it("refuses a 30 MB PDF before any request", async () => {
    const { calls } = mount(() => ok([]));
    await pickAndUpload(sizedFile("big.pdf", "application/pdf", 30 * MB), "A big guide");
    expect((await screen.findByRole("alert")).textContent).toContain("larger than 25 MB");
    expect(calls.some((c) => c.path === "/api/v1/document-uploads")).toBe(false);
  });

  it("refuses a 600 MB MP4 before any request", async () => {
    const { calls } = mount(() => ok([]));
    await pickAndUpload(sizedFile("long.mp4", "video/mp4", 600 * MB), "A long video");
    expect((await screen.findByRole("alert")).textContent).toContain("larger than 500 MB");
    expect(calls.some((c) => c.path === "/api/v1/document-uploads")).toBe(false);
  });

  it("refuses a file type the contract does not accept before any request", async () => {
    const { calls } = mount(() => ok([]));
    await pickAndUpload(sizedFile("notes.txt", "text/plain", 10), "Notes");
    expect((await screen.findByRole("alert")).textContent).toContain("PDF, PNG, JPEG or MP4");
    expect(calls.some((c) => c.path === "/api/v1/document-uploads")).toBe(false);
  });
});

describe("grief library — review fixes", () => {
  it("archives only after the alertdialog is confirmed, and under a status filter re-reads the list", async () => {
    let reads = 0;
    mount((req) => {
      if (req.method === "POST") return ok(item({ status: "archived", version: 4 }));
      reads += 1;
      return ok(req.query.get("status") === "published" ? [item({ status: "published" })] : []);
    });
    await screen.findByText("No library items");
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "published" } });
    fireEvent.click(
      await screen.findByRole("button", { name: "Archive When grief comes in waves" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    const before = reads;
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, archive it" }));
    expect(await screen.findByText("When grief comes in waves is now archived.")).toBeTruthy();
    await waitFor(() => expect(reads).toBe(before + 1));
  });

  it("a video without a transcript cannot be published, and says why", async () => {
    mount(() => ok([item({ kind: "video", mimeType: "video/mp4" })]));
    const publish = (await screen.findByRole("button", {
      name: "Publish When grief comes in waves",
    })) as HTMLButtonElement;
    expect(publish.disabled).toBe(true);
    const reason = document.getElementById(publish.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Add a transcript before publishing this video.");
  });

  it("shows the server's message when it still refuses a video without its transcript", async () => {
    mount((req) =>
      req.method === "POST"
        ? {
            status: 422,
            body: {
              error: {
                code: "LIBRARY_TRANSCRIPT_REQUIRED",
                message: "A video needs a transcript before it can be published.",
              },
            },
          }
        : ok([item({ kind: "video", mimeType: "video/mp4", transcriptDocumentId: DOC_ID })]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish When grief comes in waves" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, publish it" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "A video needs a transcript before it can be published.",
    );
  });

  it("a stale edit closes the dialog, reloads the library and says why", async () => {
    let reads = 0;
    mount((req) => {
      if (req.method === "PATCH")
        return { status: 409, body: { error: { code: "STALE_VERSION", message: "moved" } } };
      reads += 1;
      return ok([item()]);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit When grief comes in waves" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/This item changed while you were editing it/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(reads).toBe(2));
  });

  it("refuses a transcript id that is not a valid id before sending", async () => {
    const { calls } = mount(() => ok([item()]));
    fireEvent.click(await screen.findByRole("button", { name: "Edit When grief comes in waves" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Transcript document id/), {
      target: { value: "not-an-id" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("not a valid id");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("says plainly when the browser has no secure crypto, before any request", async () => {
    vi.stubGlobal("crypto", {});
    const { calls } = mount(() => ok([]));
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    const file = new File(["%PDF-1.4 synthetic"], "guide.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "a secure (https) connection is required",
    );
    expect(calls.some((c) => c.path === "/api/v1/document-uploads")).toBe(false);
  });

  it("says the file could not be read when hashing it fails", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValue(new Error("read failed"));
    mount(() => ok([]));
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    const file = new File(["%PDF-1.4 synthetic"], "guide.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The file could not be read");
  });

  it("Cancel upload aborts the PUT and releases the reservation", async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xab).buffer,
    );
    let putSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          putSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const { calls } = mount((req) =>
      req.path === "/api/v1/document-uploads"
        ? {
            status: 201,
            body: {
              uploadId: UPLOAD_ID,
              uploadUrl: "https://store.example/put",
              requiredHeaders: {},
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          }
        : req.method === "DELETE"
          ? { status: 204 }
          : ok([]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    const file = new File(["%PDF-1.4 synthetic"], "guide.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(putSignal).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The upload was cancelled");
    expect(putSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(
        calls.some(
          (c) => c.method === "DELETE" && c.path === `/api/v1/document-uploads/${UPLOAD_ID}`,
        ),
      ).toBe(true),
    );
  });
});

describe("grief library — round 3", () => {
  /** Start an upload whose PUT hangs until aborted; answers the reservation and its release. */
  const startHangingUpload = async () => {
    vi.spyOn(globalThis.crypto.subtle, "digest").mockResolvedValue(
      new Uint8Array(32).fill(0xab).buffer,
    );
    let putSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          putSignal = init.signal ?? undefined;
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const view = mount((req) =>
      req.path === "/api/v1/document-uploads"
        ? {
            status: 201,
            body: {
              uploadId: UPLOAD_ID,
              uploadUrl: "https://store.example/put",
              requiredHeaders: {},
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
          }
        : req.method === "DELETE"
          ? { status: 204 }
          : ok([]),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Upload item" }));
    const file = new File(["%PDF-1.4 synthetic"], "guide.pdf", { type: "application/pdf" });
    Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
    fireEvent.change(screen.getByLabelText(/^File/), { target: { files: [file] } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Guide" } });
    fireEvent.click(screen.getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(putSignal).toBeDefined());
    return { ...view, signal: () => putSignal };
  };
  const released = (calls: { method: string; path: string }[]) =>
    calls.some((c) => c.method === "DELETE" && c.path === `/api/v1/document-uploads/${UPLOAD_ID}`);

  it("Cancel upload disables itself and says Cancelling… while the upload stops", async () => {
    await startHangingUpload();
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    const cancelling = screen.getByRole("button", { name: "Cancelling…" }) as HTMLButtonElement;
    expect(cancelling.disabled).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("The upload was cancelled");
  });

  it("leaving mid-upload aborts the PUT, releases the reservation and registers nothing", async () => {
    const { calls, unmount, signal } = await startHangingUpload();
    unmount();
    expect(signal()?.aborted).toBe(true);
    await waitFor(() => expect(released(calls)).toBe(true));
    expect(calls.some((c) => c.method === "POST" && c.path === LIBRARY)).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/complete"))).toBe(false);
  });

  it.each([409, 404])("a %i on a status change closes the confirm dialog", async (status) => {
    mount((req) =>
      req.method === "POST"
        ? { status, body: { error: { code: "STALE", message: "It moved." } } }
        : ok([item()]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish When grief comes in waves" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, publish it" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("a failed status change's error is cleared when its dialog is closed", async () => {
    mount((req) =>
      req.method === "POST"
        ? { status: 500, body: { error: { code: "INTERNAL", message: "could not publish" } } }
        : ok([item()]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Publish When grief comes in waves" }),
    );
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Yes, publish it" }));
    expect(await within(dialog).findByText("could not publish")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Go back" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.queryByText("could not publish")).toBeNull();
  });

  it("a failed preview's error is cleared when Edit is chosen", async () => {
    mount((req) =>
      req.path.endsWith("/url")
        ? { status: 500, body: { error: { code: "INTERNAL", message: "no preview" } } }
        : ok([item()]),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview When grief comes in waves" }),
    );
    expect(await screen.findByText("no preview")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit When grief comes in waves" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("no preview")).toBeNull();
  });
});
