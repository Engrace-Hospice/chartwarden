// @chartwarden/x12-837-client — the Claim.MD webhook REPLAY report (CW-TX-02). PURE: no I/O; the caller passes the clock.
//
// Feed it one capture (`claimmd-webhook-capture.ts`) and the account key, and it says what the receiver would make of that delivery
// WITHOUT changing the receiver: whether the signature verifies (and, if not, which alternative scheme WOULD have verified, the
// answer to "which assumption in our docs reading was wrong"), how the body splits into events, and where it departs from the shape
// the receiver and the sweep were written against. The report carries NO field value: only counts, types, key names that look like
// identifiers, value shapes (digits replaced by 9) and the bounded event_type word. It is the part that is safe to paste into a
// ticket or an agent session; the capture itself is not.
//
// The alternative-scheme check is diagnosis only. Acceptance is `classifyClaimMdSignature` in `claimmd-webhook.ts`, unchanged by
// anything here.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  CLAIMMD_MAX_SPLIT_EVENTS,
  CLAIMMD_SIGNATURE_HEADER,
  type ClaimMdDeliveryEvent,
  type ClaimMdSignatureVerdict,
  claimMdReceiptOutcome,
  classifyClaimMdSignature,
  parseClaimMdDelivery,
} from "./claimmd-webhook";
import type { ClaimMdCapture } from "./claimmd-webhook-capture";

/**
 * Every vendor field name the receiver or the sweep relies on. UNVERIFIED: they follow Claim.MD's published webhook page (read
 * 2026-11-05) and our own synthetic fixtures; no real delivery has been captured, so none of these is confirmed by traffic. The
 * sweep (`claimmd-webhook/sweep.ts`, `routeOf`) reads exactly the `eventData` names below; a unit test keeps the two in step.
 */
export const CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED = {
  envelope: ["UTCTime", "acct_number", "remote_acct_number", "events"],
  event: ["eventid", "event_type", "event_time", "event_data"],
  /** The event types the docs list; the sweep settles any other as `unsupported_type`. */
  eventTypes: ["enroll", "appeal", "test"],
  /** Every name the sweep reads under `event_data.<type>`; `prov_npi` and `remote_claimid` decide the routing. */
  eventData: {
    enroll: ["prov_npi", "enroll_type", "enrollid", "event", "payerid"],
    appeal: ["remote_claimid", "appealid", "event", "appeal_type"],
  },
} as const;

type SweepEventType = keyof typeof CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventData;

/** Claim.MD retries a failed delivery for up to 4 days; a body older than that is not a retry. */
const RETRY_WINDOW_MS = 4 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const MAX_REPORTED_EVENTS = 10;
const MAX_PATHS = 200;
const MAX_DEPTH = 3;
const MAX_GUNZIP_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const jsonType = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
/**
 * A key is reported only when it looks like a field NAME: it starts with a letter, is short, and holds no run of three digits (an
 * NPI, an SSN, a member id). Anything else could be a value an unexpected sender put in key position, so it is `<other>`.
 */
const safeName = (k: string): string =>
  /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/.test(k) && !/\d{3}/.test(k) ? k : "<other>";
/** An `event_type` word is reported only when it looks like a vocabulary word: lower-case letters, `_`, `.`, `-`, no digit. */
const typeWord = (t: string | null): string | null =>
  t === null ? null : /^[a-z][a-z_.-]{0,31}$/.test(t) ? t : "<other>";
const TIME_TOKENS: ReadonlySet<string> = new Set(["T", "Z", "AM", "PM"]);
/**
 * A value's SHAPE: digits become 9 and every word but T, Z, AM and PM becomes `a`, so a timestamp's layout is visible and none of
 * its characters are. Null for anything that is not short and timestamp-like.
 */
const shapeOf = (v: unknown): string | null =>
  typeof v === "string" && v.length <= 40 && /^[0-9A-Za-z :.+/,-]*$/.test(v)
    ? v.replace(/[0-9]/g, "9").replace(/[A-Za-z]+/g, (word) => (TIME_TOKENS.has(word) ? word : "a"))
    : null;
