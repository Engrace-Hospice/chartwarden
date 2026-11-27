// Claim.MD webhook capture + replay report (CW-TX-02). Synthetic captures and a synthetic key only; no network.
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { CLAIMMD_SIGNATURE_HEADER, classifyClaimMdSignature } from "./claimmd-webhook";
import {
  CLAIMMD_CAPTURE_FORMAT,
  type ClaimMdCapture,
  buildClaimMdCapture,
  parseClaimMdCapture,
} from "./claimmd-webhook-capture";
import {
  CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED,
  analyzeClaimMdCapture,
  renderClaimMdReplayReport,
} from "./claimmd-webhook-replay";

const KEY = "SYNTH99999_k#ey*not-real";
const DIR = join(__dirname, "__fixtures__", "claimmd-webhook");
const NOW = new Date("2026-11-05T12:05:00Z");
const URL_TEST = "/api/v1/webhooks/claimmd/test";
const BODY = JSON.stringify({
  UTCTime: "2026-11-05 12:00:00",
  acct_number: "99999",
  events: [{ eventid: "1", event_type: "test", event_time: "2026-11-05 12:00:00", event_data: {} }],
});

const mac = (body: string | Buffer, key: string | Buffer = Buffer.from(KEY, "latin1")) =>
  createHmac("sha256", key).update(body).digest();

function fixture(name: string): { capture: ClaimMdCapture; rawBody: Buffer } {
  const parsed = parseClaimMdCapture(
    JSON.parse(readFileSync(join(DIR, `${name}.capture.json`), "utf8")),
  );
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed;
}

/** A capture of `body` whose signature header is `header` (default: the documented scheme over those bytes). */
function craft(body: string | Buffer, header?: string, extra: Record<string, string> = {}) {
  const rawBody = Buffer.from(body);
  const capture = buildClaimMdCapture({
    method: "POST",
    url: URL_TEST,
    headers: { [CLAIMMD_SIGNATURE_HEADER]: header ?? mac(rawBody).toString("base64"), ...extra },
    rawBody,
  });
  return { capture, rawBody };
}

const analyze = (
  input: { capture: ClaimMdCapture; rawBody: Buffer },
  accountKey: string | null = KEY,
  now = NOW,
) => analyzeClaimMdCapture({ ...input, accountKey, now });

describe("the committed synthetic captures", () => {
  const names = readdirSync(DIR)
    .filter((f) => f.endsWith(".capture.json"))
    .map((f) => f.replace(".capture.json", ""));

  it("covers the four documented shapes", () => {
    expect([...names].sort()).toEqual([
      "appeal-event",
      "enroll-event",
      "mixed-batch",
      "test-event",
    ]);
  });

  it.each(names)("%s verifies under the synthetic key and is internally consistent", (name) => {
    const { capture, rawBody } = fixture(name);
    expect(classifyClaimMdSignature(KEY, rawBody, capture.headers[CLAIMMD_SIGNATURE_HEADER])).toBe(
      "ok",
    );
    expect(capture.headers["content-length"]).toBe(String(rawBody.length));
    expect(analyze({ capture, rawBody }).signature).toMatchObject({
      verdict: "ok",
      alternatives: [],
    });
  });

  it("a delivery that fits the documented shape has no findings, however long after it was taken it is replayed", () => {
    for (const name of ["test-event", "enroll-event", "appeal-event"]) {
      // `now` is today: the age of UTCTime is judged against the capture's own receivedAt, not the replay's clock
      expect(analyze(fixture(name), KEY, new Date()).findings, name).toEqual([]);
    }
  });

  it("settles a test event on receipt and leaves enroll and appeal for the sweep", () => {
    expect(analyze(fixture("test-event")).shape.events.map((e) => e.storedAs)).toEqual([
      "test_ack",
    ]);
    expect(analyze(fixture("enroll-event")).shape.events.map((e) => e.storedAs)).toEqual([
      "pending_sweep",
    ]);
    expect(analyze(fixture("appeal-event")).shape.events[0]).toMatchObject({
      eventType: "appeal",
      eventTypeDocumented: true,
      missingSweepFields: [],
    });
  });

  it("reports what is off in a mixed batch: a numeric id, an unlisted type, an element with no id", () => {
    const report = analyze(fixture("mixed-batch"));
    expect(report.shape).toMatchObject({ storedAs: "events", eventCount: 4 });
    expect(report.shape.events.map((e) => e.eventIdSentAs)).toEqual([
      "number",
      "string",
      "string",
      "missing",
    ]);
    expect(report.shape.events.map((e) => e.storedAs)).toEqual([
      "pending_sweep",
      "pending_sweep",
      "pending_sweep",
      "malformed",
    ]);
    expect(report.shape.eventTypeCounts).toEqual({ enroll: 2, appeal: 1, brand_new: 1 });
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("1 event(s) carry no usable eventid"),
        expect.stringContaining("1 event(s) of type brand_new, not one the docs list"),
        expect.stringContaining(
          "an event of type enroll lacks prov_npi, enroll_type, enrollid, event, payerid",
        ),
      ]),
    );
  });

  it("carries no field value: not the NPI, the control number, the appeal id, the key or the signature", () => {
    for (const name of names) {
      const input = fixture(name);
      const report = analyze(input);
      const text = JSON.stringify(report) + renderClaimMdReplayReport(report);
      for (const secret of [
        "1111111112",
        "SYNTHCTRL0001",
        "A-501",
        "SYN01",
        KEY,
        input.capture.headers[CLAIMMD_SIGNATURE_HEADER] as string,
        input.capture.bodyBase64,
      ]) {
        expect(text, `${name} leaks ${secret}`).not.toContain(secret);
      }
    }
  });
});

