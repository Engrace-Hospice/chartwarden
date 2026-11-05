// @chartwarden/x12-837-client — Claim.MD webhook helpers (ADR-0053 amendment, webhook section). PURE: no I/O, no clock.
//
// Claim.MD pushes enrollment and appeal reports (https://api.claim.md/, Webhook Events, read 2026-11-05):
//   - header `Auth-Signature-Base64` = base64(HMAC-SHA256(key = the account API key used directly, message = the exact raw
//     body bytes)); absent when the account has no active key, so an unsigned delivery is always refused;
//   - body {UTCTime, acct_number, remote_acct_number?, events: [{eventid, event_type, event_time, event_data}]}, 1..100
//     events; delivery is at least once, deduped on (acct_number, eventid).
// The HMAC runs over the bytes as received (a Buffer), never over a decoded or re-serialised string. After a valid
// signature the ingress never refuses on content: `parseClaimMdDelivery` always yields something storable.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** The header, lower-cased as Node exposes it. */
export const CLAIMMD_SIGNATURE_HEADER = "auth-signature-base64";
/** Longest eventid kept as given; anything longer is keyed on the element digest instead. */
export const CLAIMMD_EVENT_ID_MAX = 128;

const SIGNATURE_RE = /^[A-Za-z0-9+/]{43}=$/;
const SHA256_BYTES = 32;
const ACCOUNT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const EVENT_ID_RE = /^[\x21-\x7e]+$/;
const EVENT_TYPE_RE = /^[a-z0-9_.-]{1,64}$/i;
const EVENT_TIME_MAX = 64;

/**
 * True only when `header` is one canonical base64 SHA-256 HMAC of `rawBody` under the key's Latin-1 bytes. A missing or
 * repeated header, a wrong length, padding or alphabet, and a non-canonical encoding are all refusals.
 */
export function verifyClaimMdSignature(
  accountKey: string,
  rawBody: Uint8Array,
  header: unknown,
): boolean {
  if (accountKey.length === 0 || typeof header !== "string" || !SIGNATURE_RE.test(header))
    return false;
  const given = Buffer.from(header, "base64");
  if (given.length !== SHA256_BYTES || given.toString("base64") !== header) return false;
  const expected = createHmac("sha256", Buffer.from(accountKey, "latin1")).update(rawBody).digest();
  return timingSafeEqual(given, expected);
}

/** One event element, ready to store. `element` is the element's JSON (encrypted at rest by the caller). */
export interface ClaimMdDeliveryEvent {
  /** The vendor eventid as a string, or `x:<sha256(element)>` when it has none usable. */
  readonly eventId: string;
  /** Bounded vendor event type (`enroll`, `appeal`, `test`, or a type the docs do not list); null when unusable. */
  readonly eventType: string | null;
  /** The vendor's event_time text, bounded; its format is not documented. */
  readonly eventTime: string | null;
  readonly malformed: boolean;
  readonly element: string;
}

export type ClaimMdDelivery =
  | {
      readonly kind: "events";
      readonly acctNumber: string;
      readonly remoteAcctNumber: string | null;
      readonly events: readonly ClaimMdDeliveryEvent[];
    }
  /** Signed but not splittable into events: stored whole as one malformed receipt keyed `body:<bodySha256>`. */
  | {
      readonly kind: "unsplittable";
      readonly acctNumber: string | null;
      readonly bodySha256: string;
    };

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const sha256 = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

function idText(v: unknown): string | null {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  return typeof v === "string" && v.length <= CLAIMMD_EVENT_ID_MAX && EVENT_ID_RE.test(v)
    ? v
    : null;
}

function accountOf(v: unknown): string | null {
  const text = typeof v === "number" ? idText(v) : v;
  return typeof text === "string" && ACCOUNT_RE.test(text) ? text : null;
}

function eventOf(raw: unknown): ClaimMdDeliveryEvent {
  const element = JSON.stringify(raw) ?? "null";
  const e = isObject(raw) ? raw : {};
  const id = idText(e.eventid);
  const type =
    typeof e.event_type === "string" && EVENT_TYPE_RE.test(e.event_type) ? e.event_type : null;
  const time =
    typeof e.event_time === "string" && e.event_time.length <= EVENT_TIME_MAX ? e.event_time : null;
  return {
    eventId: id ?? `x:${sha256(element)}`,
    eventType: type,
    eventTime: time,
    malformed: id === null || !isObject(raw),
    element,
  };
}

function decodeJson(rawBody: Uint8Array): unknown {
  try {
    // fatal: invalid UTF-8 is not silently replaced; a leading BOM is dropped (ignoreBOM defaults to false).
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody));
  } catch {
    return undefined;
  }
}

/** Split a signed delivery into storable events. Never throws. */
export function parseClaimMdDelivery(rawBody: Uint8Array): ClaimMdDelivery {
  const parsed = decodeJson(rawBody);
  const body = isObject(parsed) ? parsed : {};
  const acctNumber = accountOf(body.acct_number);
  const events = body.events;
  if (acctNumber === null || !Array.isArray(events) || events.length === 0) {
    return { kind: "unsplittable", acctNumber, bodySha256: sha256(rawBody) };
  }
  return {
    kind: "events",
    acctNumber,
    remoteAcctNumber: accountOf(body.remote_acct_number),
    events: events.map(eventOf),
  };
}