// Transport tokens come from fixed lists: a free-form token is a place a sender can put a value.
const KNOWN_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "application/json",
  "application/x-www-form-urlencoded",
  "application/octet-stream",
  "text/plain",
  "text/json",
]);
const KNOWN_ENCODINGS: ReadonlySet<string> = new Set(["identity", "gzip", "deflate", "br", "zstd"]);
const mediaTypeOf = (v: string | undefined): string | null => {
  const type = v?.split(";", 1)[0]?.trim().toLowerCase();
  return type === undefined || type === "" ? null : KNOWN_MEDIA_TYPES.has(type) ? type : "<other>";
};
const encodingOf = (v: string | undefined): string | null => {
  const encoding = v?.trim().toLowerCase();
  return encoding === undefined || encoding === ""
    ? null
    : KNOWN_ENCODINGS.has(encoding)
      ? encoding
      : "<other>";
};
/** The most findings, keys and header names a report lists: a 1 MiB body of distinct keys must not become a megabyte report. */
const MAX_LISTED = 50;
const isDocumentedType = (type: string | null): boolean =>
  type !== null &&
  (CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventTypes as readonly string[]).includes(type);
const hasSweepFields = (type: string | null): type is SweepEventType =>
  type !== null && Object.hasOwn(CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventData, type);

export interface ClaimMdReportEvent {
  /** `number` or `string` as sent, `missing` when absent or unusable (the receiver keys the element on its digest). */
  readonly eventIdSentAs: "number" | "string" | "missing";
  readonly eventType: string | null;
  readonly eventTypeDocumented: boolean;
  readonly eventTimeShape: string | null;
  /** What storing the element settles: a test ack, a terminal malformed row, or a wait for the sweep. */
  readonly storedAs: "test_ack" | "malformed" | "pending_sweep";
  readonly keys: readonly string[];
  /** `event_data` paths (to depth 3) with their JSON types. */
  readonly eventDataPaths: Readonly<Record<string, string>>;
  /** Names under `event_data.<type>` the sweep reads that this event does not carry. */
  readonly missingSweepFields: readonly string[];
}

export interface ClaimMdReplayReport {
  readonly capture: {
    readonly path: string;
    readonly usage: "test" | "production" | "other";
    readonly bytes: number;
    readonly bodySha256: string;
    readonly contentType: string | null;
    readonly contentEncoding: string | null;
    readonly otherHeaderNames: readonly string[];
  };
  readonly signature: {
    readonly verdict: ClaimMdSignatureVerdict | "not_checked";
    readonly keyLength: number | null;
    /** Alternative schemes that WOULD have verified (empty unless the verdict is a refusal on the header or the MAC). */
    readonly alternatives: readonly string[];
  };
  readonly shape: {
    readonly storedAs: "events" | "one_malformed_receipt";
    readonly jsonValid: boolean;
    readonly topLevelKeys: Readonly<Record<string, string>>;
    readonly unknownTopLevelKeys: readonly string[];
    readonly utcTime: { readonly shape: string | null; readonly age: string };
    readonly eventCount: number;
    readonly eventTypeCounts: Readonly<Record<string, number>>;
    /** The first ten events; the rest are in the counts. */
    readonly events: readonly ClaimMdReportEvent[];
  };
  /** Value-free, human-readable deviations from what the receiver was written against. Empty when the delivery fits. */
  readonly findings: readonly string[];
}

const sha256Hex = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

function usageOf(path: string): "test" | "production" | "other" {
  if (path.endsWith("/webhooks/claimmd/test")) return "test";
  if (path.endsWith("/webhooks/claimmd/production")) return "production";
  return "other";
}

/** Equal text, compared as BYTES: `timingSafeEqual` throws when two strings of equal UTF-16 length differ in UTF-8 length. */
const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function decodeJson(raw: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return undefined;
  }
}

