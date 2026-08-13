// apps/backend/src/modules/34-saas-tenant-platform/tenant-export-tar.ts — GAP-094.
//
// A minimal, dependency-free POSIX ustar archive writer. There is no tar library anywhere in this repo
// (GAP-048's precedent note on DsarExportWorkerPorts.sealBundle), and the DSAR fix's answer — one gzip'd
// logical document, no container format — doesn't apply here: the tenant-export bundle's OWN object-key
// convention (`tenantExportObjectKey`, §3.7) already commits to `.tar.gz`, and its whole point (§7.6) is a
// per-table NDJSON file PER MODULE plus `manifest.json` at the archive root, extractable by a customer's
// migration tooling on the other end of a BAA-termination request. Faking that with a renamed JSON blob
// would silently break every real extraction. Ustar is a small, fully-specified, stable format (POSIX.1-1988
// §10.1) — this hand-writes it rather than adding a dependency for ~80 lines of header-packing.
//
// Pure byte-packing, no I/O — {@link buildUstarTarball} takes fully-buffered entries and returns the
// archive bytes; the caller (tenant-export-bundle-sink.ts) gzips + uploads them.

const BLOCK_SIZE = 512;

/** One regular file to place in the archive. */
export interface TarEntry {
  readonly path: string;
  readonly content: Buffer;
}

/** Write a NUL-terminated, zero-left-padded octal ASCII field (the ustar numeric-field convention). */
function writeOctalField(header: Buffer, offset: number, length: number, value: number): void {
  const digits = value.toString(8).padStart(length - 1, "0");
  header.write(digits, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

/** Build one 512-byte ustar header block for `entry` (POSIX.1-1988 §10.1 layout). */
function buildHeader(entry: TarEntry, mtimeSeconds: number): Buffer {
  const nameBytes = Buffer.from(entry.path, "utf8");
  if (nameBytes.byteLength > 100) {
    throw new Error(`tenant-export tar entry path exceeds the ustar 100-byte name limit: ${entry.path}`);
  }
  const header = Buffer.alloc(BLOCK_SIZE);
  nameBytes.copy(header, 0);
  writeOctalField(header, 100, 8, 0o644); // mode
  writeOctalField(header, 108, 8, 0); // uid
  writeOctalField(header, 116, 8, 0); // gid
  writeOctalField(header, 124, 12, entry.content.byteLength); // size
  writeOctalField(header, 136, 12, mtimeSeconds); // mtime
  header.fill(0x20, 148, 156); // checksum field: 8 ASCII spaces while computing
  header[156] = 0x30; // typeflag '0' — regular file
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0; // magic is NUL-terminated "ustar\0"
  header.write("00", 263, 2, "ascii"); // ustar version, not NUL-terminated

  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0; // checksum field terminator: NUL then space (POSIX.1-1988 §10.1)
  header[155] = 0x20;

  return header;
}

/**
 * Assemble a real, extractable ustar tar archive from `entries` (deterministic given a fixed `mtimeSeconds`
 * — the manifest's own `sha256OfArchive` is computed over the gzip of this output, so determinism here
 * matters for the §7.7 idempotent-replay guarantee). Each entry's content is padded to a 512-byte boundary;
 * the archive ends with the required two all-zero end-of-archive blocks.
 */
export function buildUstarTarball(entries: readonly TarEntry[], mtimeSeconds: number): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    blocks.push(buildHeader(entry, mtimeSeconds));
    blocks.push(entry.content);
    const remainder = entry.content.byteLength % BLOCK_SIZE;
    if (remainder !== 0) blocks.push(Buffer.alloc(BLOCK_SIZE - remainder));
  }
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2)); // end-of-archive marker
  return Buffer.concat(blocks);
}
