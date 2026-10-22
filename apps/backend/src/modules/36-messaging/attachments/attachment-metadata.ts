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
//  - TIFF is in the attachment mime allowlist and the client cannot strip it, so its IFD chain is parsed against an
//    ALLOWLIST of baseline structural tags (plus ICC 0x8773); every other tag (GPS/Exif/SubIFD pointers, XMP, IPTC,
//    ImageDescription, Make, Model, Software, DateTime, Artist, Copyright, unknown/private tags) is metadata. BigTIFF
//    and anything unparseable is quarantined.
//
// Residual (accepted, M4): bytes that no allowed structure references (e.g. unreferenced TIFF regions, payload inside
// allowed segments such as ICC or IDAT) are NOT tracked. The guard targets accidental metadata from honest clients whose
// client-side re-encode should have removed it; adversarial steganography inside allowed payloads is out of scope.
//
// Pure, synchronous, never throws. JPEG and PNG walks are O(n) (each step consumes at least one byte, capped by the
// buffer length). The TIFF walk is bounded by a TOTAL entry budget of about bytes.length / 12, so overlapping IFDs
// cannot make it quadratic; exhausting the budget is "unparseable".

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
const PNG_PLTE_MAX = 768;
/** Exact spec data lengths of the fixed-size chunks; a wrong length can hide extra bytes, so it is metadata. */
function pngChunkLengthOk(type: string, length: number): boolean {
  switch (type) {
    case "IHDR":
      return length === 13;
    case "tIME":
      return length === 7;
    case "gAMA":
      return length === 4;
    case "sRGB":
      return length === 1;
    case "cHRM":
      return length === 32;
    case "sBIT":
      return length >= 1 && length <= 4;
    case "pHYs":
      return length === 9;
    case "PLTE":
      return length > 0 && length % 3 === 0 && length <= PNG_PLTE_MAX;
    default:
      return true;
  }
}

/** Baseline structural TIFF tags plus ICC (0x8773, same class as the JPEG/PNG ICC allowance). Any other tag is metadata. */
const TIFF_STRUCTURAL_TAGS = new Set([
  0xfe, 0xff, 0x100, 0x101, 0x102, 0x103, 0x106, 0x107, 0x10a, 0x111, 0x112, 0x115, 0x116, 0x117,
  0x11a, 0x11b, 0x11c, 0x128, 0x13d, 0x140, 0x142, 0x143, 0x144, 0x145, 0x152, 0x153, 0x15b, 0x211,
  0x212, 0x213, 0x214, 0x8773,
]);
const TIFF_ENTRY_BYTES = 12;
const TIFF_ICC_TAG = 0x8773;
const TIFF_ICC_MAX_BYTES = 1 << 20;
const TIFF_BUDGET_SLACK = 16;

/** Does `text` start at `offset` and fit entirely before `end` (the segment end, so an empty segment cannot over-read)? */
function asciiAt(bytes: Uint8Array, offset: number, text: string, end = bytes.length): boolean {
  if (offset + text.length > end || offset + text.length > bytes.length) return false;
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

const JPEG_DQT = 0xdb;
const JPEG_DHT = 0xc4;
const JPEG_DRI = 0xdd;
const JPEG_SOS = 0xda;
const JFIF_SEGMENT_LENGTH = 16;
const ADOBE_SEGMENT_LENGTH = 14;
const DRI_SEGMENT_LENGTH = 4;
const DQT_LENGTH = { min: 67, max: 518 };
const DHT_LENGTH = { min: 20, max: 2200 };
const SOF_LENGTH = { min: 11, max: 773 };
const SOF_CODES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb]);

function within(length: number, range: { min: number; max: number }): boolean {
  return length >= range.min && length <= range.max;
}

/** Is this a segment we accept as non-metadata? `length` includes the 2 length bytes; `payload` is its first data byte. */
function jpegSegmentAllowed(
  bytes: Uint8Array,
  code: number,
  payload: number,
  length: number,
): boolean {
  const end = payload + length - 2;
  if (SOF_CODES.has(code)) return within(length, SOF_LENGTH);
  if (code === JPEG_DQT) return within(length, DQT_LENGTH);
  if (code === JPEG_DHT) return within(length, DHT_LENGTH);
  if (code === JPEG_DRI) return length === DRI_SEGMENT_LENGTH;
  if (code === JPEG_SOS || JPEG_STRUCTURAL.has(code)) return true; // SOS, DAC, DNL
  if (code === JPEG_APP0) {
    // Exactly the 16-byte JFIF header with no embedded thumbnail (thumbnail width/height = 0).
    return (
      length === JFIF_SEGMENT_LENGTH &&
      asciiAt(bytes, payload, "JFIF\0", end) &&
      bytes[payload + 12] === 0 &&
      bytes[payload + 13] === 0
    );
  }
  if (code === JPEG_APP2) return asciiAt(bytes, payload, "ICC_PROFILE\0", end);
  if (code === JPEG_APP14)
    return length === ADOBE_SEGMENT_LENGTH && asciiAt(bytes, payload, "Adobe", end);
  return false;
}