/** Candidate encodings of one MAC, with the label each would carry. */
function encodings(mac: Buffer): readonly (readonly [string, string])[] {
  const b64 = mac.toString("base64");
  const hex = mac.toString("hex");
  return [
    ["base64", b64],
    ["base64url", b64.replace(/\+/g, "-").replace(/\//g, "_")],
    ["base64_unpadded", b64.replace(/=+$/, "")],
    ["hex", hex],
    ["hex_upper", hex.toUpperCase()],
  ];
}

function keyVariants(key: string): readonly (readonly [string, Buffer])[] {
  const base = Buffer.from(key, "latin1");
  const variants: [string, Buffer][] = [
    ["key_utf8", Buffer.from(key, "utf8")],
    ["key_trimmed", Buffer.from(key.trim(), "latin1")],
  ];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0)
    variants.push(["key_base64_decoded", Buffer.from(key, "base64")]);
  // The configured key is the baseline the verdict already judged: only DIFFERENT bytes are alternatives.
  return variants.filter(([, bytes]) => !bytes.equals(base));
}

function bodyVariants(body: Buffer): readonly (readonly [string, Buffer])[] {
  const variants: [string, Buffer][] = [];
  const text = body.toString("utf8");
  if (text.endsWith("\n"))
    variants.push(["body_trailing_newline_removed", Buffer.from(text.replace(/\r?\n$/, ""))]);
  else variants.push(["body_trailing_newline_added", Buffer.from(`${text}\n`)]);
  if (text.includes("\r\n"))
    variants.push(["body_crlf_to_lf", Buffer.from(text.replace(/\r\n/g, "\n"))]);
  const parsed = decodeJson(body);
  if (parsed !== undefined) {
    try {
      const reserialised = Buffer.from(JSON.stringify(parsed));
      if (!reserialised.equals(body)) variants.push(["body_reserialised_json", reserialised]);
    } catch {
      // nested deeper than the runtime can stringify: this reading cannot be tried
    }
  }
  if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
    try {
      variants.push(["body_gunzipped", gunzipSync(body, { maxOutputLength: MAX_GUNZIP_BYTES })]);
    } catch {
      // not gzip after all: nothing to try
    }
  }
  return variants;
}

/** Which alternative readings of the scheme WOULD have produced the header. Diagnosis only; never used to accept a delivery. */
function alternativeSchemes(key: string, body: Buffer, header: string): readonly string[] {
  const prefixed = /^sha256=/i.test(header);
  const bare = prefixed ? header.replace(/^sha256=/i, "") : header;
  const keys: (readonly [string, Buffer])[] = [
    ["key_as_configured", Buffer.from(key, "latin1")],
    ...keyVariants(key),
  ];
  const bodies: (readonly [string, Buffer])[] = [["body_as_received", body], ...bodyVariants(body)];
  const found: string[] = [];
  for (const [keyLabel, keyBytes] of keys) {
    for (const [bodyLabel, bodyBytes] of bodies) {
      const mac = createHmac("sha256", keyBytes).update(bodyBytes).digest();
      for (const [encLabel, encoded] of encodings(mac)) {
        if (!sameText(encoded, bare)) continue;
        const documented =
          keyLabel === "key_as_configured" &&
          bodyLabel === "body_as_received" &&
          encLabel === "base64" &&
          !prefixed;
        // the documented scheme is what the verdict judged, not an alternative to it
        if (!documented)
          found.push(
            [keyLabel, bodyLabel, encLabel, ...(prefixed ? ["sha256_prefix"] : [])].join("+"),
          );
      }
    }
  }
  return found;
}

function ageOf(utcTime: unknown, now: Date): string {
  if (typeof utcTime !== "string") return "absent";
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(utcTime)) return "unparseable";
  const at = Date.parse(`${utcTime.slice(0, 10)}T${utcTime.slice(11, 19)}Z`);
  if (Number.isNaN(at)) return "unparseable";
  const age = now.getTime() - at;
  if (age < -CLOCK_SKEW_MS) return "in_the_future";
  return age > RETRY_WINDOW_MS ? "older_than_the_4_day_retry_window" : "within_the_retry_window";
}

