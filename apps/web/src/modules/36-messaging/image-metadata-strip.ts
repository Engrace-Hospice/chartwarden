/**
 * WP 5.3: drop all metadata (EXIF GPS, device, timestamps, XMP, ICC extras) from a JPEG/PNG before it is hashed or
 * uploaded. Re-encoding through a canvas keeps pixels only; `imageOrientation: "from-image"` bakes the EXIF rotation
 * in first so the picture does not turn sideways once the tag is gone. Fails closed: a file that cannot be decoded
 * is rejected, never passed through.
 */

const JPEG_QUALITY = 0.92;
const STRIPPABLE_TYPES: ReadonlySet<string> = new Set(["image/jpeg", "image/png"]);

export class ImageStripError extends Error {
  constructor() {
    super("image-strip-failed");
    this.name = "ImageStripError";
  }
}

export type ImageStripper = (file: File, contentType: string) => Promise<File>;

/** TIFF, PDF, DOCX and text are untouched; only JPEG and PNG are re-encoded. */
export const needsMetadataStrip = (contentType: string): boolean =>
  STRIPPABLE_TYPES.has(contentType);

export const stripImageMetadata: ImageStripper = async (file, contentType) => {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new ImageStripError();
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, contentType, JPEG_QUALITY),
      );
      if (!blob || blob.size === 0 || blob.type !== contentType) throw new ImageStripError();
      return new File([blob], file.name, { type: contentType, lastModified: Date.now() });
    } finally {
      bitmap.close();
    }
  } catch {
    throw new ImageStripError();
  }
};
