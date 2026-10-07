// @wardenx/terminology-loader — byte-level helpers: sha256, a lazy line iterator, and a minimal ZIP reader.
//
// The ZIP reader exists because the vendors ship zips (NCHS, FDA, NLM, SNOMED) and the loader must not
// shell out to `unzip` inside a worker. It supports exactly what those archives use — STORED and DEFLATE
// members, no encryption, no ZIP64 — and refuses anything else loudly rather than misreading it.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { LoaderDataError } from "./errors";
import type { SourceBundle } from "./types";

/** sha256 of the bytes, lowercase hex — the value the `code_system_version.checksum` column holds. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hard ceiling on one inflated member: a defence against a decompression bomb in an uploaded archive. */
export const MAX_ENTRY_BYTES = 1_500_000_000;

const LF = 0x0a;

/** Yield lines without ever materialising the whole file as one string (V8 caps a string near 512 MB). */
export function* iterLines(bytes: Uint8Array): Generator<string> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  while (start < buf.length) {
    let end = buf.indexOf(LF, start);
    if (end === -1) end = buf.length;
    const stop = end > start && buf[end - 1] === 0x0d ? end - 1 : end;
    yield buf.toString("utf8", start, stop);
    start = end + 1;
  }
}

/** Decode a whole (modest) file as UTF-8, stripping a BOM. */
export function decodeUtf8(bytes: Uint8Array): string {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;
const STORED = 0;
const DEFLATED = 8;

/** True when the bytes start with the ZIP local-file-header magic. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return ZIP_MAGIC.every((b, i) => bytes[i] === b);
}

interface ZipMember {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

function listMembers(buf: Buffer): ZipMember[] {
  let eocd = -1;
  const floor = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new LoaderDataError("ZIP_INVALID", "end-of-central-directory record not found");
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new LoaderDataError("ZIP_UNSUPPORTED", "ZIP64 archives are not supported");
  }
  const members: ZipMember[] = [];
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new LoaderDataError("ZIP_INVALID", "corrupt central directory");
    }
    const flags = buf.readUInt16LE(p + 8);
    if (flags & 1) throw new LoaderDataError("ZIP_UNSUPPORTED", "encrypted archive members");
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    members.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      uncompressedSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return members;
}

function inflateMember(buf: Buffer, m: ZipMember): Uint8Array {
  if (m.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new LoaderDataError(
      "ZIP_TOO_LARGE",
      `member '${m.name}' exceeds ${MAX_ENTRY_BYTES} bytes`,
    );
  }
  const o = m.localOffset;
  if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC_SIG) {
    throw new LoaderDataError("ZIP_INVALID", `bad local header for '${m.name}'`);
  }
  const dataStart = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28);
  const raw = buf.subarray(dataStart, dataStart + m.compressedSize);
  if (m.method === STORED) return raw;
  if (m.method !== DEFLATED) {
    throw new LoaderDataError("ZIP_UNSUPPORTED", `compression method ${m.method} in '${m.name}'`);
  }
  return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_BYTES });
}

/** Open an upload as a {@link SourceBundle}: a zip exposes its members, anything else is one entry `upload`. */
export function bundleFromBytes(bytes: Uint8Array): SourceBundle {
  if (!looksLikeZip(bytes)) {
    return { names: ["upload"], read: (name) => readSingle(bytes, name) };
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const members = listMembers(buf).filter((m) => !m.name.endsWith("/"));
  const byName = new Map(members.map((m) => [m.name, m]));
  return {
    names: members.map((m) => m.name),
    read(name) {
      const m = byName.get(name);
      if (!m) throw new LoaderDataError("ZIP_ENTRY_MISSING", `no member '${name}'`);
      return inflateMember(buf, m);
    },
  };
}

function readSingle(bytes: Uint8Array, name: string): Uint8Array {
  if (name !== "upload") throw new LoaderDataError("ZIP_ENTRY_MISSING", `no member '${name}'`);
  return bytes;
}

/** First bundle entry whose name matches (case-insensitive on the whole path), or null. */
export function findEntry(bundle: SourceBundle, pattern: RegExp): string | null {
  return bundle.names.find((n) => pattern.test(n)) ?? null;
}

/** Like {@link findEntry} but a missing REQUIRED file is a data error naming what was expected. */
export function requireEntry(bundle: SourceBundle, pattern: RegExp, what: string): string {
  const found = findEntry(bundle, pattern);
  if (found !== null) return found;
  // A raw (non-zip) upload is a single file: let it stand in for the required entry.
  if (bundle.names.length === 1 && bundle.names[0] === "upload") return "upload";
  throw new LoaderDataError("SOURCE_FILE_MISSING", `expected ${what} in the source`);
}