function walkPaths(
  value: unknown,
  prefix: string,
  depth: number,
  out: Record<string, string>,
): void {
  if (Object.keys(out).length >= MAX_PATHS) return;
  out[prefix] = jsonType(value);
  if (depth >= MAX_DEPTH || !isObject(value)) return;
  for (const [k, v] of Object.entries(value))
    walkPaths(v, `${prefix}.${safeName(k)}`, depth + 1, out);
}

function reportEvent(ev: ClaimMdDeliveryEvent): ClaimMdReportEvent {
  const raw: unknown = JSON.parse(ev.element);
  const e = isObject(raw) ? raw : {};
  // `malformed` is the receiver's own verdict that the eventid was unusable (it then keys the element on its digest)
  const sentAs = ev.malformed ? "missing" : typeof e.eventid === "number" ? "number" : "string";
  const paths: Record<string, string> = {};
  if ("event_data" in e) walkPaths(e.event_data, "event_data", 1, paths);
  const data = isObject(e.event_data) ? e.event_data : {};
  const block =
    hasSweepFields(ev.eventType) && isObject(data[ev.eventType]) ? data[ev.eventType] : {};
  const expected = hasSweepFields(ev.eventType)
    ? CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.eventData[ev.eventType]
    : [];
  return {
    eventIdSentAs: sentAs,
    eventType: typeWord(ev.eventType),
    eventTypeDocumented: isDocumentedType(ev.eventType),
    eventTimeShape: shapeOf(e.event_time),
    storedAs: claimMdReceiptOutcome(ev) ?? "pending_sweep",
    keys: Object.keys(e).slice(0, MAX_LISTED).map(safeName),
    eventDataPaths: paths,
    missingSweepFields: expected.filter((f) => !(isObject(block) && f in block)),
  };
}

function signatureSection(
  capture: ClaimMdCapture,
  body: Buffer,
  key: string | null,
): ClaimMdReplayReport["signature"] {
  if (key === null) return { verdict: "not_checked", keyLength: null, alternatives: [] };
  const header = capture.headers[CLAIMMD_SIGNATURE_HEADER];
  const verdict = classifyClaimMdSignature(key, body, header);
  const refused = verdict === "mismatch" || verdict === "header_malformed";
  return {
    verdict,
    keyLength: key.length,
    alternatives: refused ? alternativeSchemes(key, body, header ?? "") : [],
  };
}

function signatureFindings(
  signature: ClaimMdReplayReport["signature"],
  accountKey: string | null,
): string[] {
  const findings: string[] = [];
  if (signature.verdict === "not_checked")
    findings.push("signature not checked: no account key was given");
  else if (signature.verdict !== "ok") {
    findings.push(
      `signature refused (${signature.verdict}): the receiver would answer 401 and store nothing`,
    );
    if (signature.alternatives.length > 0)
      findings.push(`an alternative scheme WOULD verify: ${signature.alternatives.join(", ")}`);
  }
  if (accountKey !== null && accountKey !== accountKey.trim())
    findings.push("the configured key has leading or trailing whitespace");
  if (accountKey !== null && [...accountKey].some((c) => c.charCodeAt(0) > 255))
    findings.push(
      "the configured key has characters above U+00FF, which Latin-1 signing cannot represent",
    );
  return findings;
}

