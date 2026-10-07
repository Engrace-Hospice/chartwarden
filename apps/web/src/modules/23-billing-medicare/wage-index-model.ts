// apps/web/src/modules/23-billing-medicare — the pure pieces of the Wage Index screen (GAP-125, F-211): the wire
// shapes (aliases into the generated client, never hand-copied), the client-side mirrors of the server's field
// patterns (so a malformed value is explained before it is sent, never instead of the server's check), and the
// standard error envelope → copy mapping.
import type { operations } from "@wardenx/ui";

type Json<T> = T extends { content: { "application/json": infer B } } ? B : never;
type Ok200<Op> = Op extends { responses: { 200: infer R } } ? Json<R> : never;
type ReqBody<Op> = Op extends { requestBody?: infer RB } ? Json<RB> : never;

export type WageIndexView = Ok200<operations["getApiV1BillingWageindexes"]>["wageIndexes"][number];
export type WageIndexBody = ReqBody<operations["postApiV1BillingWageindexes"]>;

/** Server pattern `^[0-9A-Za-z]{6}$` (wage-index-typebox.ts). */
const CCN = /^[0-9A-Za-z]{6}$/;
/** Server pattern `^\d(\.\d{1,4})?$` — the factor is a decimal STRING, never a float. */
const FACTOR = /^\d(\.\d{1,4})?$/;
/** Server pattern `^[0-9]{5}$`. */
const CBSA = /^[0-9]{5}$/;
const SOURCE_MAX = 500;

export interface WageIndexDraft {
  readonly ccn: string;
  readonly cbsaCode: string;
  readonly factorDecimal: string;
  readonly sourceReference: string;
  readonly entryReason: string;
}

export const EMPTY_DRAFT: WageIndexDraft = {
  ccn: "",
  cbsaCode: "",
  factorDecimal: "",
  sourceReference: "",
  entryReason: "",
};

export function draftFrom(v: WageIndexView): WageIndexDraft {
  return {
    ccn: v.ccn,
    cbsaCode: v.cbsaCode ?? "",
    factorDecimal: v.factorDecimal,
    sourceReference: v.sourceReference,
    entryReason: "",
  };
}

export type DraftErrors = Partial<Record<keyof WageIndexDraft, string>>;

export function validateDraft(d: WageIndexDraft): DraftErrors {
  const errors: { -readonly [K in keyof WageIndexDraft]?: string } = {};
  if (!CCN.test(d.ccn.trim())) errors.ccn = "Six letters or digits, e.g. 381588.";
  if (d.cbsaCode.trim() && !CBSA.test(d.cbsaCode.trim()))
    errors.cbsaCode = "Five digits, e.g. 38900.";
  if (!FACTOR.test(d.factorDecimal.trim()))
    errors.factorDecimal = "A decimal with at most four decimal places, e.g. 1.0342.";
  if (!d.sourceReference.trim()) errors.sourceReference = "Say where the value was keyed from.";
  else if (d.sourceReference.trim().length > SOURCE_MAX)
    errors.sourceReference = `At most ${SOURCE_MAX} characters.`;
  return errors;
}

export function bodyFrom(d: WageIndexDraft, fiscalYearStarting: number): WageIndexBody {
  return {
    ccn: d.ccn.trim().toUpperCase(),
    fiscalYearStarting,
    factorDecimal: d.factorDecimal.trim(),
    sourceReference: d.sourceReference.trim(),
    ...(d.cbsaCode.trim() ? { cbsaCode: d.cbsaCode.trim() } : {}),
    ...(d.entryReason.trim() ? { entryReason: d.entryReason.trim() } : {}),
  };
}

/** The standard error envelope (`{ error: { code, message } }`) → what an administrator does next. */
export function wageIndexWriteError(status: number | undefined, body: unknown): string {
  const message = (body as { error?: { message?: unknown } } | undefined)?.error?.message;
  const detail = typeof message === "string" && message.length > 0 ? message : null;
  if (status === 409)
    return "A live wage index already exists for this CCN and fiscal year, or this one was already superseded — supersede the live value instead.";
  if (status === 422) return detail ?? "The server rejected the wage index as invalid.";
  if (status === 403)
    return "Not permitted — entering a wage index needs billing.wage_index.admin (and is never done by an AI agent).";
  if (status === 404) return "That wage-index value is no longer available.";
  return detail ?? "The wage index could not be saved.";
}

export function wageIndexReadError(status: number | undefined): string {
  return status === 403
    ? "You lack billing.wage_index.read, so the wage indexes cannot be shown."
    : "The wage indexes could not be loaded.";
}
