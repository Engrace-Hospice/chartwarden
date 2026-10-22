// e2e/specs/messaging-camera-strip.spec.ts — M36 WP 5.3: a photo's location/device metadata never leaves the browser.
//
// The jsdom suite proves the policy around the re-encode (image-metadata-strip.dom.test.tsx) but jsdom has no decoder or
// canvas, so it cannot prove the REAL strip. This does, in a real browser: it builds a decodable JPEG that carries a GPS
// Exif APP1, an XMP APP1 and an IPTC APP13 segment, feeds it through the composer's file input (the same pipeline the
// camera shot uses), intercepts the bytes of the upload PUT and walks its JPEG segments. None of the three may be there.
//
// Needs the full local stack with seeded demo data (see playwright.config.ts). NOT part of the default `bun run test`.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { RN_ACCOUNT } from "../fixtures/credentials";
import { signInAs } from "../fixtures/helpers";

declare global {
  interface Window {
    __uploadedPutBody?: string;
  }
}

const SOI = 0xd8;
const SOS = 0xda;
const APP1 = 0xe1;
const APP13 = 0xed;
const EXIF_HEADER = Buffer.from("Exif\0\0", "latin1");
const XMP_NAMESPACE = Buffer.from("http://ns.adobe.com/xap/1.0/", "latin1");

/** In the page: a real, decodable JPEG with GPS Exif (APP1), XMP (APP1) and IPTC (APP13) spliced in after SOI. */
async function buildTaggedJpegBase64(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d context");
    context.fillStyle = "#3366cc";
    context.fillRect(0, 0, 64, 48);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.9),
    );
    if (!blob) throw new Error("the browser cannot encode JPEG");
    const original = new Uint8Array(await blob.arrayBuffer());

    const ascii = (text: string) => Array.from(text, (c) => c.charCodeAt(0));
    const segment = (marker: number, body: number[]) => {
      const length = body.length + 2;
      return [0xff, marker, length >> 8, length & 0xff, ...body];
    };
    // Little-endian TIFF with one IFD0 entry pointing at a GPS IFD (tag 0x8825): enough for any Exif reader to see GPS.
    const tiff = [
      ...ascii("II"),
      42,
      0,
      8,
      0,
      0,
      0,
      1,
      0,
      0x25,
      0x88,
      4,
      0,
      1,
      0,
      0,
      0,
      26,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      2,
      0,
      2,
      0,
      0,
      0,
      ...ascii("N\0"),
      0,
      0,
      0,
      0,
      0,
      0,
    ];
    const exif = segment(0xe1, [...ascii("Exif"), 0, 0, ...tiff]);
    const xmp = segment(0xe1, [
      ...ascii("http://ns.adobe.com/xap/1.0/"),
      0,
      ...ascii("<x:xmpmeta><gps:lat>40.7</gps:lat></x:xmpmeta>"),
    ]);
    const iptc = segment(0xed, [
      ...ascii("Photoshop 3.0"),
      0,
      ...ascii("8BIM"),
      4,
      4,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    const out = new Uint8Array(original.length + exif.length + xmp.length + iptc.length);
    out.set(original.subarray(0, 2), 0); // SOI
    let offset = 2;
    for (const part of [exif, xmp, iptc]) {
      out.set(part, offset);
      offset += part.length;
    }
    out.set(original.subarray(2), offset);
    let binary = "";
    for (const byte of out) binary += String.fromCharCode(byte);
    return btoa(binary);
  });
}

interface JpegSegment {
  readonly marker: number;
  readonly body: Buffer;
}

/** The JPEG's segments from SOI up to (not including) the entropy-coded scan, so scan bytes can never false-match. */
function headerSegments(jpeg: Buffer): JpegSegment[] {
  expect(jpeg[0]).toBe(0xff);
  expect(jpeg[1]).toBe(SOI);
  const segments: JpegSegment[] = [];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    expect(jpeg[offset], `a marker at byte ${offset}`).toBe(0xff);
    const marker = jpeg[offset + 1] ?? 0;
    if (marker === SOS) break;
    const length = jpeg.readUInt16BE(offset + 2);
    segments.push({ marker, body: jpeg.subarray(offset + 4, offset + 2 + length) });
    offset += 2 + length;
  }
  return segments;
}

async function openFirstConversation(page: Page): Promise<void> {
  await page.goto("/messaging");
  await expect(page.locator(".wx-messaging-page")).toBeVisible({ timeout: 15_000 });
  const row = page.locator(".wx-messaging-conversation-list li button").first();
  await expect(row, "the demo seed must provide at least one conversation").toBeVisible();
  await row.click();
  await expect(page.locator(".wx-messaging-thread")).toBeVisible();
}

test.describe("Messaging — photo metadata strip (WP 5.3)", () => {
  test("the uploaded JPEG carries no Exif, XMP or IPTC even though the source had all three", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    // Playwright's request.postDataBuffer() is null for a Blob-bodied fetch in Chromium, so the bytes are captured in the page
    // instead: wrap fetch BEFORE any navigation, read the PUT's body, then still call the real fetch.
    await page.addInitScript(() => {
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (init?.method === "PUT" && init.body instanceof Blob) {
          const bytes = new Uint8Array(await init.body.arrayBuffer());
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          window.__uploadedPutBody = btoa(binary);
        }
        return realFetch(input, init);
      };
    });
    await signInAs(page, RN_ACCOUNT());
    await openFirstConversation(page);

    const source = Buffer.from(await buildTaggedJpegBase64(page), "base64");
    // Not vacuous: the file we feed in really has what must be gone.
    const sourceSegments = headerSegments(source);
    expect(sourceSegments.some((s) => s.body.subarray(0, 6).equals(EXIF_HEADER))).toBe(true);
    expect(sourceSegments.some((s) => s.body.subarray(0, 28).equals(XMP_NAMESPACE))).toBe(true);
    expect(sourceSegments.some((s) => s.marker === APP13)).toBe(true);

    await page
      .getByTestId("attachment-input")
      .setInputFiles({ name: "wound.jpg", mimeType: "image/jpeg", buffer: source });

    // Smaller than the test timeout, so a missing upload fails here with a clear message rather than as a timeout.
    await expect
      .poll(() => page.evaluate(() => window.__uploadedPutBody ?? null), {
        timeout: 45_000,
        message: "the composer should PUT the stripped bytes",
      })
      .not.toBeNull();
    const base64 = await page.evaluate(() => window.__uploadedPutBody as string);
    const bytes = Buffer.from(base64, "base64");
    expect(bytes.length).toBeGreaterThan(0);

    const segments = headerSegments(bytes);
    expect(
      segments.some((s) => s.marker === APP13),
      "no IPTC/Photoshop APP13 segment",
    ).toBe(false);
    expect(
      segments.some((s) => s.marker === APP1 && s.body.subarray(0, 6).equals(EXIF_HEADER)),
      "no Exif APP1 segment",
    ).toBe(false);
    expect(
      segments.some((s) => s.marker === APP1 && s.body.subarray(0, 28).equals(XMP_NAMESPACE)),
      "no XMP APP1 segment",
    ).toBe(false);
    // Belt and braces over the whole body, not just the parsed header.
    expect(bytes.includes(EXIF_HEADER)).toBe(false);
    expect(bytes.includes(Buffer.from("ns.adobe.com/xap", "latin1"))).toBe(false);
  });
});
