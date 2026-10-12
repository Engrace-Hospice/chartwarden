// M36 WP 1.5 — a missing tenant bucket is created on first upload, or fails with an actionable 503 (never a bare 404).
import { describe, expect, it, vi } from "vitest";
import { createM22BackedAttachmentStorage } from "../src/m36-attachment-storage";

const ORG = "11111111-1111-4111-8111-111111111111";
const upload = {
  organizationId: ORG,
  objectKey: "k",
  mimeType: "text/plain",
  sha256Hex: "0".repeat(64),
  byteSize: 1,
  ttlSeconds: 60,
};
const stores = (ensure?: (o: string) => Promise<unknown>) => {
  const presignUpload = vi.fn().mockResolvedValue({ url: "u" });
  const port = createM22BackedAttachmentStorage({
    publicStore: { presignUpload } as never,
    internalStore: {} as never,
    ensureTenantBucket: ensure,
  });
  return { port, presignUpload };
};

describe("attachment storage tenant bucket", () => {
  it("ensures the bucket once per org (ensureBucket), and presigning does no IO of its own", async () => {
    const ensure = vi.fn().mockResolvedValue({});
    const { port, presignUpload } = stores(ensure);
    await port.ensureBucket?.(ORG);
    await port.ensureBucket?.(ORG);
    await port.presignUpload({ ...upload, byteSize: 1 });
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(presignUpload).toHaveBeenCalledTimes(1);
  });

  it("answers a generic DEGRADED error (no bucket name) when the bucket cannot be created, logs the detail, and retries next time", async () => {
    const ensure = vi.fn().mockRejectedValueOnce(new Error("HTTP 403")).mockResolvedValue({});
    const logged: string[] = [];
    const presignUpload = vi.fn();
    const port = createM22BackedAttachmentStorage({
      publicStore: { presignUpload } as never,
      internalStore: {} as never,
      ensureTenantBucket: ensure,
      onError: (message) => logged.push(message),
    });
    const failure = await port.ensureBucket?.(ORG).then(
      () => null,
      (e: Error) => e,
    );
    expect(failure?.message).not.toMatch(/tenant-/);
    expect(failure?.message).toMatch(/temporarily unavailable/);
    expect(logged.join(" ")).toMatch(/tenant-.*missing and could not be created/);
    await port.ensureBucket?.(ORG);
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
