import { describe, expect, it } from "vitest";
import { hasImageMetadata } from "./attachment-metadata";

const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const segment = (code: number, payload: number[]) => [
  0xff,
  code,
  (payload.length + 2) >> 8,
  (payload.length + 2) & 0xff,
  ...payload,
];
const jpeg = (...segments: number[][]) =>
  new Uint8Array([0xff, 0xd8, ...segments.flat(), ...segment(0xda, [0, 0]), 1, 2, 3, 0xff, 0xd9]);
const JFIF = segment(0xe0, enc("JFIF\0\x01\x01\0"));
const gpsExif = segment(0xe1, [...enc("Exif\0\0"), ...enc("MM\0*GPS-LAT-LONG")]);
const xmp = segment(0xe1, enc("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>"));
const iptc = segment(0xed, enc("Photoshop 3.0\0"));

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
const png = (...chunks: number[][]) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk("IHDR", new Array(13).fill(0)),
    ...chunks.flat(),
    ...chunk("IDAT", [1, 2, 3]),
    ...chunk("IEND", []),
  ]);

describe("hasImageMetadata", () => {
  it("flags a JPEG with GPS EXIF (APP1 Exif)", () => {
    expect(hasImageMetadata(jpeg(JFIF, gpsExif), "image/jpeg")).toBe(true);
  });
  it("flags a JPEG with XMP", () => {
    expect(hasImageMetadata(jpeg(JFIF, xmp), "image/jpeg")).toBe(true);
  });
  it("flags a JPEG with APP13 IPTC", () => {
    expect(hasImageMetadata(jpeg(iptc), "image/jpeg")).toBe(true);
  });
  it("passes a clean JPEG", () => {
    expect(hasImageMetadata(jpeg(JFIF, segment(0xdb, new Array(65).fill(1))), "image/jpeg")).toBe(
      false,
    );
  });
  it("does not look past SOS", () => {
    const bytes = new Uint8Array([...jpeg(JFIF), ...gpsExif]);
    expect(hasImageMetadata(bytes, "image/jpeg")).toBe(false);
  });
  it.each(["eXIf", "tEXt", "iTXt", "zTXt"])("flags a PNG with %s", (type) => {
    expect(hasImageMetadata(png(chunk(type, [1, 2, 3])), "image/png")).toBe(true);
  });
  it("passes a clean PNG, including tIME", () => {
    expect(hasImageMetadata(png(), "image/png")).toBe(false);
    expect(hasImageMetadata(png(chunk("tIME", new Array(7).fill(0))), "image/png")).toBe(false);
  });
  it("is safe on truncated input at every length", () => {
    for (const [full, mime] of [
      [jpeg(JFIF, gpsExif), "image/jpeg"],
      [png(chunk("tEXt", [1])), "image/png"],
    ] as const) {
      for (let n = 0; n < full.length; n += 1) {
        expect(() => hasImageMetadata(full.slice(0, n), mime)).not.toThrow();
      }
    }
    expect(hasImageMetadata(jpeg(JFIF, gpsExif).slice(0, 12), "image/jpeg")).toBe(false);
  });
  it("is safe on garbage, huge declared lengths and empty input", () => {
    const junk = new Uint8Array(512).map((_, i) => (i * 131 + 7) & 0xff);
    expect(hasImageMetadata(junk, "image/jpeg")).toBe(false);
    expect(hasImageMetadata(junk, "image/png")).toBe(false);
    expect(hasImageMetadata(new Uint8Array(0), "image/jpeg")).toBe(false);
    const hugePng = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0xff,
      0xff,
      0xff,
      0xff,
      ...enc("junk"),
    ]);
    expect(hasImageMetadata(hugePng, "image/png")).toBe(false);
  });
  it("bounds work on a file of endless empty segments", () => {
    const many = new Uint8Array([
      0xff,
      0xd8,
      ...new Array(200000).fill(0).flatMap(() => [0xff, 0xfe, 0, 2]),
    ]);
    expect(hasImageMetadata(many, "image/jpeg")).toBe(false);
  });
  it("skips TIFF and other types", () => {
    expect(
      hasImageMetadata(new Uint8Array([0x49, 0x49, 0x2a, 0, ...enc("Exif")]), "image/tiff"),
    ).toBe(false);
    expect(hasImageMetadata(jpeg(gpsExif), "application/pdf")).toBe(false);
  });
});
