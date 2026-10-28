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
    expect(onFiled.mock.calls[0]?.[0]).toMatch(/appears in the queue/);
  });
});
