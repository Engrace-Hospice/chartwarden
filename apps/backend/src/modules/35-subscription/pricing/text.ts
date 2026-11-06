// apps/backend/src/modules/35-subscription/pricing/text.ts — the free text an operator types onto a pricing write (a reason).
// Control characters are stripped (NUL is refused: Postgres text cannot hold it), the result is trimmed and bounded, and text that
// looks like a patient identifier (an SSN or MBI) is refused without echoing it: a reason names a decision, never a patient.
import { ChartWardenError } from "@chartwarden/types";

export const REASON_MIN = 8;
export const REASON_MAX = 500;

/** Every control character (\p{Cc}) except tab and newline. */
const STRIPPED_CONTROL = /[^\P{Cc}\t\n]/gu;
// The same screen M34's onboarding wizard applies to its free text (onboarding/phi-screen.ts; M35 may not import M34): a
// best-effort guard against an accident, erring on the side of refusing (a nine-digit ticket number is refused too).
const SSN = /(?<!\d)\d{3}[\s.-]?\d{2}[\s.-]?\d{4}(?!\d)/u;
const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
const MBI_WINDOW = new RegExp(
  `[1-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9]{2}`,
  "i",
);
const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "");
const looksLikePatientIdentifier = (text: string): boolean =>
  SSN.test(fold(text)) || MBI_WINDOW.test(fold(text).replace(/[^A-Za-z0-9]/g, ""));

const refuse = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 422, [{ field: "reason", code, message }]);

const clean = (raw: string): string =>
  raw.replace(STRIPPED_CONTROL, "").replace(/\s+/g, " ").trim();

export function normalizeReason(raw: unknown): string {
  if (typeof raw !== "string") throw refuse("REASON_REQUIRED", "a reason is required");
  if (raw.includes("\u0000"))
    throw refuse("REASON_INVALID", "reason must not contain NUL characters");
  const text = clean(raw);
  if (text.length < REASON_MIN || text.length > REASON_MAX) {
    throw refuse(
      "REASON_REQUIRED",
      `a reason of ${REASON_MIN} to ${REASON_MAX} characters is required`,
    );
  }
  if (looksLikePatientIdentifier(text)) {
    throw refuse(
      "REASON_LOOKS_LIKE_PHI",
      "reason looks like it contains a patient identifier; describe the decision without naming a patient",
    );
  }
  return text;
}

/** An optional operator-typed reference (an order form id): cleaned, bounded, never a patient identifier. null when blank. */
export function normalizeOptionalRef(field: string, raw: unknown, max: number): string | null {
  if (raw === undefined || raw === null) return null;
  const fail = (code: string, message: string): ChartWardenError =>
    new ChartWardenError(code, message, 422, [{ field, code, message }]);
  if (typeof raw !== "string") throw fail("REF_INVALID", `${field} must be text`);
  if (raw.includes("\u0000")) throw fail("REF_INVALID", `${field} must not contain NUL characters`);
  const text = clean(raw);
  if (text.length === 0) return null;
  if (text.length > max) throw fail("REF_INVALID", `${field} must be at most ${max} characters`);
  if (looksLikePatientIdentifier(text)) {
    throw fail("REF_LOOKS_LIKE_PHI", `${field} looks like it contains a patient identifier`);
  }
  return text;
}
