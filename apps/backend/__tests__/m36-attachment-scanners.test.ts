// M36 WP 1.5 — the scanner adapters and the upload policy (no DB, no network beyond a loopback fake clamd).
import { type Server, createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { attachmentScannerFromEnv } from "../src/m36-attachment-storage";
import {
  attachmentObjectKey,
  sanitizeFileName,
  validateAuthorizeInput,
} from "../src/modules/36-messaging/attachments/attachment-policy";
import {
  EICAR_SIGNATURE,
  TYPE_MISMATCH_SIGNATURE,
  createBuiltinScanner,
  createClamdScanner,
  parseClamdReply,
} from "../src/modules/36-messaging/attachments/attachment-scanners";

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const pdf = (extra = "") => new TextEncoder().encode(`%PDF-1.4\n${extra}\n%%EOF`);

describe("built-in scanner", () => {
  const scanner = createBuiltinScanner();

  it("quarantines the EICAR test string, even inside an otherwise valid PDF", async () => {
    const result = await scanner.scan({ bytes: pdf(EICAR), mimeType: "application/pdf" });
    expect(result).toEqual({ verdict: "infected", signature: EICAR_SIGNATURE });
  });

  it("quarantines content that is not the declared type", async () => {
    const result = await scanner.scan({
      bytes: new TextEncoder().encode("MZ\x90\x00 pretend executable"),
      mimeType: "application/pdf",
    });
    expect(result).toEqual({ verdict: "infected", signature: TYPE_MISMATCH_SIGNATURE });
  });

  it("passes a well-formed file of the declared type", async () => {
    expect(await scanner.scan({ bytes: pdf("hello"), mimeType: "application/pdf" })).toEqual({
      verdict: "clean",
    });
  });
});

describe("clamd reply parsing", () => {
  it("maps OK and FOUND, and treats anything else as an error (never as clean)", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ verdict: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({
      verdict: "infected",
      signature: "Win.Test.EICAR_HDB-1",
    });
    expect(() => parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toThrow();
    expect(() => parseClamdReply("")).toThrow();
  });
});

describe("clamd INSTREAM adapter", () => {
  let server: Server | undefined;
  afterEach(
    () => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())),
  );

  const listen = (reply: string | null): Promise<number> =>
    new Promise((resolve) => {
      server = createServer((socket) => {
        const received: Buffer[] = [];
        socket.on("data", (d) => {
          received.push(d);
          const all = Buffer.concat(received);
          // the stream ends with a zero-length chunk (four zero bytes)
          if (all.subarray(all.length - 4).equals(Buffer.alloc(4))) {
            if (reply === null) socket.destroy();
            else socket.end(reply);
          }
        });
      }).listen(0, "127.0.0.1", () => resolve((server?.address() as { port: number }).port));
    });

  it("returns clean on OK and infected on FOUND", async () => {
    const okPort = await listen("stream: OK\0");
    const ok = createClamdScanner({ host: "127.0.0.1", port: okPort, timeoutMs: 2000 });
    expect(await ok.scan({ bytes: pdf(), mimeType: "application/pdf" })).toEqual({
      verdict: "clean",
    });
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    const foundPort = await listen("stream: Eicar-Signature FOUND\0");
    const found = createClamdScanner({ host: "127.0.0.1", port: foundPort, timeoutMs: 2000 });
    expect(await found.scan({ bytes: pdf(EICAR), mimeType: "application/pdf" })).toEqual({
      verdict: "infected",
      signature: "Eicar-Signature",
    });
  });

  it("an unreachable scanner throws (the attachment stays pending); it never answers clean", async () => {
    const dead = createClamdScanner({ host: "127.0.0.1", port: 1, timeoutMs: 500 });
    await expect(dead.scan({ bytes: pdf(), mimeType: "application/pdf" })).rejects.toThrow();
  });

  it("a connection dropped mid-scan throws", async () => {
    const port = await listen(null);
    const scanner = createClamdScanner({ host: "127.0.0.1", port, timeoutMs: 2000 });
    await expect(scanner.scan({ bytes: pdf(), mimeType: "application/pdf" })).rejects.toThrow();
  });
});

describe("upload policy", () => {
  const ok = {
    fileName: "lab results.pdf",
    contentType: "application/pdf",
    byteSize: 1024,
    sha256Hex: "a".repeat(64),
  };

  it("accepts an allowed type and size", () => {
    expect(validateAuthorizeInput(ok).fileName).toBe("lab results.pdf");
  });

  it.each([
    ["an executable type", { ...ok, contentType: "application/x-msdownload" }],
    ["html", { ...ok, contentType: "text/html" }],
    ["zero bytes", { ...ok, byteSize: 0 }],
    ["over the size limit", { ...ok, byteSize: 25_000_001 }],
    ["a malformed checksum", { ...ok, sha256Hex: "ABC" }],
    ["a path in the file name", { ...ok, fileName: "../../etc/passwd" }],
  ])("rejects %s", (_name, input) => {
    expect(() => validateAuthorizeInput(input)).toThrow();
  });

  it("strips nothing silently: control characters in a name are refused", () => {
    expect(() => sanitizeFileName("a\u0000b.pdf")).toThrow();
    expect(() => sanitizeFileName("..")).toThrow();
  });

  it("the object key is ids only, never the file name", () => {
    expect(attachmentObjectKey("c1", "a1")).toBe("messaging/c1/a1");
  });

  it("strips bidirectional control characters so a name cannot spoof its own extension", () => {
    expect(sanitizeFileName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFileName("‎a‏⁦b⁩.pdf")).toBe("ab.pdf");
  });
});

describe("builtin scanner opt-in (any NODE_ENV)", () => {
  it.each([undefined, "development", "production", "test"])(
    "refuses MESSAGING_ATTACHMENT_SCANNER=builtin without ALLOW_BUILTIN_ATTACHMENT_SCANNER=1 (NODE_ENV=%s)",
    (nodeEnv) => {
      expect(() =>
        attachmentScannerFromEnv({ MESSAGING_ATTACHMENT_SCANNER: "builtin", NODE_ENV: nodeEnv }),
      ).toThrow(/ALLOW_BUILTIN_ATTACHMENT_SCANNER=1/);
    },
  );

  it("allows it with the explicit flag and warns loudly", () => {
    const warnings: string[] = [];
    const scanner = attachmentScannerFromEnv(
      {
        MESSAGING_ATTACHMENT_SCANNER: "builtin",
        ALLOW_BUILTIN_ATTACHMENT_SCANNER: "1",
        NODE_ENV: "production",
      },
      (m) => warnings.push(m),
    );
    expect(scanner?.name).toBe("builtin-signature");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/NOT scanned for malware/);
  });

  it("an unset scanner stays unset (fail closed: nothing leaves pending)", () => {
    expect(attachmentScannerFromEnv({})).toBeUndefined();
  });
});
