// @chartwarden/x12-837-client — the Claim.MD wire: form posts to https://svc.claim.md/services/<name>/ and a tolerant
// reader for the JSON they answer (contract: docs/audits/clearinghouse-integration/CLAIMMD_TRANSPORT_CONTRACT_20261104.md).
//
// Claim.MD documents its answers as XML attributes (`<result last_responseid="…"><claim pcn="…">…`). With
// `Accept: application/json` the same attributes come back as JSON keys; whether they sit at the top level or under a
// `result` object, and whether a single child is an object or a one-element array, is read defensively here so the
// transport never depends on it. The shapes seen in the sandbox (2026-11-04/05) are recorded in the contract doc.
//
// Nothing here logs, and nothing returned carries the account key or vendor message text.

import { tokenizeInterchange } from "../eligibility/x12-envelope";
import { ClaimMdBudgetExhausted } from "./claimmd-rate-limit";

const INVALID_KEY_CODE = "21";
/** Observed 2026-11-05 (as a number): "File 'x' is a duplicate of 'x'. Processing Aborted!" for a repeated Filename. */
export const DUPLICATE_FILE_CODE = "61";

export const CLAIMMD_BASE_URL = "https://svc.claim.md/services";
const REQUEST_TIMEOUT_MS = 30_000;
/** Codes reported in a reason: short and code-shaped only, never message text. */
const SAFE_CODE = /^[A-Za-z0-9_.:-]{1,24}$/;
const MAX_REPORTED_CODES = 5;

export type ClaimMdRecord = Readonly<Record<string, unknown>>;

export type WireResult =
  | { readonly ok: true; readonly body: ClaimMdRecord }
  /** `reached`: the request left and may have been processed (timeout, network error, 5xx). */
  | { readonly ok: false; readonly status: number | null; readonly reached: boolean };

function isRecord(v: unknown): v is ClaimMdRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

