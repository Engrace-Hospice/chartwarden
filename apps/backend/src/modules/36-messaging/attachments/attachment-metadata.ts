// M36 WP 5.3 server guard: does an image upload still carry embedded metadata (EXIF/GPS, XMP, IPTC, comments, text chunks)?
//
// The CLIENT strips metadata before upload (decision D3). The server cannot rewrite the object (its checksum is bound at
// authorize, the storage port has no write, the bucket is versioned), so it fails closed instead: the scan pipeline
// quarantines any image that still carries any, or that this parser cannot fully account for.
//
// Design:
//  - SNIFF, never trust the declared mime: the format is decided from the magic bytes (a JPEG labelled image/png is
//    still walked as a JPEG). Anything that is not JPEG/PNG/TIFF by magic is "clean" here (the type check and the
//    scanner own it).
//  - ALLOWLIST: JPEG markers and PNG chunks not on the structural allowlist below are metadata. New/unknown = flagged.
//  - WHOLE FILE: JPEG is walked through every scan to EOI and the bytes after EOI are inspected; PNG is walked to IEND
//    and the bytes after IEND are inspected. Only zero padding may trail.
//  - FAIL CLOSED: truncation, cap exhaustion, malformed lengths and any parser fault yield "unparseable", never "clean".
//  - TIFF is in the attachment mime allowlist and the client cannot strip it, so its IFD chain is parsed for GPS
//    (0x8825), Exif IFD (0x8769), XMP (0x02BC), IPTC (0x83BB), Photoshop (0x8649) and SubIFDs (0x014A); BigTIFF and
//    anything unparseable is quarantined.
//
// Pure, synchronous, never throws. Work is O(n): every loop step consumes at least one byte and is additionally
// capped by the buffer length.

export type ImageMetadataVerdict = "clean" | "metadata" | "unparseable";

const CLEAN = "clean";
const METADATA = "metadata";
const UNPARSEABLE = "unparseable";

const MARKER_PREFIX = 0xff;
const JPEG_SOI = 0xd8;
const JPEG_EOI = 0xd9;
const JPEG_TEM = 0x01;
const JPEG_RST_FIRST = 0xd0;
const JPEG_RST_LAST = 0xd7;
const JPEG_APP0 = 0xe0;
const JPEG_APP2 = 0xe2;
const JPEG_APP14 = 0xee;
/** SOF0..SOF15 minus DHT (c4), JPG (c8) which is reserved; DAC (cc) is structural. */
const JPEG_STRUCTURAL = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcc, // SOFn, DAC
  0xc4, // DHT
  0xdb, // DQT
  0xdc, // DNL
  0xdd, // DRI
  0xda, // SOS
]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_CHUNK_ALLOWLIST = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "pHYs",
  "iCCP",
  "tIME",
]);
const PNG_CHUNK_OVERHEAD = 12; // length + type + crc

const TIFF_METADATA_TAGS = new Set([0x8825, 0x8769, 0x02bc, 0x83bb, 0x8649, 0x014a]);
const TIFF_ENTRY_BYTES = 12;

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function u32be(bytes: Uint8Array, p: number): number {
  return (
    (((bytes[p] as number) << 24) |
      ((bytes[p + 1] as number) << 16) |
      ((bytes[p + 2] as number) << 8) |
      (bytes[p + 3] as number)) >>>
    0
  );
}

/** Only NUL padding may follow the end-of-image marker/chunk. */
function trailerVerdict(bytes: Uint8Array, from: number): ImageMetadataVerdict {
  for (let i = from; i < bytes.length; i += 1) if (bytes[i] !== 0) return METADATA;
  return CLEAN;
}

/** Next real marker at or after `from` (skips stuffed FF00, fill FFFF and any junk, as libjpeg does), or -1. */
function nextJpegMarker(bytes: Uint8Array, from: number): number {
  let i = from;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== MARKER_PREFIX) i += 1;
    else if (bytes[i + 1] === MARKER_PREFIX) i += 1;
    else if (bytes[i + 1] === 0) i += 2;
    else return i;
  }
  return -1;
}

/** Is this a segment we accept as non-metadata, given its payload start? */
function jpegSegmentAllowed(bytes: Uint8Array, code: number, payload: number): boolean {
  if (JPEG_STRUCTURAL.has(code)) return true;
  if (code === JPEG_APP0) return asciiAt(bytes, payload, "JFIF\0");
  if (code === JPEG_APP2) return asciiAt(bytes, payload, "ICC_PROFILE\0");
  if (code === JPEG_APP14) return asciiAt(bytes, payload, "Adobe");
  return false;
}

