// apps/backend/__tests__/f236-docling-grounding.test.ts — F-236 (ADR-0048), no DB.
//
// The fixture is REAL output of the `docling-worker` image (Docling 2.133, EasyOCR, CPU) on an
// image-only two-page synthetic referral fax — so the grounding cases below run against genuine OCR noise
// ("Home   phone:", "mae . doclens@example org", "0 .5 mg"), not idealised text.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { groundQuote } from "@wardenx/intake-extraction";
import { describe, expect, it } from "vitest";
import {
  DoclingParseError,
  createHttpDoclingClient,
  createUnboundDoclingClient,
  doclingConfigFromEnv,
  parseDoclingResponse,
} from "../src/modules/22-documents/extraction/docling-client";

const RAW = JSON.parse(
  readFileSync(join(__dirname, "fixtures/docling-referral-parse.json"), "utf8"),
) as unknown;
const parsed = parseDoclingResponse(RAW);

describe("F-236 — docling-worker response validation", () => {
  it("accepts the real worker output", () => {
    expect(parsed.doclingVersion).toBe("2.133.0");
    expect(parsed.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(parsed.pages[0]?.blocks.length).toBeGreaterThan(10);
  });

  it("refuses malformed payloads rather than parsing them best-effort", () => {
    const bad = [
      {},
      {
        pages: [
          { page: 2, width: 1, height: 1, blocks: [] },
          { page: 1, width: 1, height: 1, blocks: [] },
        ],
      },
      { pages: [{ page: 1, width: 0, height: 1, blocks: [] }] },
      { pages: [{ page: 1, width: 1, height: 1, blocks: [{ text: "x", bbox: [1, 2, 3] }] }] },
      { pages: [{ page: 1, width: 1, height: 1, blocks: [{ text: "x", bbox: [5, 5, 1, 1] }] }] },
      { pages: [{ page: 1, width: 1, height: 1, blocks: [{ text: "", bbox: [1, 1, 2, 2] }] }] },
    ];
    for (const b of bad) {
      expect(() => parseDoclingResponse(b)).toThrow(DoclingParseError);
    }
  });

  it("is unbound (typed 503) without a URL and a worker-specific token — never INTERNAL_SERVICE_TOKEN", async () => {
    expect(doclingConfigFromEnv({ DOCLING_WORKER_URL: "http://d:8000" })).toBeNull();
    expect(
      doclingConfigFromEnv({
        DOCLING_WORKER_URL: "http://d:8000",
        INTERNAL_SERVICE_TOKEN: "x".repeat(40),
      }),
    ).toBeNull();
    expect(
      doclingConfigFromEnv({ DOCLING_WORKER_URL: "http://d:8000/", DOCLING_WORKER_TOKEN: "tok" }),
    ).toEqual({ baseUrl: "http://d:8000", token: "tok" });
    await expect(
      createUnboundDoclingClient().parse({
        organizationId: "o",
        jobId: "j",
        sourceUrl: "u",
        correlationId: "c",
      }),
    ).rejects.toMatchObject({ kind: "unavailable", statusCode: 503 });
  });

  it("maps worker statuses to typed errors and sends the bearer + presigned URL", async () => {
    const seen: Array<{ url: string; auth: string | null; body: string }> = [];
    const fake = (status: number, body: unknown = {}) =>
      (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({
          url: String(url),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        });
        return new Response(JSON.stringify(body), { status });
      }) as typeof fetch;
    const cfg = { baseUrl: "http://d:8000", token: "tok" };
    const input = {
      organizationId: "o",
      jobId: "j1",
      sourceUrl: "https://minio/x?sig",
      correlationId: "c",
    };
    await expect(createHttpDoclingClient(cfg, fake(200, RAW)).parse(input)).resolves.toMatchObject({
      doclingVersion: "2.133.0",
    });
    expect(seen[0]).toEqual({
      url: "http://d:8000/parse",
      auth: "Bearer tok",
      body: JSON.stringify({ job_id: "j1", source_url: "https://minio/x?sig" }),
    });
    await expect(createHttpDoclingClient(cfg, fake(422)).parse(input)).rejects.toMatchObject({
      kind: "parse_failed",
    });
    await expect(createHttpDoclingClient(cfg, fake(415)).parse(input)).rejects.toMatchObject({
      kind: "rejected",
    });
    await expect(createHttpDoclingClient(cfg, fake(500)).parse(input)).rejects.toMatchObject({
      kind: "unavailable",
    });
  });
});

