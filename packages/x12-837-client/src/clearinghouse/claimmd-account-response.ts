// Account-wide Claim.MD response reader for BIL-1.1. No tenant/provider filters and no billing state mapping.
import { createHash } from "node:crypto";
import { type ClaimMdRequestCounter, budgetedFetch } from "./claimmd-rate-limit";
import { parseClaimMdResponseXml } from "./claimmd-response-xml";
import { type ClaimMdRecord, postFormText, str, topAttr, vendorError } from "./claimmd-wire";

export type ClaimMdUsage = "test" | "production";
const CURSOR = /^[0-9]{1,30}$/;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PARENTS = 20_000;
const MAX_EVENTS = 200_000;
export interface CapturedResponseEvent {
  readonly responseId: string | null;
  readonly parentIndex: number;
  readonly messageIndex: number;
  readonly digest: string;
  readonly state: "captured" | "needs_review" | "malformed";
}
export interface AccountResponsePage {
  readonly afterCursor: string;
  readonly nextCursor: string;
  readonly body: ClaimMdRecord;
  readonly rawPayload: string;
  readonly sourceFormat: "json" | "xml";
  readonly digest: string;
  readonly parentCount: number;
  readonly events: readonly CapturedResponseEvent[];
  readonly full: boolean;
}
export type AccountResponseRead =
  | { readonly ok: true; readonly page: AccountResponsePage }
  | {
      readonly ok: false;
      readonly code:
        | "BAD_CURSOR"
        | "TRANSPORT"
        | "CREDENTIAL"
        | "BUSINESS_ERROR"
        | "BAD_ENVELOPE"
        | "OVERSIZE"
        | "CURSOR_REGRESSION";
    };

const CAPTURE_ENVELOPE = "claimmd-response-capture.v1";

