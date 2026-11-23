import { describe, expect, it } from "vitest";
import {
  createClamdDocumentScanner,
  documentContentScannerFromEnv,
  documentUploadScanRequired,
  parseClamdDocumentReply,
} from "./document-content-scanner";

describe("M22 clamd document scanner", () => {
  it("parses only explicit clean and infected verdicts", () => {
    expect(parseClamdDocumentReply("stream: OK\n")).toEqual({ verdict: "clean" });
    expect(parseClamdDocumentReply("stream: Eicar-Test-Signature FOUND\n")).toEqual({
      verdict: "infected",
    });
    expect(() => parseClamdDocumentReply("stream: UNKNOWN\n")).toThrow(/did not produce a verdict/);
  });

  it("honours a caller cancellation before opening a socket", async () => {
    const scanner = createClamdDocumentScanner({ host: "127.0.0.1", port: 3310 });
    const controller = new AbortController();
    controller.abort(new Error("synthetic cancellation"));
    await expect(
      scanner.scan({
        bytes: Buffer.from("%PDF-synthetic"),
        mimeType: "application/pdf",
        signal: controller.signal,
      }),
    ).rejects.toThrow("synthetic cancellation");
  });

  it("binds only from an explicit clamd host and validates the port", () => {
    expect(documentContentScannerFromEnv({})).toBeNull();
    expect(documentContentScannerFromEnv({ CLAMD_HOST: "clamav" })).not.toBeNull();
    expect(() =>
      documentContentScannerFromEnv({ CLAMD_HOST: "clamav", CLAMD_PORT: "not-a-port" }),
    ).toThrow(/CLAMD_PORT/);
  });

  it("requires scanning unconditionally in production and only by opt-in elsewhere", () => {
    expect(documentUploadScanRequired({ NODE_ENV: "production" })).toBe(true);
    expect(
      documentUploadScanRequired({
        NODE_ENV: "production",
        DOCUMENT_UPLOAD_SCAN_REQUIRED: "false",
      }),
    ).toBe(true);
    expect(documentUploadScanRequired({ NODE_ENV: "test" })).toBe(false);
    expect(
      documentUploadScanRequired({ NODE_ENV: "test", DOCUMENT_UPLOAD_SCAN_REQUIRED: "true" }),
    ).toBe(true);
  });
});
