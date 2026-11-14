import type { ApiClient } from "@chartwarden/ui";
// F-238 — "Upload fax" on Intake review: a fax that names no referral is uploaded, queued as an UNFILED
// intake batch (no referralId, no patient) and DocLens starts reading it.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntakeUploadDialog } from "./intake-upload-dialog";

const ok = (data: unknown) => ({ data, error: undefined, response: new Response() });

describe("IntakeUploadDialog — unfiled fax", () => {
  it("uploads with no patient or referral, queues the batch and starts DocLens", async () => {
    const cryptoValue = { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const batchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const post = vi.fn(async (path: string) => {
      if (path === "/api/v1/document-uploads")
        return ok({
          uploadId: "66666666-6666-4666-8666-666666666666",
          uploadUrl: "https://storage.example/upload",
          requiredHeaders: {},
          expiresAt: "2026-10-04T10:05:00.000Z",
        });
      if (path === "/api/v1/document-uploads/{id}/complete")
        return ok({ documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", versionId: "v1" });
      if (path === "/api/v1/intake/uploads") return ok({ id: batchId, status: "uploaded" });
      if (path === "/api/v1/intake/uploads/{id}/extraction/run")
        return ok({ batchId, status: "queued" });
      return ok({});
    });
    const onFiled = vi.fn();
    render(
      <IntakeUploadDialog
        open
        client={{ POST: post } as unknown as ApiClient}
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Upload fax" });
    expect(within(dialog).getByText(/records-request code on its cover sheet/)).toBeTruthy();
    const file = new File(["%PDF-1.7"], "fax-0412.pdf", { type: "application/pdf" });
    fireEvent.change(within(dialog).getByLabelText("Records file"), { target: { files: [file] } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload" }));

    await waitFor(() => expect(onFiled).toHaveBeenCalled());
    const init = post.mock.calls.find(([p]) => p === "/api/v1/document-uploads") as unknown as [
      string,
      { body: Record<string, unknown> },
    ];
    expect(init[1].body.patientId).toBeUndefined();
    expect(init[1].body.aggregateId).toBeUndefined();
    expect(post).toHaveBeenCalledWith(
      "/api/v1/intake/uploads",
      expect.objectContaining({
        body: { documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", sourceChannel: "fax" },
      }),
    );
    // Starting DocLens reads the batch as it is now, so the run is sent on its own key, never the client's per-intent key.
    const run = post.mock.calls.find(
      ([p]) => p === "/api/v1/intake/uploads/{id}/extraction/run",
    ) as unknown as [string, { headers?: Record<string, string> }];
    expect(run[1].headers?.["Idempotency-Key"]).toBeTruthy();
    expect(onFiled.mock.calls[0]?.[0]).toMatch(/appears in the queue/);
  });
});

describe("IntakeUploadDialog — referral context", () => {
  it("finishes extraction once when the referral changes after batch creation commits", async () => {
    const cryptoValue = { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => new Response(null, { status: 200 })),
    });
    let releaseBatch!: (value: ReturnType<typeof ok>) => void;
    const pendingBatch = new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseBatch = resolve;
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
        return ok({ documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", versionId: "v1" });
      if (path === "/api/v1/intake/uploads") return pendingBatch;
      if (path === "/api/v1/intake/uploads/{id}/extraction/run")
        return ok({ batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "queued" });
      return ok({});
    });
    const client = { POST: post } as unknown as ApiClient;
    const onFiled = vi.fn();
    const view = render(
      <IntakeUploadDialog
        open
        client={client}
        referralId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        patientId="11111111-1111-4111-8111-111111111111"
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    let dialog = screen.getByRole("dialog", { name: "Add records" });
    fireEvent.change(within(dialog).getByLabelText("Records file"), {
      target: { files: [new File(["A"], "referral-a.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and file" }));
    expect(await within(dialog).findByText("Filing")).toBeTruthy();

    view.rerender(
      <IntakeUploadDialog
        open
        client={client}
        referralId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        patientId="22222222-2222-4222-8222-222222222222"
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    releaseBatch(ok({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "uploaded" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/intake/uploads/{id}/extraction/run",
        expect.objectContaining({
          params: { path: { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } },
        }),
      ),
    );
    expect(onFiled).not.toHaveBeenCalled();

    view.rerender(
      <IntakeUploadDialog
        open
        client={client}
        referralId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        patientId="11111111-1111-4111-8111-111111111111"
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });
    expect(within(dialog).queryByRole("button", { name: "Retry filing" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Upload and file" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(post.mock.calls.filter(([path]) => path === "/api/v1/intake/uploads")).toHaveLength(1);
  });

  it("does not leave a replacement referral busy when an old upload finishes", async () => {
    const cryptoValue = { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => new Response(null, { status: 200 })),
    });
    let releaseUpload!: (value: ReturnType<typeof ok>) => void;
    const pendingUpload = new Promise<ReturnType<typeof ok>>((resolve) => {
      releaseUpload = resolve;
    });
    const post = vi.fn(async (path: string) => {
      if (path === "/api/v1/document-uploads") return pendingUpload;
      if (path === "/api/v1/document-uploads/{id}/complete")
        return ok({ documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", versionId: "v1" });
      return ok({});
    });
    const onClose = vi.fn();
    const onFiled = vi.fn();
    const view = render(
      <IntakeUploadDialog
        open
        client={{ POST: post } as unknown as ApiClient}
        referralId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        patientId="11111111-1111-4111-8111-111111111111"
        onClose={onClose}
        onFiled={onFiled}
      />,
    );
    let dialog = screen.getByRole("dialog", { name: "Add records" });
    fireEvent.change(within(dialog).getByLabelText("Records file"), {
      target: { files: [new File(["A"], "referral-a.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and file" }));
    expect(await within(dialog).findByText("Uploading")).toBeTruthy();

    view.rerender(
      <IntakeUploadDialog
        open
        client={{ POST: post } as unknown as ApiClient}
        referralId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        patientId="22222222-2222-4222-8222-222222222222"
        onClose={onClose}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });
    expect(within(dialog).queryByText("Uploading")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveProperty(
      "disabled",
      false,
    );

    releaseUpload(
      ok({
        uploadId: "66666666-6666-4666-8666-666666666666",
        uploadUrl: "https://storage.example/upload",
        requiredHeaders: {},
        expiresAt: "2026-10-04T10:05:00.000Z",
      }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/api/v1/document-uploads/{id}/complete",
        expect.anything(),
      ),
    );
    expect(onFiled).not.toHaveBeenCalled();
    expect(within(dialog).queryByText(/Uploading|Filing|Starting/)).toBeNull();

    view.rerender(
      <IntakeUploadDialog
        open
        client={{ POST: post } as unknown as ApiClient}
        referralId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        patientId="11111111-1111-4111-8111-111111111111"
        onClose={onClose}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });
    const retry = await within(dialog).findByRole("button", { name: "Retry filing" });
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(onFiled).toHaveBeenCalledOnce());
    expect(post.mock.calls.filter(([path]) => path === "/api/v1/document-uploads")).toHaveLength(
      1,
    );
  });

  it("never exposes or files a preserved document after the referral changes", async () => {
    const cryptoValue = { subtle: { digest: vi.fn(async () => new Uint8Array(32).buffer) } };
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(window, "crypto", { configurable: true, value: cryptoValue });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: vi.fn(async () => new Response(null, { status: 200 })),
    });
    const referralA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const referralB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const patientA = "11111111-1111-4111-8111-111111111111";
    const patientB = "22222222-2222-4222-8222-222222222222";
    let completed = 0;
    let filingAttempts = 0;
    const post = vi.fn(async (path: string) => {
      if (path === "/api/v1/document-uploads")
        return ok({
          uploadId: "66666666-6666-4666-8666-666666666666",
          uploadUrl: "https://storage.example/upload",
          requiredHeaders: {},
          expiresAt: "2026-10-04T10:05:00.000Z",
        });
      if (path === "/api/v1/document-uploads/{id}/complete") {
        completed += 1;
        return ok({
          documentId:
            completed === 1
              ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
              : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          versionId: `v${completed}`,
        });
      }
      if (path === "/api/v1/intake/uploads") {
        filingAttempts += 1;
        if (filingAttempts === 1) {
          return {
            data: undefined,
            error: { message: "The filing service was temporarily unavailable." },
            response: new Response(null, { status: 503 }),
          };
        }
        return ok({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "uploaded" });
      }
      if (path === "/api/v1/intake/uploads/{id}/extraction/run")
        return ok({ batchId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", status: "queued" });
      return ok({});
    });
    const client = { POST: post } as unknown as ApiClient;
    const onFiled = vi.fn();
    const view = render(
      <IntakeUploadDialog
        open
        client={client}
        referralId={referralA}
        patientId={patientA}
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );

    let dialog = screen.getByRole("dialog", { name: "Add records" });
    fireEvent.change(within(dialog).getByLabelText("Records file"), {
      target: { files: [new File(["A"], "referral-a.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and file" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringMatching(/verified file is preserved/i),
    );

    view.rerender(
      <IntakeUploadDialog
        open
        client={client}
        referralId={referralB}
        patientId={patientB}
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });
    expect(within(dialog).queryByRole("button", { name: "Retry filing" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Upload and file" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    view.rerender(
      <IntakeUploadDialog
        open
        client={client}
        referralId={referralA}
        patientId={patientA}
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });
    expect(within(dialog).getByRole("button", { name: "Retry filing" })).toHaveProperty(
      "disabled",
      false,
    );

    view.rerender(
      <IntakeUploadDialog
        open
        client={client}
        referralId={referralB}
        patientId={patientB}
        onClose={() => undefined}
        onFiled={onFiled}
      />,
    );
    dialog = screen.getByRole("dialog", { name: "Add records" });

    fireEvent.change(within(dialog).getByLabelText("Records file"), {
      target: { files: [new File(["B"], "referral-b.pdf", { type: "application/pdf" })] },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Upload and file" }));
    await waitFor(() => expect(onFiled).toHaveBeenCalledOnce());

    const filings = post.mock.calls.filter(
      ([path]) => path === "/api/v1/intake/uploads",
    ) as unknown as Array<[string, { body: Record<string, unknown> }]>;
    expect(filings).toHaveLength(2);
    expect(filings[0]?.[1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          documentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
          referralId: referralA,
        }),
      }),
    );
    expect(filings[1]?.[1]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          documentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          referralId: referralB,
        }),
      }),
    );
  });
});