describe("the report never echoes a value a sender put in a name, a type, a time or a path", () => {
  const SSN_LIKE = "123-45-6789";
  const NPI_LIKE = "1234567893";
  const hostile = JSON.stringify({
    UTCTime: "Smith John Q",
    acct_number: "99999",
    [SSN_LIKE]: 1,
    "Jane Q Public": 2,
    events: [
      {
        eventid: "1",
        event_type: NPI_LIKE,
        event_time: "Jane Doe MRN 4455",
        event_data: { [SSN_LIKE]: { [NPI_LIKE]: "x" } },
      },
      { eventid: "2", event_type: "Jane", event_time: "Thu, 05 Nov 2026 12:00:00 GMT" },
    ],
  });

  it("masks digit runs in names and type words, and every word in a time", () => {
    const { capture, rawBody } = craft(hostile);
    const report = analyze({ capture: { ...capture, path: "/x/secret-token-123" }, rawBody });
    const text = JSON.stringify(report) + renderClaimMdReplayReport(report);
    for (const leak of [
      SSN_LIKE,
      NPI_LIKE,
      "Smith",
      "Jane Q",
      "Doe",
      "MRN",
      "4455",
      "secret-token",
      "Thu",
    ]) {
      expect(text, `leaks ${leak}`).not.toContain(leak);
    }
    expect(report.capture.path).toBe("<other>");
    expect(report.shape.utcTime.shape).toBe("a a a");
    expect(report.shape.events[0]).toMatchObject({
      eventType: "<other>",
      eventTimeShape: "a a a 9999",
    });
    expect(report.shape.events[1]?.eventTimeShape).toBe("a, 99 a 9999 99:99:99 a");
  });

  it("echoes the fixed route, never the captured path, and bounds header names, media types and encodings to fixed tokens", () => {
    const { capture, rawBody } = craft(BODY, undefined, {
      "content-type": "text/john.smith.123456789",
      "content-encoding": "ssn-123456789",
      "x-123-45-6789": "v",
      x_vendor_id: "v",
    });
    const report = analyze({
      capture: { ...capture, path: "/John.Smith.123456789/webhooks/claimmd/test" },
      rawBody,
    });
    const text = JSON.stringify(report) + renderClaimMdReplayReport(report);
    expect(report.capture).toMatchObject({
      path: "/api/v1/webhooks/claimmd/test",
      contentType: "<other>",
      contentEncoding: "<other>",
      otherHeaderNames: ["<other>", "x_vendor_id"],
    });
    for (const leak of ["John", "Smith", "123456789", "6789"])
      expect(text, `leaks ${leak}`).not.toContain(leak);
  });

  it("keeps the report small however many keys and findings a body offers", () => {
    const many = Object.fromEntries(
      Array.from({ length: 5000 }, (_, i) => [
        `key${"x".repeat(i % 7)}${String.fromCharCode(97 + (i % 26))}${i}`,
        1,
      ]),
    );
    const body = JSON.stringify({ acct_number: "99999", events: [{ eventid: "1" }], ...many });
    const report = analyze(craft(body));
    expect(Object.keys(report.shape.topLevelKeys).length).toBeLessThanOrEqual(50);
    expect(report.shape.unknownTopLevelKeys.length).toBeLessThanOrEqual(50);
    expect(report.findings.length).toBeLessThanOrEqual(51);
    expect(JSON.stringify(report).length).toBeLessThan(20_000);

    // and the same for one EVENT with thousands of keys
    const manyEventKeys = JSON.stringify({
      acct_number: "99999",
      events: [{ eventid: "1", ...many }],
    });
    const eventReport = analyze(craft(manyEventKeys));
    expect(eventReport.shape.events[0]?.keys.length).toBeLessThanOrEqual(50);
    expect(JSON.stringify(eventReport).length).toBeLessThan(20_000);
  });

  it("does not throw when a body cannot be re-serialised for the alternative-scheme check", () => {
    const input = craft(BODY, mac("something else").toString("base64"));
    const spy = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => {
      throw new RangeError("Maximum call stack size exceeded");
    });
    try {
      expect(analyze(input).signature.verdict).toBe("mismatch");
    } finally {
      spy.mockRestore();
    }
  });

  it("labels a valid string eventid that merely begins `x:` as a string", () => {
    const body = JSON.stringify({
      acct_number: "99999",
      events: [{ eventid: "x:abc", event_type: "test" }],
    });
    expect(analyze(craft(body)).shape.events[0]).toMatchObject({
      eventIdSentAs: "string",
      storedAs: "test_ack",
    });
  });

  it("reports a timestamp's layout, keeping only T, Z, AM and PM", () => {
    const iso = JSON.stringify({
      UTCTime: "2026-11-05T12:00:00Z",
      acct_number: "99999",
      events: [{ eventid: "1" }],
    });
    expect(analyze(craft(iso)).shape.utcTime.shape).toBe("9999-99-99T99:99:99Z");
  });

  it("reports the media type and encoding as bounded tokens, never free text", () => {
    const withType = (type: string, encoding?: string) =>
      analyze(
        craft(BODY, undefined, {
          "content-type": type,
          ...(encoding ? { "content-encoding": encoding } : {}),
        }),
      ).capture;
    expect(withType("Application/JSON; charset=utf-8")).toMatchObject({
      contentType: "application/json",
      contentEncoding: null,
    });
    expect(withType("not a media type at all")).toMatchObject({ contentType: "<other>" });
    expect(withType("application/json", "GZIP")).toMatchObject({ contentEncoding: "gzip" });
    expect(withType("application/json", "x y z")).toMatchObject({ contentEncoding: "<other>" });
  });

  it("counts a vocabulary word such as `constructor` as a word, not an inherited property, and drops `__proto__`", () => {
    const body = JSON.stringify({
      acct_number: "99999",
      events: [
        { eventid: "1", event_type: "constructor" },
        { eventid: "2", event_type: "__proto__" },
        { eventid: "3", event_type: "toString" },
      ],
    });
    const report = analyze(craft(body));
    expect(report.shape.eventTypeCounts).toEqual({ constructor: 1, "<other>": 2 });
  });

  it("calls an unusable eventid `missing` and does not blame the sweep for an event that never reaches it", () => {
    const body = JSON.stringify({
      acct_number: "99999",
      events: [
        { eventid: "has a space", event_type: "brand_new" },
        { eventid: "2", event_type: "brand_new" },
      ],
    });
    const report = analyze(craft(body));
    expect(report.shape.events.map((e) => e.eventIdSentAs)).toEqual(["missing", "string"]);
    expect(report.findings.filter((f) => f.includes("unsupported_type"))).toEqual([
      "1 event(s) of type brand_new, not one the docs list: the sweep settles it as unsupported_type",
    ]);
  });

  it("judges the sweep's fields on the real event_data, however many keys it has", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`k${String.fromCharCode(97 + (i % 26))}${i % 7}`, i]),
    );
    const body = JSON.stringify({
      acct_number: "99999",
      events: [
        {
          eventid: "1",
          event_type: "appeal",
          event_data: {
            appeal: { ...wide, remote_claimid: "X", appealid: "Y", event: "e", appeal_type: "t" },
          },
        },
      ],
    });
    expect(analyze(craft(body)).shape.events[0]?.missingSweepFields).toEqual([]);
  });

  it("flags a UTCTime ahead of the capture, and reads header names case-insensitively", () => {
    const future = JSON.stringify({
      UTCTime: "2026-11-06 12:00:00",
      acct_number: "99999",
      events: [{ eventid: "1" }],
    });
    const input = craft(future);
    expect(analyze(input).findings.join("\n")).toContain(
      "UTCTime is ahead of when the delivery arrived",
    );
    const parsed = parseClaimMdCapture({
      ...JSON.parse(JSON.stringify(input.capture)),
      headers: { "Auth-Signature-Base64": input.capture.headers[CLAIMMD_SIGNATURE_HEADER] },
    });
    expect(parsed.ok && parsed.capture.headers[CLAIMMD_SIGNATURE_HEADER]).toBe(
      input.capture.headers[CLAIMMD_SIGNATURE_HEADER],
    );
  });
});

