// Claim.MD webhook helpers: signature check and delivery split. Synthetic key and bodies only.
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLAIMMD_EVENT_ID_MAX,
  CLAIMMD_MAX_SPLIT_EVENTS,
  parseClaimMdDelivery,
  verifyClaimMdSignature,
} from "./claimmd-webhook";

const KEY = "SYNTH99999_k#ey*not-real";
const BODY =
  '{"UTCTime":"2026-11-05 12:00:00","acct_number":"99999","events":[{"eventid":"1001","event_type":"test","event_time":"2026-11-05 12:00:00","event_data":{"test":{"event":"test","event_detail":"synthetic"}}}]}';
// openssl dgst -sha256 -hmac '<KEY>' -binary body | base64 (computed outside this code)
const GOLDEN = "04slXlDNccpIDlRUBxcjo7+RBNv5UxtqVSnK1jd+NuY=";

const sign = (key: Buffer | string, body: Buffer) =>
  createHmac("sha256", key).update(body).digest("base64");

describe("verifyClaimMdSignature", () => {
  it("accepts the golden vector over the exact bytes", () => {
    expect(verifyClaimMdSignature(KEY, Buffer.from(BODY, "utf8"), GOLDEN)).toBe(true);
  });

  it("refuses when one body byte changes", () => {
    expect(verifyClaimMdSignature(KEY, Buffer.from(`${BODY} `, "utf8"), GOLDEN)).toBe(false);
  });

  it("uses the key's Latin-1 bytes, not its UTF-8 encoding", () => {
    const key = "SYNTH_café#*";
    const body = Buffer.from("{}");
    expect(verifyClaimMdSignature(key, body, sign(Buffer.from(key, "latin1"), body))).toBe(true);
    expect(verifyClaimMdSignature(key, body, sign(Buffer.from(key, "utf8"), body))).toBe(false);
  });

  it("refuses a missing, array, wrong-length or non-canonical header", () => {
    const body = Buffer.from(BODY);
    expect(verifyClaimMdSignature(KEY, body, undefined)).toBe(false);
    expect(verifyClaimMdSignature(KEY, body, [GOLDEN, GOLDEN])).toBe(false);
    expect(verifyClaimMdSignature(KEY, body, "")).toBe(false);
    expect(verifyClaimMdSignature(KEY, body, GOLDEN.slice(0, -2))).toBe(false); // too short
    expect(verifyClaimMdSignature(KEY, body, `${GOLDEN}=`)).toBe(false); // padding added
    expect(verifyClaimMdSignature(KEY, body, ` ${GOLDEN}`)).toBe(false); // whitespace
    expect(verifyClaimMdSignature(KEY, body, GOLDEN.replace(/\+/g, "-"))).toBe(false); // base64url alphabet
    // Last char before '=' carries 2 unused bits: 'Y' -> 'Z' decodes to the same bytes but is not canonical.
    const nonCanonical = `${GOLDEN.slice(0, 42)}Z=`;
    expect(Buffer.from(nonCanonical, "base64").equals(Buffer.from(GOLDEN, "base64"))).toBe(true);
    expect(verifyClaimMdSignature(KEY, body, nonCanonical)).toBe(false);
  });

  it("refuses with an empty key (an unsigned delivery is never accepted)", () => {
    expect(verifyClaimMdSignature("", Buffer.from(BODY), GOLDEN)).toBe(false);
  });
});

const element = (eventid: unknown, extra: Record<string, unknown> = {}) => ({
  eventid,
  event_type: "enroll",
  event_time: "2026-11-05 12:00:00",
  event_data: { enroll: { enrollid: "77", event: "enrolled", prov_npi: "1111111112" } },
  ...extra,
});
const body = (events: unknown, over: Record<string, unknown> = {}) =>
  Buffer.from(JSON.stringify({ UTCTime: "2026-11-05", acct_number: "99999", events, ...over }));
const sha = (s: Buffer | string) => createHash("sha256").update(s).digest("hex");

describe("parseClaimMdDelivery", () => {
  it("splits a one-event delivery and keeps the element for encryption", () => {
    const d = parseClaimMdDelivery(body([element("1001")]));
    expect(d.kind).toBe("events");
    if (d.kind !== "events") return;
    expect(d.acctNumber).toBe("99999");
    expect(d.remoteAcctNumber).toBeNull();
    expect(d.events).toHaveLength(1);
    const [e] = d.events;
    expect(e).toMatchObject({ eventId: "1001", eventType: "enroll", malformed: false });
    expect(JSON.parse(e?.element ?? "")).toMatchObject({ eventid: "1001" });
  });

  it("keeps 100 and 101 events (never refuses content after the signature)", () => {
    for (const n of [100, 101]) {
      const d = parseClaimMdDelivery(body(Array.from({ length: n }, (_, i) => element(String(i)))));
      expect(d.kind === "events" && d.events.length).toBe(n);
    }
  });

  it("stores an empty batch as one unsplittable row", () => {
    const raw = body([]);
    expect(parseClaimMdDelivery(raw)).toEqual({
      kind: "unsplittable",
      acctNumber: "99999",
      bodySha256: sha(raw),
    });
  });

  it("stores a batch beyond the split bound whole instead of splitting it", () => {
    const raw = body(
      Array.from({ length: CLAIMMD_MAX_SPLIT_EVENTS + 1 }, (_, i) => element(String(i))),
    );
    expect(parseClaimMdDelivery(raw).kind).toBe("unsplittable");
  });

  it("accepts a numeric eventid as its decimal string", () => {
    const d = parseClaimMdDelivery(body([element(4242)]));
    expect(d.kind === "events" && d.events[0]?.eventId).toBe("4242");
  });

  it("keys an element without a usable eventid on its own digest and marks it malformed", () => {
    const bad = element(undefined);
    const tooLong = element("x".repeat(CLAIMMD_EVENT_ID_MAX + 1));
    const d = parseClaimMdDelivery(body([bad, tooLong, element(1.5), element("ok-1")]));
    if (d.kind !== "events") throw new Error("expected events");
    expect(d.events.map((e) => e.malformed)).toEqual([true, true, true, false]);
    expect(d.events[0]?.eventId).toBe(`x:${sha(JSON.stringify(bad))}`);
  });

  it("keeps an unknown event_type and bounds it", () => {
    const d = parseClaimMdDelivery(
      body([element("1", { event_type: "brand_new" }), element("2", { event_type: "<script>" })]),
    );
    if (d.kind !== "events") throw new Error("expected events");
    expect(d.events.map((e) => e.eventType)).toEqual(["brand_new", null]);
  });

  it("reads remote_acct_number when present", () => {
    const d = parseClaimMdDelivery(body([element("1")], { remote_acct_number: "CW-1" }));
    expect(d.kind === "events" && d.remoteAcctNumber).toBe("CW-1");
  });

  it("tolerates a UTF-8 BOM", () => {
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body([element("1")])]);
    expect(parseClaimMdDelivery(raw).kind).toBe("events");
  });

  it("treats invalid UTF-8, non-JSON, a non-object and a missing acct_number as unsplittable", () => {
    const cases = [
      Buffer.from([0x7b, 0xff, 0xfe, 0x7d]),
      Buffer.from("not json"),
      Buffer.from("[]"),
      body([element("1")], { acct_number: undefined }),
      body("nope"),
      Buffer.alloc(0),
    ];
    for (const raw of cases) {
      const d = parseClaimMdDelivery(raw);
      expect(d.kind).toBe("unsplittable");
      expect(d.kind === "unsplittable" && d.bodySha256).toBe(sha(raw));
    }
  });
});
