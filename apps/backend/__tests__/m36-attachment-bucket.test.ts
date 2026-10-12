// M36 WP 1.5 — a missing tenant bucket is created on first upload, or fails with an actionable 503 (never a bare 404).
import { describe, expect, it, vi } from "vitest";
import { createM22BackedAttachmentStorage } from "../src/m36-attachment-storage";

const ORG = "11111111-1111-4111-8111-111111111111";
const upload = {
  organizationId: ORG,
  objectKey: "k",
  mimeType: "text/plain",
  sha256Hex: "0".repeat(64),
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
  it("ensures the bucket once per org before presigning", async () => {
    const ensure = vi.fn().mockResolvedValue({});
    const { port, presignUpload } = stores(ensure);
    await port.presignUpload(upload);
    await port.presignUpload(upload);
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(presignUpload).toHaveBeenCalledTimes(2);
  });

  it("answers an actionable DEGRADED error when the bucket cannot be created, and retries next time", async () => {
    const ensure = vi.fn().mockRejectedValueOnce(new Error("HTTP 403")).mockResolvedValue({});
    const { port } = stores(ensure);
    await expect(port.presignUpload(upload)).rejects.toThrow(
      /tenant-.*missing and could not be created/,
    );
    await port.presignUpload(upload);
    expect(ensure).toHaveBeenCalledTimes(2);
  });
});