function jpegVerdict(bytes: Uint8Array): ImageMetadataVerdict {
  let pos = 2; // past SOI
  let sawScan = false;
  for (let step = 0; step <= bytes.length; step += 1) {
    const at = nextJpegMarker(bytes, pos);
    if (at < 0) return UNPARSEABLE; // ran off the end without EOI
    const code = bytes[at + 1] as number;
    pos = at + 2;
    if (code === JPEG_EOI) return sawScan ? trailerVerdict(bytes, pos) : UNPARSEABLE;
    if (code === JPEG_SOI) return METADATA; // nested image (thumbnail/preview)
    if (code === JPEG_TEM || (code >= JPEG_RST_FIRST && code <= JPEG_RST_LAST)) continue;
    if (pos + 2 > bytes.length) return UNPARSEABLE;
    const length = ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number); // includes the 2 length bytes
    if (length < 2 || pos + length > bytes.length) return UNPARSEABLE;
    if (!jpegSegmentAllowed(bytes, code, pos + 2)) return METADATA;
    if (code === 0xda) sawScan = true;
    pos += length;
  }
  return UNPARSEABLE; // cap exhausted
}

function pngVerdict(bytes: Uint8Array): ImageMetadataVerdict {
  let pos = PNG_SIGNATURE.length;
  for (let step = 0; step <= bytes.length; step += 1) {
    if (pos + PNG_CHUNK_OVERHEAD > bytes.length) return UNPARSEABLE;
    const length = u32be(bytes, pos);
    if (pos + PNG_CHUNK_OVERHEAD + length > bytes.length) return UNPARSEABLE;
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (!PNG_CHUNK_ALLOWLIST.has(type)) return METADATA;
    pos += PNG_CHUNK_OVERHEAD + length;
    if (type === "IEND") return trailerVerdict(bytes, pos);
  }
  return UNPARSEABLE;
}

function tiffVerdict(bytes: Uint8Array): ImageMetadataVerdict {
  const little = bytes[0] === 0x49;
  const u16 = (p: number) =>
    little
      ? (bytes[p] as number) | ((bytes[p + 1] as number) << 8)
      : ((bytes[p] as number) << 8) | (bytes[p + 1] as number);
  const u32 = (p: number) =>
    little
      ? ((bytes[p] as number) |
          ((bytes[p + 1] as number) << 8) |
          ((bytes[p + 2] as number) << 16) |
          ((bytes[p + 3] as number) << 24)) >>>
        0
      : u32be(bytes, p);
  if (bytes.length < 8) return UNPARSEABLE;
  const seen = new Set<number>();
  let ifd = u32(4);
  while (ifd !== 0) {
    if (seen.has(ifd) || ifd + 2 > bytes.length) return UNPARSEABLE; // cycle or out of range
    seen.add(ifd);
    const count = u16(ifd);
    const end = ifd + 2 + count * TIFF_ENTRY_BYTES;
    if (end + 4 > bytes.length) return UNPARSEABLE;
    for (let e = ifd + 2; e < end; e += TIFF_ENTRY_BYTES) {
      if (TIFF_METADATA_TAGS.has(u16(e))) return METADATA;
    }
    ifd = u32(end);
  }
  return CLEAN;
}

export function inspectImageMetadata(bytes: Uint8Array): ImageMetadataVerdict {
  try {
    if (
      bytes.length >= 4 &&
      bytes[0] === MARKER_PREFIX &&
      bytes[1] === JPEG_SOI &&
      bytes[2] === MARKER_PREFIX
    ) {
      return jpegVerdict(bytes);
    }
    if (bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
      return pngVerdict(bytes);
    }
    const head = bytes.length >= 4 ? [bytes[0], bytes[1], bytes[2], bytes[3]] : [];
    const isLittle = head[0] === 0x49 && head[1] === 0x49 && head[3] === 0;
    const isBig = head[0] === 0x4d && head[1] === 0x4d && head[2] === 0;
    if ((isLittle && head[2] === 0x2a) || (isBig && head[3] === 0x2a)) return tiffVerdict(bytes);
    if ((isLittle && head[2] === 0x2b) || (isBig && head[3] === 0x2b)) return UNPARSEABLE; // BigTIFF
    return CLEAN;
  } catch {
    return UNPARSEABLE; // a parser fault must quarantine, never pass
  }
}
