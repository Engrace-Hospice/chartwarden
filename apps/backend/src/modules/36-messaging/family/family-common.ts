// M36 WP 6.7 (ADR-0099) - small helpers shared by the staff and the contact service: the budgets' port, the flag reader's port, the uniform refusal and the one
// validation of message text. Nothing here touches the database.
import {
  FAMILY_MESSAGE_MAX_CHARS,
  NotFoundError,
  RateLimitedError,
  ValidationError,
} from "@chartwarden/types";

export interface AttemptLimiter {
  consume(key: string): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export interface FamilyFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ONE refusal a contact can cause: unknown, expired, revoked, locked, wrong stage, flag off, wrong tenant, bad token, ineligible (D12). */
export const familyNotFound = (): NotFoundError => new NotFoundError("link");

export function invalid(field: string, message: string): never {
  throw new ValidationError("request validation failed", [{ field, code: "INVALID", message }]);
}

/** Spend one unit of a budget BEFORE any database work: a flood costs a counter increment, not a query. */
export async function spend(
  limiter: AttemptLimiter | undefined,
  key: string,
  what: string,
): Promise<void> {
  const verdict = await limiter?.consume(key);
  if (verdict && !verdict.allowed) throw new RateLimitedError(`too many ${what}`);
}

// Control characters other than tab and newline never belong in a message and make it easy to hide text from a reviewer.
// biome-ignore lint/suspicious/noControlCharactersInRegex: this IS the control-character test.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Text only: NFC-normalised, trimmed, 1..2,000 characters (code points), no control characters. A staff reply obeys the same bounds. */
export function validateMessageText(raw: unknown, field = "body"): string {
  if (typeof raw !== "string") invalid(field, "a text message");
  const text = (raw as string).normalize("NFC").trim();
  const length = [...text].length;
  if (length < 1) invalid(field, "a message cannot be empty");
  if (length > FAMILY_MESSAGE_MAX_CHARS) {
    invalid(field, `a message is at most ${FAMILY_MESSAGE_MAX_CHARS} characters`);
  }
  if (CONTROL_RE.test(text)) invalid(field, "a message holds text only");
  return text;
}
