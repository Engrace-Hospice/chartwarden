// @chartwarden/shared - E.164 normalisation for a number a machine is going to DIAL (GAP-032: the SOS terminus
// calls a clinician's consented emergency contact). Backed by libphonenumber-js (registry before hand-rolled).
//
// The failure result carries a closed reason code and NEVER the input: the number is a third party's
// personal detail and must not reach a thrown message or a log line through this function.
import type { CountryCode } from "libphonenumber-js";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

export type E164Result =
  | { readonly ok: true; readonly e164: string }
  | { readonly ok: false; readonly reason: "invalid" | "extension" | "not_dialable" };

/** Number types a person can plausibly answer. Premium-rate, toll-free, shared-cost, pagers etc. are not. */
const DIALABLE_TYPES: ReadonlySet<string | undefined> = new Set([
  "MOBILE",
  "FIXED_LINE",
  "FIXED_LINE_OR_MOBILE",
  "VOIP",
]);

/** Normalise `raw` to E.164 or say why not. Emergency/short codes and extensions are refused. */
export function normalizeE164(raw: string, defaultRegion: CountryCode): E164Result {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "invalid" };
  const parsed = parsePhoneNumberFromString(raw, defaultRegion);
  if (parsed === undefined) return { ok: false, reason: "invalid" };
  if (parsed.ext !== undefined) return { ok: false, reason: "extension" };
  if (!parsed.isValid()) return { ok: false, reason: "invalid" };
  if (!DIALABLE_TYPES.has(parsed.getType())) return { ok: false, reason: "not_dialable" };
  return { ok: true, e164: parsed.number };
}