/** What the receiver and the sweep would make of one captured delivery, with no field value in the answer. Throws on no input a sender can send. */
export function analyzeClaimMdCapture(input: {
  readonly capture: ClaimMdCapture;
  readonly rawBody: Buffer;
  /** The account key the receiver would hold, or null to check shape only. Never copied into the report. */
  readonly accountKey: string | null;
  readonly now: Date;
}): ClaimMdReplayReport {
  const { capture, rawBody, accountKey, now } = input;
  const signature = signatureSection(capture, rawBody, accountKey);
  const parsedJson = decodeJson(rawBody);
  const body = isObject(parsedJson) ? parsedJson : {};
  const delivery = parseClaimMdDelivery(rawBody);
  const envelope = envelopeSection(
    body,
    capture.headers["content-encoding"],
    parsedJson !== undefined,
  );
  const eventsPart = eventsSection(delivery, parsedJson !== undefined);
  // Measured against when the capture was TAKEN (a capture replayed weeks later is not a stale delivery); `now` only for a capture
  // with no receivedAt.
  const takenAt = capture.receivedAt ? new Date(capture.receivedAt) : now;
  const utcTime = {
    shape: shapeOf(body.UTCTime),
    age: ageOf(body.UTCTime, Number.isNaN(takenAt.getTime()) ? now : takenAt),
  };
  const findings = [
    ...signatureFindings(signature, accountKey),
    ...envelope.findings,
    ...eventsPart.findings,
    ...timeFindings(utcTime.age),
  ];

  return {
    capture: captureSection(capture, rawBody),
    signature,
    shape: {
      storedAs: delivery.kind === "events" ? "events" : "one_malformed_receipt",
      jsonValid: parsedJson !== undefined,
      topLevelKeys: envelope.topLevelKeys,
      unknownTopLevelKeys: envelope.unknownTopLevelKeys,
      utcTime,
      eventCount: delivery.kind === "events" ? delivery.events.length : 0,
      eventTypeCounts: eventsPart.eventTypeCounts,
      events: eventsPart.events,
    },
    findings:
      findings.length > MAX_LISTED
        ? [
            ...findings.slice(0, MAX_LISTED),
            `${findings.length - MAX_LISTED} more finding(s) not listed`,
          ]
        : findings,
  };
}

/** What the capture says about how the delivery arrived, every sender-chosen part reduced to a fixed route, a token or `<other>`. */
function captureSection(capture: ClaimMdCapture, rawBody: Buffer): ClaimMdReplayReport["capture"] {
  const usage = usageOf(capture.path);
  return {
    // the fixed route, never the captured string (a sender chooses the path, and a path can carry an identifier)
    path: usage === "other" ? "<other>" : `/api/v1/webhooks/claimmd/${usage}`,
    usage,
    bytes: rawBody.length,
    bodySha256: sha256Hex(rawBody),
    contentType: mediaTypeOf(capture.headers["content-type"]),
    contentEncoding: encodingOf(capture.headers["content-encoding"]),
    otherHeaderNames: capture.otherHeaderNames.slice(0, MAX_LISTED).map(safeName),
  };
}

/** The envelope's key names (bounded), the ones the docs do not list, and what a transport header says about reading the bytes. */
function envelopeSection(
  body: Json,
  contentEncoding: string | undefined,
  jsonValid: boolean,
): {
  readonly topLevelKeys: Readonly<Record<string, string>>;
  readonly unknownTopLevelKeys: readonly string[];
  readonly findings: readonly string[];
} {
  const findings: string[] = [];
  const encoding = encodingOf(contentEncoding);
  if (encoding !== null && encoding !== "identity")
    findings.push(
      `content-encoding ${encoding}: the receiver verifies the bytes as received and never decompresses`,
    );
  if (!jsonValid)
    findings.push("the body is not valid UTF-8 JSON: stored whole as one malformed receipt");
  const known = CLAIMMD_WEBHOOK_FIELDS_UNVERIFIED.envelope as readonly string[];
  const unknown = Object.keys(body).filter((k) => !known.includes(k));
  findings.push(...unknown.slice(0, MAX_LISTED).map((k) => `unknown top-level key ${safeName(k)}`));
  return {
    // entries, not assignment: a key named `__proto__` is data here, never the prototype
    topLevelKeys: Object.fromEntries(
      Object.entries(body)
        .slice(0, MAX_LISTED)
        .map(([k, v]) => [safeName(k), jsonType(v)]),
    ),
    unknownTopLevelKeys: unknown.slice(0, MAX_LISTED).map(safeName),
    findings,
  };
}