describe("signature verdicts", () => {
  it("names the class of every refusal and accepts only the documented scheme", () => {
    const rawBody = Buffer.from(BODY);
    const good = mac(rawBody).toString("base64");
    expect(classifyClaimMdSignature(KEY, rawBody, good)).toBe("ok");
    expect(classifyClaimMdSignature(KEY, rawBody, undefined)).toBe("header_missing");
    expect(classifyClaimMdSignature(KEY, rawBody, "")).toBe("header_malformed");
    expect(classifyClaimMdSignature(KEY, rawBody, [good, good])).toBe("header_malformed");
    expect(classifyClaimMdSignature(KEY, rawBody, mac(rawBody).toString("hex"))).toBe(
      "header_malformed",
    );
    expect(classifyClaimMdSignature("SYNTH_other_key", rawBody, good)).toBe("mismatch");
    expect(classifyClaimMdSignature("", rawBody, good)).toBe("no_key");
  });

  it("treats a header of non-ASCII characters as a refusal, never a crash (UTF-16 and UTF-8 lengths differ)", () => {
    for (const header of ["é".repeat(44), "é".repeat(43), "é".repeat(64), `${"A".repeat(43)}é`]) {
      const report = analyze(craft(BODY, header));
      expect(report.signature.verdict, header).toBe("header_malformed");
    }
  });

  it("checks shape only, and says so, when no key is given", () => {
    const report = analyze(fixture("test-event"), null);
    expect(report.signature).toEqual({ verdict: "not_checked", keyLength: null, alternatives: [] });
    expect(report.findings).toEqual(["signature not checked: no account key was given"]);
  });
});