describe("F-236 — quote grounding against real Docling text", () => {
  const pages = parsed.pages;

  it("grounds a verbatim quote to Docling's block box", () => {
    const r = groundQuote(pages, { page: 1, quote: "(503) 555-0142", value: "(503) 555-0142" });
    expect(r).toMatchObject({ grounded: true, page: 1, onClaimedPage: true });
    if (r.grounded) expect(r.bbox).toEqual([130.67, 184.33, 232, 197.33]);
  });

  it("tolerates OCR spacing in both quote and value (the email came back 'mae . doclens@example org')", () => {
    const r = groundQuote(pages, {
      page: 1,
      quote: "mae . doclens@example org",
      value: "mae.doclens@example.org",
    });
    expect(r.grounded).toBe(true);
  });

  it("spans consecutive blocks (label and value OCR'd as separate blocks)", () => {
    const r = groundQuote(pages, {
      page: 1,
      quote: "Address: 48 Willow Ln",
      value: "48 Willow Ln",
    });
    expect(r).toMatchObject({ grounded: true, page: 1 });
    if (r.grounded) expect(r.bbox).toEqual([41.33, 141, 195.67, 153.33]); // union of the two blocks
  });

  it("follows visual reading order when Docling emits labels before values (real fixture: mobile, email)", () => {
    // Docling's order on page 1 is "Mobile phone:", "Email:", "503-555-0188", "mae . doclens@example org".
    const mobile = groundQuote(pages, {
      page: 1,
      quote: "Mobile phone:\n503-555-0188",
      value: "503-555-0188",
    });
    expect(mobile).toMatchObject({ grounded: true, page: 1 });
    if (mobile.grounded) expect(mobile.bbox).toEqual([41, 204.33, 232, 220.67]);
    const email = groundQuote(pages, {
      page: 1,
      quote: "Email:\nmae . doclens@example org",
      value: "mae.doclens@example.org",
    });
    expect(email).toMatchObject({ grounded: true, page: 1 });
    if (email.grounded) expect(email.bbox).toEqual([42, 226, 260.33, 242]);
  });

  it("uses the TRUE page when the model names the wrong one", () => {
    const r = groundQuote(pages, {
      page: 1,
      quote: "Furosemide 40 mg PO daily",
      value: "Furosemide",
    });
    expect(r).toMatchObject({ grounded: true, page: 2, onClaimedPage: false });
  });

  it("drops a paraphrased or invented quote", () => {
    expect(
      groundQuote(pages, { page: 1, quote: "Phone (home): 503.555.0142", value: "503.555.0142" }),
    ).toEqual({ grounded: false, reason: "quote_not_found" });
    expect(
      groundQuote(pages, { page: 1, quote: "Cell: 503-555-0199", value: "503-555-0199" }),
    ).toEqual({ grounded: false, reason: "quote_not_found" });
  });

  it("drops a real quote whose value is not in it (the model 'normalised' the number)", () => {
    expect(
      groundQuote(pages, { page: 1, quote: "(503) 555-0142", value: "(503) 555-0143" }),
    ).toEqual({ grounded: false, reason: "value_not_in_quote" });
  });

  it("refuses a quote too short to locate", () => {
    expect(groundQuote(pages, { page: 1, quote: "F", value: "F" })).toEqual({
      grounded: false,
      reason: "quote_too_short",
    });
  });
});
