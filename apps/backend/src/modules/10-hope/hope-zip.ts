import { createHash } from "node:crypto";

export interface ZipEntryInput {
  readonly filename: string;
  readonly content: Buffer;
}

export interface BuiltZip {
  readonly bytes: Buffer;
  readonly sha256: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function assertSafeFilename(filename: string): void {
  if (
    filename.length === 0 ||
    filename.startsWith("/") ||
    filename.includes("\\") ||
    filename.includes("..") ||
    filename.includes("/")
  ) {
    throw new Error(`Unsafe ZIP entry filename: ${filename}`);
  }
}

function dosDateTime(): { date: number; time: number } {
  // Fixed timestamp for deterministic package bytes.
  return { date: ((2025 - 1980) << 9) | (1 << 5) | 1, time: 0 };
}

export function buildDeterministicZip(entries: readonly ZipEntryInput[]): BuiltZip {
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const { date, time } = dosDateTime();

  for (const entry of [...entries].sort((a, b) => a.filename.localeCompare(b.filename))) {
    assertSafeFilename(entry.filename);
    if (seen.has(entry.filename))
      throw new Error(`Duplicate ZIP entry filename: ${entry.filename}`);
    seen.add(entry.filename);
    const name = Buffer.from(entry.filename, "utf8");
    const crc = crc32(entry.content);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.content.length, 18);
    local.writeUInt32LE(entry.content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.content.length, 20);
    central.writeUInt32LE(entry.content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + entry.content.length;
  }

  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  const bytes = Buffer.concat([...locals, centralBytes, end]);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
