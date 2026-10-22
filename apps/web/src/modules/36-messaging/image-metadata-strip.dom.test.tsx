import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImageStripError, needsMetadataStrip, stripImageMetadata } from "./image-metadata-strip";

// jsdom has no decoder or canvas, so the browser pieces are shimmed. What is asserted is the policy around them: what the
// re-encode is asked for, and that anything unexpected fails closed instead of passing the original bytes through.
const close = vi.fn();
const toBlob = vi.fn();
const drawImage = vi.fn();

beforeEach(() => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4, height: 3, close })),
  );
  vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
    tag === "canvas"
      ? { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob }
      : Object.getPrototypeOf(document).createElement.call(
          document,
          tag,
        )) as typeof document.createElement);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const photo = (type: string) => new File([new Uint8Array([1, 2, 3])], "shot.jpg", { type });
const encodes = (blob: Blob | null) =>
  toBlob.mockImplementation((done: (b: Blob | null) => void) => done(blob));

describe("stripImageMetadata", () => {
  it("re-encodes a JPEG at quality 0.92 and returns the canvas bytes under the same name and type", async () => {
    encodes(new Blob([new Uint8Array([9, 9])], { type: "image/jpeg" }));
    const out = await stripImageMetadata(photo("image/jpeg"), "image/jpeg");
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.92);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("shot.jpg");
    expect(out.size).toBe(2); // the canvas bytes, not the original's 3
    expect(close).toHaveBeenCalled();
  });

  it("keeps a PNG a PNG", async () => {
    encodes(new Blob([new Uint8Array([7])], { type: "image/png" }));
    const out = await stripImageMetadata(photo("image/png"), "image/png");
    expect(toBlob.mock.calls[0]?.[1]).toBe("image/png");
    expect(out.type).toBe("image/png");
  });

  it("fails closed when the browser encoded a different type than requested", async () => {
    encodes(new Blob([new Uint8Array([1])], { type: "image/png" })); // e.g. a browser without JPEG output
    await expect(stripImageMetadata(photo("image/jpeg"), "image/jpeg")).rejects.toBeInstanceOf(
      ImageStripError,
    );
  });

  it("fails closed on a null blob and on an empty one", async () => {
    encodes(null);
    await expect(stripImageMetadata(photo("image/jpeg"), "image/jpeg")).rejects.toBeInstanceOf(
      ImageStripError,
    );
    encodes(new Blob([], { type: "image/jpeg" }));
    await expect(stripImageMetadata(photo("image/jpeg"), "image/jpeg")).rejects.toBeInstanceOf(
      ImageStripError,
    );
  });

  it("fails closed when the image cannot be decoded", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("bad image", "InvalidStateError");
      }),
    );
    await expect(stripImageMetadata(photo("image/jpeg"), "image/jpeg")).rejects.toBeInstanceOf(
      ImageStripError,
    );
  });
});

describe("needsMetadataStrip", () => {
  it("covers JPEG and PNG only", () => {
    expect(needsMetadataStrip("image/jpeg")).toBe(true);
    expect(needsMetadataStrip("image/png")).toBe(true);
    expect(needsMetadataStrip("application/pdf")).toBe(false);
    expect(needsMetadataStrip("image/tiff")).toBe(false);
  });
});