/**
 * Marker position in the header region: only 0xFF fill bytes may precede the marker, any other byte is junk that could
 * hide data, so it is metadata. Returns -1 at end of buffer, -2 for junk.
 */
function strictJpegMarker(bytes: Uint8Array, from: number): number {
  let at = from;
  while (at + 1 < bytes.length && bytes[at] === MARKER_PREFIX && bytes[at + 1] === MARKER_PREFIX) {
    at += 1;
  }
  if (at + 1 >= bytes.length) return -1;
  if (bytes[at] !== MARKER_PREFIX || bytes[at + 1] === 0) return -2;
  return at;
}

function jpegVerdict(bytes: Uint8Array): ImageMetadataVerdict {
  let pos = 2; // past SOI
  let sawScan = false;
  let inScan = false; // true from the end of an SOS header: entropy-coded data may contain non-marker bytes
  for (let step = 0; step <= bytes.length; step += 1) {
    const at = inScan ? nextJpegMarker(bytes, pos) : strictJpegMarker(bytes, pos);
    if (at === -2) return METADATA;
    if (at < 0) return UNPARSEABLE; // ran off the end without EOI
    const code = bytes[at + 1] as number;
    pos = at + 2;
    if (code === JPEG_EOI) return sawScan ? trailerVerdict(bytes, pos) : UNPARSEABLE;
    if (code === JPEG_SOI) return METADATA; // nested image (thumbnail/preview)
    if (code === JPEG_TEM || (code >= JPEG_RST_FIRST && code <= JPEG_RST_LAST)) continue;
    if (pos + 2 > bytes.length) return UNPARSEABLE;
    const length = ((bytes[pos] as number) << 8) | (bytes[pos + 1] as number); // includes the 2 length bytes
    if (length < 2 || pos + length > bytes.length) return UNPARSEABLE;
    if (!jpegSegmentAllowed(bytes, code, pos + 2, length)) return METADATA;
    inScan = code === JPEG_SOS;
    if (inScan) sawScan = true;
    pos += length;
  }
  return UNPARSEABLE; // cap exhausted
}

function pngVerdict(bytes: Uint8Array): ImageMetadataVerdict {
  let pos = PNG_SIGNATURE.length;
  let sawIccp = false;
  for (let step = 0; step <= bytes.length; step += 1) {
    if (pos + PNG_CHUNK_OVERHEAD > bytes.length) return UNPARSEABLE;
    const length = u32be(bytes, pos);
    if (pos + PNG_CHUNK_OVERHEAD + length > bytes.length) return UNPARSEABLE;
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (!PNG_CHUNK_ALLOWLIST.has(type) || !pngChunkLengthOk(type, length)) return METADATA;
    if (type === "iCCP") {
      if (sawIccp) return METADATA; // at most one profile
      sawIccp = true;
    }
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
  // Total entries scanned across ALL IFDs: overlapping IFDs at different offsets would otherwise be quadratic.
  let budget = Math.floor(bytes.length / TIFF_ENTRY_BYTES) + TIFF_BUDGET_SLACK;
  let ifd = u32(4);
  while (ifd !== 0) {
    if (seen.has(ifd) || ifd + 2 > bytes.length) return UNPARSEABLE; // cycle or out of range
    seen.add(ifd);
    const count = u16(ifd);
    const end = ifd + 2 + count * TIFF_ENTRY_BYTES;
    if (end + 4 > bytes.length) return UNPARSEABLE;
    budget -= count;
    if (budget < 0) return UNPARSEABLE;
    for (let e = ifd + 2; e < end; e += TIFF_ENTRY_BYTES) {
      const tag = u16(e);
      if (!TIFF_STRUCTURAL_TAGS.has(tag)) return METADATA;
      if (tag === TIFF_ICC_TAG && u32(e + 4) > TIFF_ICC_MAX_BYTES) return METADATA;
    }
    ifd = u32(end);
  }
  return CLEAN;
}

// The JPEG sniff needs FF D8 FF; a file starting FF D8 + anything else falls through to "clean" here and relies on the
// scanner's matchesDeclaredType check (attachment-scanners.ts) to reject it as not a JPEG.
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