describe("which alternative scheme would have verified (diagnosis only)", () => {
  const signatureOf = (input: { capture: ClaimMdCapture; rawBody: Buffer }, key = KEY) =>
    analyze(input, key).signature;

  it("a hex digest", () => {
    const rawBody = Buffer.from(BODY);
    const sig = signatureOf(craft(rawBody, mac(rawBody).toString("hex")));
    expect(sig.verdict).toBe("header_malformed");
    expect(sig.alternatives).toEqual(["key_as_configured+body_as_received+hex"]);
  });

  it("a base64url or unpadded digest", () => {
    const rawBody = Buffer.from(BODY);
    const b64 = mac(rawBody).toString("base64");
    const url = b64.replace(/\+/g, "-").replace(/\//g, "_");
    const unpadded = b64.replace(/=+$/, "");
    for (const [header, label] of [
      [url, "base64url"],
      [unpadded, "base64_unpadded"],
    ] as const) {
      const sig = signatureOf(craft(rawBody, header));
      expect(sig.verdict).toBe("header_malformed");
      // a digest with no "+", "/" or padding reads as several encodings at once: the label must be among them
      expect(sig.alternatives.some((a) => a.endsWith(label))).toBe(true);
    }
  });

  it("a sha256= prefix", () => {
    const rawBody = Buffer.from(BODY);
    const sig = signatureOf(craft(rawBody, `sha256=${mac(rawBody).toString("hex")}`));
    expect(sig.alternatives).toEqual(["key_as_configured+body_as_received+hex+sha256_prefix"]);
  });

  it("a trailing newline the vendor signed without", () => {
    const sig = signatureOf(craft(`${BODY}\n`, mac(BODY).toString("base64")));
    expect(sig.verdict).toBe("mismatch");
    // re-serialising compact JSON drops the newline too, so both readings name the same bytes
    expect(sig.alternatives).toContain("key_as_configured+body_trailing_newline_removed+base64");
  });

  it("a body the vendor signed after re-serialising it", () => {
    const sent = JSON.stringify(JSON.parse(BODY), null, 2);
    const sig = signatureOf(craft(sent, mac(BODY).toString("base64")));
    expect(sig.alternatives).toEqual(["key_as_configured+body_reserialised_json+base64"]);
  });

  it("a gzip body the vendor signed after decompressing it", () => {
    const input = craft(gzipSync(Buffer.from(BODY)), mac(BODY).toString("base64"), {
      "content-encoding": "gzip",
    });
    const report = analyze(input);
    expect(report.signature.alternatives).toEqual(["key_as_configured+body_gunzipped+base64"]);
    expect(report.findings).toEqual(
      expect.arrayContaining([expect.stringContaining("never decompresses")]),
    );
  });

  it("a key with stray whitespace in our configuration, and one that needs UTF-8 bytes", () => {
    const padded = analyze(craft(BODY), ` ${KEY}\n`);
    expect(padded.signature.alternatives).toEqual(["key_trimmed+body_as_received+base64"]);
    expect(padded.findings).toEqual(
      expect.arrayContaining(["the configured key has leading or trailing whitespace"]),
    );

    const accented = "SYNTH_café#*";
    const utf8 = signatureOf(
      craft(BODY, mac(BODY, Buffer.from(accented, "utf8")).toString("base64")),
      accented,
    );
    expect(utf8.alternatives).toEqual(["key_utf8+body_as_received+base64"]);
  });

  it("finds nothing when no reading of the scheme fits (the wrong key)", () => {
    expect(signatureOf(craft(BODY), "SYNTH_wrong_key")).toMatchObject({
      verdict: "mismatch",
      alternatives: [],
    });
  });
});

describe("shape deviations", () => {
  const withBody = (body: string | Buffer) => analyze(craft(body));

  it("flags a body that is not JSON, an empty batch and a missing account", () => {
    expect(withBody("not json at all")).toMatchObject({
      shape: { jsonValid: false, storedAs: "one_malformed_receipt", eventCount: 0 },
      findings: expect.arrayContaining([expect.stringContaining("not valid UTF-8 JSON")]),
    });
    expect(withBody('{"acct_number":"99999","events":[]}').shape.storedAs).toBe(
      "one_malformed_receipt",
    );
    expect(withBody('{"events":[{"eventid":"1"}]}').findings).toEqual(
      expect.arrayContaining([expect.stringContaining("cannot be split into events")]),
    );
  });

  it("flags an unknown top-level key by name, never by value", () => {
    const report = withBody(
      '{"acct_number":"99999","events":[{"eventid":"1"}],"patient_note":"free text"}',
    );
    expect(report.shape.unknownTopLevelKeys).toEqual(["patient_note"]);
    expect(JSON.stringify(report)).not.toContain("free text");
  });

  it("hides a key that is free text rather than a field name", () => {
    const report = withBody('{"acct_number":"99999","events":[{"eventid":"1"}],"Jane Q Public":1}');
    expect(report.shape.unknownTopLevelKeys).toEqual(["<other>"]);
    expect(JSON.stringify(report)).not.toContain("Jane");
  });

  it("calls a UTCTime outside Claim.MD's four-day retry window a replay, and never refuses on it", () => {
    const old = JSON.stringify({
      UTCTime: "2026-10-01 00:00:00",
      acct_number: "99999",
      events: [{ eventid: "1", event_type: "test" }],
    });
    const report = withBody(old);
    expect(report.shape.utcTime).toEqual({
      shape: "9999-99-99 99:99:99",
      age: "older_than_the_4_day_retry_window",
    });
    expect(report.signature.verdict).toBe("ok");
    expect(report.shape.storedAs).toBe("events");
  });

  it("never throws on garbage", () => {
    for (const garbage of [
      Buffer.alloc(0),
      Buffer.from([0xff, 0xfe, 0x00]),
      Buffer.from("{".repeat(10_000)),
      Buffer.from("null"),
      Buffer.from("[]"),
    ]) {
      expect(() => analyze(craft(garbage))).not.toThrow();
    }
  });

  it("renders a terminal report", () => {
    const text = renderClaimMdReplayReport(analyze(fixture("mixed-batch")));
    expect(text).toContain("signature: ok (key length 24)");
    expect(text).toContain("event types: enroll×2, appeal×1, brand_new×1");
    expect(text).toContain("findings:");
  });
});

describe("the capture file", () => {
  it("keeps the signature and transport headers, and only the NAMES of every other header", () => {
    const capture = buildClaimMdCapture({
      method: "post",
      url: `${URL_TEST}?token=secret`,
      headers: {
        [CLAIMMD_SIGNATURE_HEADER]: "SIG",
        "content-type": "application/json",
        cookie: "session=SECRET-COOKIE",
        authorization: "Bearer SECRET-TOKEN",
        "x-vendor-id": ["a", "b"],
      },
      rawBody: Buffer.from("{}"),
      receivedAt: new Date("2026-11-05T12:00:00Z"),
    });
    expect(capture).toMatchObject({
      format: CLAIMMD_CAPTURE_FORMAT,
      method: "POST",
      path: URL_TEST,
      receivedAt: "2026-11-05T12:00:00.000Z",
      headers: { [CLAIMMD_SIGNATURE_HEADER]: "SIG", "content-type": "application/json" },
      otherHeaderNames: ["authorization", "cookie", "x-vendor-id"],
    });
    expect(JSON.stringify(capture)).not.toContain("SECRET");
    expect(JSON.stringify(capture)).not.toContain("token=");
  });

  it("round-trips the exact bytes, including ones that are not UTF-8", () => {
    const rawBody = Buffer.from([0x7b, 0xff, 0x00, 0x7d]);
    const parsed = parseClaimMdCapture(JSON.parse(JSON.stringify(craft(rawBody).capture)));
    expect(parsed.ok && parsed.rawBody.equals(rawBody)).toBe(true);
  });

  it("refuses a capture that is not the format, has non-canonical base64, or exceeds the receiver's limit", () => {
    const good = JSON.parse(JSON.stringify(craft(BODY).capture));
    expect(parseClaimMdCapture(null)).toMatchObject({ ok: false });
    expect(parseClaimMdCapture({ ...good, format: "claimmd-webhook-capture/9" })).toMatchObject({
      ok: false,
    });
    expect(parseClaimMdCapture({ ...good, bodyBase64: "not base64!" })).toMatchObject({
      ok: false,
    });
    expect(parseClaimMdCapture({ ...good, headers: { a: 1 } })).toMatchObject({ ok: false });
    expect(parseClaimMdCapture({ ...good, method: undefined })).toMatchObject({ ok: false });
    const huge = Buffer.alloc(1024 * 1024 + 1, 0x61).toString("base64");
    expect(parseClaimMdCapture({ ...good, bodyBase64: huge })).toMatchObject({ ok: false });
  });
});

describe("the unverified field list", () => {
  it("names the documented envelope, the event keys and the three event types", () => {
    expect(CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.envelope).toEqual([
      "UTCTime",
      "acct_number",
      "remote_acct_number",
      "events",
    ]);
    expect(CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.event).toEqual([
      "eventid",
      "event_type",
      "event_time",
      "event_data",
    ]);
    expect(CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventTypes).toEqual(["enroll", "appeal", "test"]);
  });
});
