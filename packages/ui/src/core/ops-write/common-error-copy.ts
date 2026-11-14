// @chartwarden/ui core — the sentences every lane says for the codes a versioned, screened or limited write can answer with, so one code
// has ONE sentence however many wizards speak it (the platform console, the tenant wizard). A lane spreads this under its own map and
// adds only what is its own; a sentence that must differ by voice does not belong here.
import type { OpsErrorCopy } from "./ops-error";

const CHANGED_SINCE_OPENED =
  "This record changed since you opened it. It has been reloaded. Review what it says now and enter your change again.";

export const COMMON_OPS_ERROR_COPY: OpsErrorCopy = {
  // The clearinghouse and BAA routes answer a stale If-Match with 412 VERSION_CONFLICT and a missing one with 428 IF_MATCH_REQUIRED; the
  // route kit's integer If-Match (the MAC credential save) answers 409 STALE_VERSION.
  IF_MATCH_REQUIRED:
    "This record changed while you were looking at it. It has been reloaded. Review what it says now and enter your change again.",
  VERSION_CONFLICT: CHANGED_SINCE_OPENED,
  STALE_VERSION: CHANGED_SINCE_OPENED,
  EVIDENCE_LOOKS_LIKE_PHI:
    "That text looks like it contains a patient identifier. Describe what was checked without naming a patient.",
  RATE_LIMITED: "That was tried too many times in a row. Wait a few minutes and try again.",
  TENANT_NOT_ONBOARDING: "Onboarding changes are closed: this organization is not in onboarding.",
};