async function readBody(res: Response): Promise<ClaimMdRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function call(
  fetchImpl: typeof fetch,
  path: string,
  body: URLSearchParams | FormData,
): Promise<WireResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${CLAIMMD_BASE_URL}/${path}/`, {
      method: "POST",
      headers: { Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A 30x must never turn the POST into a GET or follow to another origin.
      redirect: "error",
    });
  } catch (err) {
    // Refused by our own rate budget (claimmd-rate-limit.ts): it never left, so it is plainly retryable.
    return { ok: false, status: null, reached: !(err instanceof ClaimMdBudgetExhausted) };
  }
  // Every 5xx may follow processing (a 502/503 can be a gateway in front of a service that already filed the upload), so
  // it counts as reached and an upload is then in doubt. A 4xx (the 403 rate block included) is a refusal before work.
  if (!res.ok) return { ok: false, status: res.status, reached: res.status >= 500 };
  const parsed = await readBody(res);
  // A 2xx we cannot read may still have been processed (an upload): treat it as reached, never as clean.
  return parsed ? { ok: true, body: parsed } : { ok: false, status: res.status, reached: true };
}

/** A urlencoded service call. The key travels in the body, as Claim.MD requires; never in a URL. */
export function postForm(
  fetchImpl: typeof fetch,
  path: string,
  accountKey: string,
  fields: Readonly<Record<string, string>>,
): Promise<WireResult> {
  return call(fetchImpl, path, new URLSearchParams({ AccountKey: accountKey, ...fields }));
}

/** `/services/upload/`: one file (X12 or Claim.MD JSON) as multipart, with an explicit Filename (our reconciliation handle). */
export function postUpload(
  fetchImpl: typeof fetch,
  accountKey: string,
  filename: string,
  contents: string,
): Promise<WireResult> {
  const form = new FormData();
  form.set("AccountKey", accountKey);
  form.set("Filename", filename);
  form.set("File", new Blob([contents], { type: "text/plain" }), filename);
  return call(fetchImpl, "upload", form);
}

/** The children named `name`, at the top level or under `result`; a single object is a one-element list. */
export function listOf(body: ClaimMdRecord, name: string): readonly ClaimMdRecord[] {
  const result = isRecord(body.result) ? body.result : null;
  const raw = body[name] ?? result?.[name];
  if (Array.isArray(raw)) return raw.filter(isRecord);
  return isRecord(raw) ? [raw] : [];
}

/**
 * True when the answer is positive evidence of a list: it carries a `name` element (even empty), or it is the bare `{}`
 * Claim.MD answers when there is nothing (observed 2026-11-05 for an empty `uploadlist` day and an empty `response`).
 * Any other shape without the element is unknown, never "empty".
 */
export function hasList(body: ClaimMdRecord, name: string): boolean {
  if (Object.keys(body).length === 0) return true;
  const result = isRecord(body.result) ? body.result : null;
  return name in body || (result !== null && name in result);
}

export type RawFiles =
  | { readonly ok: true; readonly files: readonly string[] }
  /** `elements`: how many elements the attribute held when it was an array (for an operator anomaly), else null. */
  | { readonly ok: false; readonly elements: number | null };

/** One whole interchange: tokenizes, opens with the only ISA, closes with the only IEA, and IEA02 == ISA13. */
function isOneInterchange(x12: string): boolean {
  try {
    const { segments } = tokenizeInterchange(x12);
    const ids = segments.map((s) => s[0]?.trim());
    const isa = segments[0];
    const iea = segments.at(-1);
    return (
      ids[0] === "ISA" &&
      ids.at(-1) === "IEA" &&
      ids.filter((id) => id === "ISA" || id === "IEA").length === 2 &&
      !!isa?.[13] &&
      iea?.[2] === isa[13]
    );
  } catch {
    return false;
  }
}

/**
 * The files in a file attribute, each exactly as sent (no trim): an 835 must stay byte-for-byte. Observed 2026-11-05:
 * `era835` answers `data` as a one-element array holding the whole interchange; a plain string is accepted too. How many
 * elements the array can hold is unobserved, so several are read only where the X12 itself settles it: every element a
 * whole interchange (one file each, in order), or the elements joined in order forming exactly one interchange
 * (fragments). Anything else (empty or non-string elements, a mix) is not ok, so the caller fails closed.
 */
export function rawFiles(body: ClaimMdRecord, name: string): RawFiles {
  const result = isRecord(body.result) ? body.result : null;
  const raw = body[name] ?? result?.[name];
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
  if (!Array.isArray(raw)) return nonEmpty(raw) ? { ok: true, files: [raw] } : { ok: false, elements: null };
  const fail = { ok: false, elements: raw.length } as const;
  if (raw.length === 0 || !raw.every(nonEmpty)) return fail;
  if (raw.length === 1 || raw.every(isOneInterchange)) return { ok: true, files: raw };
  const joined = raw.join("");
  return isOneInterchange(joined) ? { ok: true, files: [joined] } : fail;
}

/** A scalar attribute at the top level or under `result`. */
export function topAttr(body: ClaimMdRecord, name: string): string | undefined {
  const result = isRecord(body.result) ? body.result : null;
  return str(body[name] ?? result?.[name]);
}

export function str(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** Code-shaped values only, deduplicated, capped. */
export function safeCodes(values: readonly (string | undefined)[]): string[] {
  const out = values.filter((v): v is string => typeof v === "string" && SAFE_CODE.test(v));
  return [...new Set(out)].slice(0, MAX_REPORTED_CODES);
}

export interface VendorError {
  readonly codes: readonly string[];
  /** True when Claim.MD says the account key is invalid (matched on its message, which is never returned). */
  readonly credential: boolean;
}

/** The `error` elements of a 2xx answer, reduced to codes. Null when there are none. */
export function vendorError(body: ClaimMdRecord): VendorError | null {
  const errors = listOf(body, "error");
  if (errors.length === 0) return null;
  const messages = errors.map((e) => str(e.error_mesg) ?? str(e.message) ?? "");
  const codes = safeCodes(errors.map((e) => str(e.error_code) ?? str(e.code)));
  return {
    codes,
    // Observed 2026-11-04: a bad key answers HTTP 200 {"error":{"error_code":"21","error_mesg":"Invalid AccountKey."}}.
    credential: codes.includes(INVALID_KEY_CODE) || messages.some((m) => /account\s*key|api\s*key/i.test(m)),
  };
}

/**
 * The day of a Claim.MD timestamp as YYYY-MM-DD, or null. Accepts the two documented shapes, `2022-09-01 11:34:59am`
 * and `09-06-2022 13:07`. The time is dropped on purpose: it is account-local and Claim.MD states no zone.
 */
export function claimMdDay(value: string | undefined): string | null {
  const iso = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]|$)/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = value?.match(/^(\d{2})-(\d{2})-(\d{4})(?:[ T]|$)/);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : null;
}