/** Decode new encrypted source envelopes and legacy encrypted JSON-page payloads. */
export function decodeClaimMdCapturedPayload(payload: string): ClaimMdRecord | null {
  try {
    const decoded: unknown = JSON.parse(payload);
    if (record(decoded) && decoded.format === CAPTURE_ENVELOPE) {
      if (typeof decoded.rawPayload !== "string") return null;
      if (decoded.sourceFormat === "json") {
        const body: unknown = JSON.parse(decoded.rawPayload);
        return record(body) ? body : null;
      }
      if (decoded.sourceFormat === "xml") return parseClaimMdResponseXml(decoded.rawPayload);
      return null;
    }
    return record(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export function encodeClaimMdCapturedPayload(input: {
  readonly rawPayload: string;
  readonly sourceFormat: "json" | "xml";
}): string {
  return JSON.stringify({ format: CAPTURE_ENVELOPE, ...input });
}

const record = (x: unknown): x is ClaimMdRecord =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const children = (x: unknown): unknown[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const container = (body: ClaimMdRecord): ClaimMdRecord =>
  record(body.result) ? body.result : body;

/** Pure normalization: even primitive/missing-message parents become durable review events. */
export function captureAccountResponsePage(
  body: ClaimMdRecord,
  afterCursor: string,
  source?: { readonly rawPayload: string; readonly sourceFormat: "json" | "xml" },
): AccountResponseRead {
  if (!CURSOR.test(afterCursor)) return { ok: false, code: "BAD_CURSOR" };
  const root = container(body);
  const raw = root.claim;
  if (
    raw === undefined &&
    Object.keys(body).length !== 0 &&
    !("claim" in body) &&
    !("claim" in root)
  )
    return { ok: false, code: "BAD_ENVELOPE" };
  const parents = children(raw);
  if (parents.length > MAX_PARENTS) return { ok: false, code: "OVERSIZE" };
  const last = topAttr(body, "last_responseid");
  if (!last && parents.length > 0) return { ok: false, code: "BAD_ENVELOPE" };
  if (last && (!CURSOR.test(last) || BigInt(last) < BigInt(afterCursor)))
    return { ok: false, code: "CURSOR_REGRESSION" };
  const nextCursor = last ?? afterCursor;
  const events: CapturedResponseEvent[] = [];
  for (let parentIndex = 0; parentIndex < parents.length; parentIndex++) {
    const parent = parents[parentIndex];
    const messages = record(parent) ? children(parent.messages) : [];
    const selected =
      messages.length === 0
        ? [{ value: null, index: -1 }]
        : messages.map((value, index) => ({ value, index }));
    for (const { value, index } of selected) {
      if (events.length >= MAX_EVENTS) return { ok: false, code: "OVERSIZE" };
      const id = record(value) ? str(value.responseid) : undefined;
      const validId = id && CURSOR.test(id) ? id : null;
      // An ID beyond the returned watermark means this page cannot safely move its cursor.
      if (validId && BigInt(validId) > BigInt(nextCursor))
        return { ok: false, code: "BAD_ENVELOPE" };
      const messageStatus = record(value) ? str(value.status)?.toUpperCase() : undefined;
      const sender = record(parent) ? str(parent.senderid) : undefined;
      const state =
        !record(parent) || (value !== null && !record(value))
          ? "malformed"
          : !validId ||
              !str(parent.bill_npi) ||
              !str(parent.pcn) ||
              !["A", "R"].includes(str(parent.status)?.toUpperCase() ?? "") ||
              !sender ||
              (messageStatus !== undefined && !["A", "R"].includes(messageStatus))
            ? "needs_review"
            : "captured";
      events.push({
        responseId: validId,
        parentIndex,
        messageIndex: index,
        digest: digest([parent, value]),
        state,
      });
    }
  }
  const rawPayload = source?.rawPayload ?? JSON.stringify(body);
  if (Buffer.byteLength(rawPayload, "utf8") > MAX_BODY_BYTES)
    return { ok: false, code: "OVERSIZE" };
  return {
    ok: true,
    page: {
      afterCursor,
      nextCursor,
      body,
      rawPayload,
      sourceFormat: source?.sourceFormat ?? "json",
      digest: createHash("sha256").update(rawPayload, "utf8").digest("hex"),
      parentCount: parents.length,
      events,
      full: parents.length === MAX_PARENTS,
    },
  };
}

/** Caller must inject the *same distributed counter* used by outbound Claim.MD traffic. */
export function createClaimMdAccountResponseReader(input: {
  /** External accounts are explicit and keyed by a stable non-secret internal reference. */
  readonly accounts: Readonly<Record<string, Readonly<Partial<Record<ClaimMdUsage, string>>>>>;
  readonly counter: ClaimMdRequestCounter;
  readonly fetch?: typeof fetch;
}) {
  const keyUsage = new Map<string, ClaimMdUsage>();
  for (const keys of Object.values(input.accounts))
    for (const [usage, key] of Object.entries(keys))
      if (key) keyUsage.set(key, usage as ClaimMdUsage);
  const guarded = budgetedFetch(input.fetch ?? fetch, input.counter, (init) => {
    const body = init?.body;
    const key = body instanceof URLSearchParams ? body.get("AccountKey") : null;
    return typeof key === "string" ? keyUsage.get(key) : undefined;
  });
  return {
    async fetchAccountResponses(
      accountReference: string,
      usage: ClaimMdUsage,
      afterCursor: string,
    ): Promise<AccountResponseRead> {
      if (!CURSOR.test(afterCursor)) return { ok: false, code: "BAD_CURSOR" };
      const key = input.accounts[accountReference]?.[usage];
      if (!key) return { ok: false, code: "CREDENTIAL" };
      const wire = await postFormText(guarded, "response", key, { ResponseID: afterCursor });
      if (!wire.ok)
        return {
          ok: false,
          code:
            wire.code === "OVERSIZE"
              ? "OVERSIZE"
              : wire.code === "INVALID_UTF8"
                ? "BAD_ENVELOPE"
                : "TRANSPORT",
        };
      if (Buffer.byteLength(wire.body, "utf8") > MAX_BODY_BYTES)
        return { ok: false, code: "OVERSIZE" };
      const isXml =
        wire.contentType?.toLowerCase().includes("xml") || wire.body.trimStart().startsWith("<");
      let body: ClaimMdRecord | null = null;
      if (isXml) body = parseClaimMdResponseXml(wire.body);
      else {
        try {
          const parsed: unknown = JSON.parse(wire.body);
          body = record(parsed) ? parsed : null;
        } catch {
          body = null;
        }
      }
      if (!body) return { ok: false, code: "BAD_ENVELOPE" };
      if (vendorError(body)) return { ok: false, code: "BUSINESS_ERROR" };
      return captureAccountResponsePage(body, afterCursor, {
        rawPayload: wire.body,
        sourceFormat: isXml ? "xml" : "json",
      });
    },
  };
}
