import { describe, expect, it } from "vitest";
import { inspectImageMetadata } from "./attachment-metadata";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const segment = (code: number, payload: number[]) => [
  0xff,
  code,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
const SOS = segment(0xda, [0, 0]);
const ENTROPY = [1, 2, 0xff, 0x00, 3, 0xff, 0xd0, 4];
const EOI = [0xff, 0xd9];
const jpegOf = (...parts: number[][]) => new Uint8Array([0xff, 0xd8, ...parts.flat()]);
const jpeg = (...segments: number[][]) => jpegOf(...segments, SOS, ENTROPY, EOI);
const JFIF = segment(0xe0, enc("JFIF\0\x01\x01\0"));
const ICC = segment(0xe2, [...enc("ICC_PROFILE\0"), 1, 1, 9, 9]);
const MPF = segment(0xe2, enc("MPF\0\x01\x02"));
const DQT = segment(0xdb, new Array(65).fill(1));
const DHT = segment(0xc4, new Array(20).fill(1));
const SOF = segment(0xc0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]);
const CLEAN_PARTS = [JFIF, ICC, DQT, DHT, SOF];
const gpsExif = segment(0xe1, [...enc("Exif\0\0"), ...enc("MM\0*GPS-LAT-LONG")]);
const xmp = segment(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"));
const iptc = segment(0xed, enc("Photoshop 3.0\0"));
const com = segment(0xfe, enc("hello"));

const chunk = (type: string, data: number[]) => [
  (data.length >>> 24) & 0xff,
  (data.length >>> 16) & 0xff,
  (data.length >>> 8) & 0xff,
  data.length & 0xff,
  ...enc(type),
  ...data,
  0,
  0,
  0,
  0,
];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngOf = (...chunks: number[][]) => new Uint8Array([...PNG_SIG, ...chunks.flat()]);
const IHDR = chunk("IHDR", new Array(13).fill(0));
const IDAT = chunk("IDAT", [1, 2, 3]);
const IEND = chunk("IEND", []);
const png = (...before: number[][]) => pngOf(IHDR, ...before, IDAT, IEND);

/** Little-endian TIFF with one IFD holding the given tags. */
const tiff = (tags: number[], opts: { bigEndian?: boolean } = {}) => {
  const be = opts.bigEndian === true;
  const u16 = (v: number) => (be ? [v >> 8, v & 0xff] : [v & 0xff, v >> 8]);
  const u32 = (v: number) =>
    be
      ? [v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
      : [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
  const entries = tags.flatMap((t) => [...u16(t), ...u16(4), ...u32(1), ...u32(0)]);
  return new Uint8Array([
    ...(be ? [0x4d, 0x4d, 0, 0x2a] : [0x49, 0x49, 0x2a, 0]),
    ...u32(8),
    ...u16(tags.length),
    ...entries,
    ...u32(0),
  ]);
};

describe("inspectImageMetadata: JPEG", () => {
  it("passes a clean JPEG with JFIF + ICC + DQT/DHT/SOF", () => {
    expect(inspectImageMetadata(jpeg(...CLEAN_PARTS))).toBe("clean");
  });
  it("allows NUL padding after EOI", () => {
    expect(inspectImageMetadata(new Uint8Array([...jpeg(...CLEAN_PARTS), 0, 0, 0]))).toBe("clean");
  });
  it.each([
    ["APP1 Exif", gpsExif],
    ["APP1 XMP", xmp],
    ["APP13 IPTC", iptc],
    ["COM", com],
    ["APP2 MPF", MPF],
    ["JFXX thumbnail", segment(0xe0, enc("JFXX\0\x10"))],
    ["APP3", segment(0xe3, [1, 2])],
  ])("flags %s before the scan", (_n, seg) => {
    expect(inspectImageMetadata(jpeg(JFIF, seg))).toBe("metadata");
  });
  it("flags Exif placed after SOS (between scans)", () => {
    expect(
      inspectImageMetadata(jpegOf(...CLEAN_PARTS, SOS, ENTROPY, gpsExif, SOS, ENTROPY, EOI)),
    ).toBe("metadata");
  });
  it("flags Exif after EOI", () => {
    expect(inspectImageMetadata(new Uint8Array([...jpeg(...CLEAN_PARTS), ...gpsExif]))).toBe(
      "metadata",
    );
  });
  it("flags any non-padding trailing byte after EOI", () => {
    expect(inspectImageMetadata(new Uint8Array([...jpeg(...CLEAN_PARTS), 0, 7]))).toBe("metadata");
  });
  it("sees Exif behind 5000 empty APP segments", () => {
    const filler = new Array(5000).fill(0).flatMap(() => segment(0xe0, enc("JFIF\0")));
    expect(inspectImageMetadata(jpegOf(filler, gpsExif, SOS, ENTROPY, EOI))).toBe("metadata");
  });
  it("sees an APP1 after a junk byte (libjpeg skips to the next FF xx)", () => {
    expect(inspectImageMetadata(jpegOf(JFIF, [0x00, 0x42], gpsExif, SOS, ENTROPY, EOI))).toBe(
      "metadata",
    );
  });
  it("tolerates junk and fill bytes between clean segments", () => {
    expect(
      inspectImageMetadata(jpegOf(JFIF, [0x00, 0xff, 0xff], DQT, SOF, SOS, ENTROPY, EOI)),
    ).toBe("clean");
  });
  it("is unparseable without a scan, without EOI, or with a bad length", () => {
    expect(inspectImageMetadata(jpegOf(JFIF, EOI))).toBe("unparseable");
    expect(inspectImageMetadata(jpegOf(JFIF, SOS, ENTROPY))).toBe("unparseable");
    expect(inspectImageMetadata(jpegOf([0xff, 0xdb, 0xff, 0xff, 1, 2]))).toBe("unparseable");
  });
  it("stays bounded and fail-closed on endless empty segments", () => {
    const many = new Uint8Array([
      0xff,
      0xd8,
      0xff,
      0xdb,
      ...new Array(200000).fill(0).flatMap(() => [0xff, 0xdb, 0, 2]),
    ]);
    expect(inspectImageMetadata(many)).toBe("unparseable");
  });
});

describe("inspectImageMetadata: PNG", () => {
  it("passes a clean PNG with sRGB/pHYs/tIME/gAMA", () => {
    const v = png(
      chunk("sRGB", [0]),
      chunk("pHYs", new Array(9).fill(0)),
      chunk("tIME", new Array(7).fill(0)),
      chunk("gAMA", [0, 0, 0, 1]),
    );
    expect(inspectImageMetadata(v)).toBe("clean");
  });
  it.each(["eXIf", "tEXt", "iTXt", "zTXt"])("flags %s before IDAT", (type) => {
    expect(inspectImageMetadata(png(chunk(type, [1, 2, 3])))).toBe("metadata");
  });
  it.each(["eXIf", "tEXt"])("flags %s after IDAT", (type) => {
    expect(inspectImageMetadata(pngOf(IHDR, IDAT, chunk(type, [1]), IEND))).toBe("metadata");
  });
  it("flags an unknown private ancillary chunk", () => {
    expect(inspectImageMetadata(png(chunk("prVt", [1])))).toBe("metadata");
  });
  it("flags trailing bytes after IEND, allows zero padding", () => {
    expect(inspectImageMetadata(new Uint8Array([...png(), 1]))).toBe("metadata");
    expect(inspectImageMetadata(new Uint8Array([...png(), 0, 0]))).toBe("clean");
  });
  it("is unparseable without IEND or with a huge declared length", () => {
    expect(inspectImageMetadata(pngOf(IHDR, IDAT))).toBe("unparseable");
    expect(
      inspectImageMetadata(new Uint8Array([...PNG_SIG, 0xff, 0xff, 0xff, 0xff, ...enc("junk")])),
    ).toBe("unparseable");
  });
});

describe("inspectImageMetadata: sniffing and TIFF", () => {
  it("applies JPEG rules to a JPEG regardless of the declared type", () => {
    // The function takes bytes only: the declared mime (image/tiff, image/png) cannot change the verdict.
    expect(inspectImageMetadata(jpeg(JFIF, gpsExif))).toBe("metadata");
  });
  it("applies PNG rules to a PNG regardless of the declared type", () => {
    expect(inspectImageMetadata(png(chunk("tEXt", [1])))).toBe("metadata");
  });
  it.each([false, true])("flags TIFF with GPS / Exif / XMP tags (bigEndian=%s)", (bigEndian) => {
    for (const tag of [0x8825, 0x8769, 0x02bc]) {
      expect(inspectImageMetadata(tiff([0x0100, tag], { bigEndian }))).toBe("metadata");
    }
  });
  it("passes a TIFF without metadata tags", () => {
    expect(inspectImageMetadata(tiff([0x0100, 0x0101]))).toBe("clean");
    expect(inspectImageMetadata(tiff([0x0100, 0x0101], { bigEndian: true }))).toBe("clean");
  });
  it("fails closed on truncated, cyclic and BigTIFF input", () => {
    expect(inspectImageMetadata(tiff([0x0100, 0x0101]).slice(0, 14))).toBe("unparseable");
    const cyc = tiff([0x0100]);
    cyc.set([8, 0, 0, 0], cyc.length - 4); // next-IFD points back at itself
    expect(inspectImageMetadata(cyc)).toBe("unparseable");
    expect(inspectImageMetadata(new Uint8Array([0x49, 0x49, 0x2b, 0, 8, 0, 0, 0]))).toBe(
      "unparseable",
    );
  });
  it("treats non-image bytes as clean", () => {
    expect(inspectImageMetadata(new Uint8Array(enc("%PDF-1.7 hello")))).toBe("clean");
    expect(inspectImageMetadata(new Uint8Array(0))).toBe("clean");
  });
});

describe("inspectImageMetadata: robustness", () => {
  it("never throws and never says clean for a metadata file truncated at any length", () => {
    const files = [
      jpeg(JFIF, gpsExif),
      png(chunk("tEXt", [1])),
      tiff([0x8825]),
      jpeg(...CLEAN_PARTS),
      png(),
      tiff([0x0100]),
    ];
    for (const full of files) {
      for (let n = 0; n < full.length; n += 1) {
        expect(() => inspectImageMetadata(full.slice(0, n))).not.toThrow();
      }
    }
    for (const full of [jpeg(JFIF, gpsExif), png(chunk("tEXt", [1])), tiff([0x8825])]) {
      for (let n = 8; n < full.length; n += 1) {
        const v = inspectImageMetadata(full.slice(0, n));
        // A prefix that already contains the flagged part is "metadata"; otherwise fail closed.
        expect(v).not.toBe("clean");
      }
    }
  });
  it("never throws on random garbage with image magic", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed & 0xff;
    };
    for (const magic of [
      [0xff, 0xd8, 0xff],
      PNG_SIG,
      [0x49, 0x49, 0x2a, 0],
      [0x4d, 0x4d, 0, 0x2a],
      [],
    ]) {
      for (let i = 0; i < 200; i += 1) {
        const bytes = new Uint8Array([...magic, ...new Array(300).fill(0).map(rnd)]);
        expect(() => inspectImageMetadata(bytes)).not.toThrow();
      }
    }
  });
});