function timeFindings(age: string): string[] {
  if (age === "older_than_the_4_day_retry_window")
    return [
      "UTCTime is older than Claim.MD's retry window when the delivery arrived: a replayed delivery, or a clock that is not UTC (diagnostic only; the receiver never refuses on time)",
    ];
  if (age === "in_the_future")
    return [
      "UTCTime is ahead of when the delivery arrived: a clock that is not UTC, or a different time zone (diagnostic only)",
    ];
  return [];
}

/** The events of a split delivery: counts by (bounded) type word, the first ten described, and what is off about them. */
function eventsSection(
  delivery: ReturnType<typeof parseClaimMdDelivery>,
  jsonValid: boolean,
): {
  readonly events: readonly ClaimMdReportEvent[];
  readonly eventTypeCounts: Readonly<Record<string, number>>;
  readonly findings: readonly string[];
} {
  if (delivery.kind === "unsplittable") {
    return {
      events: [],
      eventTypeCounts: {},
      findings: jsonValid
        ? [
            `the body cannot be split into events (acct_number missing or invalid, events not a list of 1..${CLAIMMD_MAX_SPLIT_EVENTS}, or an element nested too deeply to serialise): stored whole as one malformed receipt`,
          ]
        : [],
    };
  }
  const findings: string[] = [];
  // a Map: a vendor-chosen word such as `constructor` must not read an inherited property
  const counts = new Map<string, number>();
  const unlisted = new Map<string, number>();
  for (const ev of delivery.events) {
    const word = typeWord(ev.eventType) ?? "<none>";
    counts.set(word, (counts.get(word) ?? 0) + 1);
    // an event stored `malformed` is terminal at ingest and never reaches the sweep, so only the others are "unsupported"
    if (!ev.malformed && !isDocumentedType(ev.eventType))
      unlisted.set(word, (unlisted.get(word) ?? 0) + 1);
  }
  const events = delivery.events.slice(0, MAX_REPORTED_EVENTS).map(reportEvent);
  const noId = delivery.events.filter((e) => e.malformed).length;
  if (noId > 0)
    findings.push(
      `${noId} event(s) carry no usable eventid: keyed on their digest and stored as malformed`,
    );
  for (const [word, count] of [...unlisted].slice(0, MAX_LISTED))
    findings.push(
      `${count} event(s) of type ${word}, not one the docs list: the sweep settles it as unsupported_type`,
    );
  for (const ev of events) {
    if (ev.missingSweepFields.length > 0)
      findings.push(
        `an event of type ${ev.eventType} lacks ${ev.missingSweepFields.join(", ")}, which the sweep reads`,
      );
  }
  return {
    events,
    eventTypeCounts: Object.fromEntries([...counts].slice(0, MAX_LISTED)),
    findings,
  };
}

/** The report as plain text for a terminal. */
export function renderClaimMdReplayReport(report: ClaimMdReplayReport): string {
  const { capture, signature, shape } = report;
  const types = Object.entries(shape.eventTypeCounts)
    .map(([word, n]) => `${word}×${n}`)
    .join(", ");
  const lines = [
    `posted to the ${capture.usage} path, ${capture.bytes} bytes, sha256 ${capture.bodySha256}`,
    `signature: ${signature.verdict}${signature.keyLength === null ? "" : ` (key length ${signature.keyLength})`}`,
    `stored as: ${shape.storedAs}, ${shape.eventCount} event(s), UTCTime ${shape.utcTime.shape ?? "n/a"} (${shape.utcTime.age})`,
    `event types: ${types || "none"}`,
  ];
  for (const [i, ev] of shape.events.entries()) {
    lines.push(
      `  event ${i + 1}: id ${ev.eventIdSentAs}, type ${ev.eventType ?? "none"}, time ${ev.eventTimeShape ?? "n/a"}, ${ev.storedAs}, keys ${ev.keys.join("/")}`,
      ...Object.entries(ev.eventDataPaths).map(([p, t]) => `    ${p}: ${t}`),
    );
  }
  lines.push(
    report.findings.length === 0 ? "findings: none" : "findings:",
    ...report.findings.map((f) => `  - ${f}`),
  );
  return lines.join("\n");
}
