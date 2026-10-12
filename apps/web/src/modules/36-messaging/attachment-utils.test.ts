import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENT_BYTES,
  apiErrorCode,
  displayFileName,
  formatBytes,
  isSafeAccessUrl,
  resolveContentType,
  selectFiles,
  sendBlockedReason,
  sha256Hex,
  toSentAttachments,
} from "./attachment-utils";
import type { AttachmentChip } from "./messaging-types";

const file = (name: string, type: string, size = 10) => {
  const made = new File(["x"], name, { type });
  Object.defineProperty(made, "size", { value: size });
  return made;
};

describe("attachment-utils", () => {
  it("resolves the type from the browser, falling back to the extension only when the type is empty", () => {
    expect(resolveContentType(file("a.pdf", "application/pdf"))).toBe("application/pdf");
    expect(resolveContentType(file("a.DOCX", ""))).toContain("wordprocessingml");
    expect(resolveContentType(file("a.pdf", "application/x-msdownload"))).toBeNull();
    expect(resolveContentType(file("a.exe", ""))).toBeNull();
  });

  it("accepts both MIME types and extensions in the input filter", () => {
    expect(ATTACHMENT_ACCEPT).toContain("application/pdf");
    expect(ATTACHMENT_ACCEPT).toContain(".tiff");
  });

  it("enforces size and count limits at the boundary", () => {
    expect(
      selectFiles([file("a.pdf", "application/pdf", MAX_ATTACHMENT_BYTES)], 0).accepted,
    ).toHaveLength(1);
    expect(
      selectFiles([file("a.pdf", "application/pdf", MAX_ATTACHMENT_BYTES + 1)], 0).rejections,
    ).toHaveLength(1);
    expect(selectFiles([file("a.pdf", "application/pdf", 0)], 0).rejections).toHaveLength(1);
    const two = [file("a.pdf", "application/pdf"), file("b.pdf", "application/pdf")];
    const result = selectFiles(two, 9);
    expect(result.accepted.map((entry) => entry.file.name)).toEqual(["a.pdf"]);
    expect(result.rejections[0]).toContain("b.pdf");
  });

  it("formats sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2_500)).toBe("2.5 KB");
    expect(formatBytes(2_500_000)).toBe("2.5 MB");
  });

  it("hashes to lowercase hex", async () => {
    const blob = { arrayBuffer: async () => new TextEncoder().encode("abc").buffer } as Blob;
    expect(await sha256Hex(blob)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("reads the error code from either envelope shape", () => {
    expect(apiErrorCode({ code: "A" })).toBe("A");
    expect(apiErrorCode({ error: { code: "B" } })).toBe("B");
    expect(apiErrorCode(undefined)).toBeNull();
  });

  it("allows https, and plain http only to loopback", () => {
    expect(isSafeAccessUrl("https://x.test/a?b=c")).toBe(true);
    expect(isSafeAccessUrl("http://localhost:9000/a")).toBe(true);
    expect(isSafeAccessUrl("http://127.0.0.1:9000/a")).toBe(true);
    expect(isSafeAccessUrl("http://x.test/a")).toBe(false);
    expect(isSafeAccessUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAccessUrl("not a url")).toBe(false);
  });

  it("strips bidi control characters from displayed file names", () => {
    expect(displayFileName("invoice\u202Egnp.exe")).toBe("invoicegnp.exe");
    expect(displayFileName("a\u200Eb\u2066c\u2069.pdf")).toBe("abc.pdf");
  });

  it("maps only ready and scanning chips to optimistic message rows", () => {
    const chip = (status: AttachmentChip["status"], attachmentId: string | null) => ({
      localId: `l-${status}`,
      file: new File(["x"], "a.pdf"),
      fileName: "a.pdf",
      contentType: "application/pdf",
      byteSize: 1,
      status,
      message: null,
      attachmentId,
    });
    const rows = toSentAttachments([
      chip("ready", "r"),
      chip("scanning", "s"),
      chip("failed", "f"),
      chip("hashing", null),
    ]);
    expect(rows.map((row) => [row.attachmentId, row.availability])).toEqual([
      ["r", "available"],
      ["s", "scanning"],
    ]);
  });

  it("explains why attachments hold Send back", () => {
    const chip = (status: AttachmentChip["status"]) => ({ status }) as unknown as AttachmentChip;
    expect(sendBlockedReason([chip("ready"), chip("scanning")])).toBeNull();
    expect(sendBlockedReason([chip("uploading")])).toMatch(/finish uploading/);
    expect(sendBlockedReason([chip("uploading"), chip("failed")])).toMatch(/Retry or remove/);
  });
});
