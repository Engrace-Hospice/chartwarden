// M36 WP 5.6 (ADR-0086, PROPOSED) - message retention and legal hold. The retention periods themselves stay in @wardenx/messaging
// (channel kinds); these are the cross-package names: the permission, the two fresh-step-up operation keys, the reason floor and the
// M4 destruction-certificate data classes the plan-only retention scan opens.

/** Lets a compliance officer apply / release a legal hold on messages and read the retention view (migration 1137). */
export const MESSAGING_RETENTION_MANAGE_PERMISSION = "messaging.retention.manage";

/** Fresh step-up operation keys; the apply and release routes each demand one. */
export const MESSAGE_LEGAL_HOLD_APPLY_STEP_UP_KEY = "messaging.legal_hold.apply";
export const MESSAGE_LEGAL_HOLD_RELEASE_STEP_UP_KEY = "messaging.legal_hold.release";

/** A hold or release needs a written reason of at least this many characters. */
export const MESSAGE_LEGAL_HOLD_REASON_MIN_LENGTH = 10;

/** The message retention classes, and the M4 certificate data class the scan files for each (`message.<class>`). */
export const MESSAGE_RETENTION_CLASSES = ["care_related", "bereavement", "operational"] as const;
export type MessageRetentionClass = (typeof MESSAGE_RETENTION_CLASSES)[number];
export const MESSAGE_RETENTION_DATA_CLASSES: readonly `message.${MessageRetentionClass}`[] =
  MESSAGE_RETENTION_CLASSES.map((c) => `message.${c}` as const);
