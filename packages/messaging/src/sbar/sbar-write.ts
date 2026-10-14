// @wardenx/messaging - the pure write-time SBAR gate (M36 WP 3.3), shared by the Drizzle service (policy read inside its
// transaction) and the in-memory twin. A body without an sbar block passes untouched. Never echoes message text.
import {
  type EffectiveSbarPolicy,
  type RichBody,
  WardenXError,
  richBodySbar,
  validateSbar,
} from "@wardenx/types";
import { SBAR_DENIED_CHANNEL_KINDS } from "./sbar-policy";

export const sbarNotAllowedInChannel = (): WardenXError =>
  new WardenXError(
    "SBAR_NOT_ALLOWED_IN_CHANNEL",
    "SBAR messages cannot be sent in this conversation.",
    422,
  );

/** True when the body is an SBAR message (the caller then needs the tenant policy). */
export const isSbarBody = (richBody: RichBody | undefined): richBody is RichBody =>
  richBody !== undefined && richBodySbar(richBody) !== null;

export function assertSbarWrite(
  richBody: RichBody | undefined,
  channelKind: string,
  policy: EffectiveSbarPolicy,
): void {
  if (!isSbarBody(richBody)) return;
  if (SBAR_DENIED_CHANNEL_KINDS.includes(channelKind)) throw sbarNotAllowedInChannel();
  if (policy.requirePatientChannel && channelKind !== "care_team") throw sbarNotAllowedInChannel();
  const issues = validateSbar(richBody, policy);
  if (issues.length > 0) {
    throw new WardenXError(
      "SBAR_INVALID",
      "The SBAR message does not meet the length requirements.",
      422,
      issues.map(({ field, code, message }) => ({ field, code, message })),
    );
  }
}
