import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "./read-bounded-response-text";

describe("readBoundedResponseText", () => {
  it("counts streamed bytes and decodes UTF-8 across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode("café");
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 4));
          controller.enqueue(bytes.slice(4));
          controller.close();
        },
      }),
    );
    expect(await readBoundedResponseText(response, 5)).toEqual({ ok: true, text: "café" });
  });

  it("rejects an oversized declared body before reading it", async () => {
    let cancelled = false;
    let readerRequested = false;
    const response = {
      headers: new Headers({ "content-length": "6" }),
      body: {
        cancel: async () => {
          cancelled = true;
        },
        getReader: () => {
          readerRequested = true;
          throw new Error("oversized response must be rejected before reading");
        },
      },
    } as unknown as Response;
    expect(await readBoundedResponseText(response, 5)).toEqual({ ok: false, reason: "too_large" });
    expect(readerRequested).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("stops a streamed body as soon as actual bytes exceed the limit", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    expect(await readBoundedResponseText(response, 5)).toEqual({ ok: false, reason: "too_large" });
    expect(cancelled).toBe(true);
  });

  it.each(["", "invalid", "3,4", "-1"])(
    "ignores unusable Content-Length %j and relies on actual bytes",
    async (contentLength) => {
      const response = new Response("1234", { headers: { "content-length": contentLength } });
      expect(await readBoundedResponseText(response, 4)).toEqual({ ok: true, text: "1234" });
    },
  );

  it("rejects a misleading short Content-Length and a truncated body", async () => {
    const overDeclared = new Response("1234", { headers: { "content-length": "2" } });
    const truncated = new Response("12", { headers: { "content-length": "4" } });
    expect(await readBoundedResponseText(overDeclared, 8)).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(await readBoundedResponseText(truncated, 8)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("rejects invalid UTF-8 and unreadable streams without returning partial text", async () => {
    const invalidUtf8 = new Response(new Uint8Array([0xc3, 0x28]));
    const broken = new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new Error("synthetic stream failure"));
        },
      }),
    );
    expect(await readBoundedResponseText(invalidUtf8, 8)).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(await readBoundedResponseText(broken, 8)).toEqual({ ok: false, reason: "unreadable" });
  });
});
