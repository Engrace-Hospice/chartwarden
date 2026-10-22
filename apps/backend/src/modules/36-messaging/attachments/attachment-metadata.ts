// M36 WP 5.3 server guard: does an image upload still carry embedded metadata (EXIF/GPS, XMP, IPTC, PNG text chunks)?
//
// The CLIENT strips metadata before upload (decision D3). The server cannot rewrite the object (its checksum is bound at
// authorize, the storage port has no write, the bucket is versioned), so it fails closed instead: the scan pipeline
// quarantines any JPEG/PNG that still carries any. Pure, synchronous, never throws, never reads past the buffer.
//
// Scope: image/jpeg and image/png only. TIFF is deliberately NOT inspected (its metadata is inline IFD tags, not a
// separable segment, so there is no cheap sound "has metadata" test); it passes through unchanged. Every other type: false.
//
// Both formats put metadata before the pixel data (JPEG: before SOS; PNG: ancillary chunks before IDAT for the cases
// above), so the walk stops there. A hard step cap bounds work on hostile input.

/** Upper bound on segments/chunks visited: bounds work on a hostile file made of thousands of empty segments. */
const MAX_STEPS = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_METADATA_CHUNKS = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);

const MARKER_PREFIX = 0xff;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_SOS = 0xda;
const JPEG_APP1 = 0xe1;
const JPEG_APP13 = 0xed;
const JPEG_TEM = 0x01;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;

const EXIF_ID = "Exif\0\0";
/** Covers both the XMP packet ("…/xap/1.0/") and the extended-XMP ("…/xmp/extension/") namespaces. */
const XMP_ID_PREFIX = "http://ns.adobe.com/x";

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length && i < bytes.length; i += 1) {
    out += String.fromCharCode(bytes[i] as number);
  }
  return out;
}

function jpegHasMetadata(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== MARKER_PREFIX || bytes[1] !== JPEG_SOI) return false;
  let pos = 2;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    // Skip fill bytes; every marker is 0xFF <code>.
    while (pos < bytes.length && bytes[pos] === MARKER_PREFIX && bytes[pos + 1] === MARKER_PREFIX)
      pos += 1;
    if (pos + 2 > bytes.length || bytes[pos] !== MARKER_PREFIX) return false;
    const code = bytes[pos + 1] as number;
    pos += 2;
    if (code === JPEG_SOS || code === JPEG_EOI) return false;
    if (code === JPEG_TEM || (code >= JPEG_RST_FIRST && code <= JPEG_RST_LAST)) continue; // standalone, no length
    if (pos + 2 > bytes.length) return false;
    const length = ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number); // includes the 2 length bytes
    if (length < 2) return false;
    const payload = pos + 2;
    if (code === JPEG_APP13) return true; // Photoshop 3.0 / IPTC-IIM
    if (code === JPEG_APP1) {
      if (asciiAt(bytes, payload, EXIF_ID.length) === EXIF_ID) return true;
      if (asciiAt(bytes, payload, XMP_ID_PREFIX.length) === XMP_ID_PREFIX) return true;
    }
    pos += length;
  }
  return false; // step cap reached without a hit
}

function pngHasMetadata(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length || PNG_SIGNATURE.some((b, i) => bytes[i] !== b))
    return false;
  let pos = PNG_SIGNATURE.length;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (pos + 8 > bytes.length) return false;
    // >>> 0 keeps the 32-bit length unsigned.
    const length =
      (((bytes[pos] as number) << 24) |
        ((bytes[pos + 1] as number) << 16) |
        ((bytes[pos + 2] as number) << 8) |
        (bytes[pos + 3] as number)) >>>
      0;
    const type = asciiAt(bytes, pos + 4, 4);
    if (PNG_METADATA_CHUNKS.has(type)) return true;
    if (type === "IDAT" || type === "IEND") return false;
    pos += 12 + length; // length + type + data + crc
  }
  return false;
}

export function hasImageMetadata(bytes: Uint8Array, mimeType: string): boolean {
  try {
    if (mimeType === "image/jpeg") return jpegHasMetadata(bytes);
    if (mimeType === "image/png") return pngHasMetadata(bytes);
    return false;
  } catch {
    // Unreachable by construction (every read is bounds-checked). A parser fault must not throw the scan; the
    // checksum and scanner stages still run for the file.
    return false;
  }
}
