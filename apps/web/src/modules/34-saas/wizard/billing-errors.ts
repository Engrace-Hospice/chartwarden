// apps/web/src/modules/34-saas/wizard — what a member is told when the billing steps' calls (the clearinghouse and the MAC credential)
// are refused. The server's sentence is the fallback and is operator-worded in places; these say what to DO next, in the tenant's voice.
// Authorization-class refusals (step-up, forbidden) are not here: `describeOpsError` gives them their own kinds.
import type { OpsErrorCopy, OpsFailure } from "@chartwarden/ui";

const STALE_RECORD =
  "This changed while you were looking at it. It has been reloaded. Review what it says now and enter your change again.";

/** A module constant: `useOpsWrite` and `useLoad` need a stable copy map. */
export const BILLING_ERROR_COPY: OpsErrorCopy = {
  // The clearinghouse and BAA routes answer a stale or missing If-Match with 412 / 428; the MAC credential save answers 409.
  VERSION_CONFLICT: STALE_RECORD,
  IF_MATCH_REQUIRED: STALE_RECORD,
  STALE_VERSION: STALE_RECORD,
  CLEARINGHOUSE_CHANGED_DURING_VERIFY:
    "The clearinghouse settings changed while they were being verified. They have been reloaded; verify again.",
  CLEARINGHOUSE_VENDOR_LOCKED:
    "The vendor and mode are locked while production claims are being sent, and for 90 days after the last one. Ask ChartWarden for help if you must change them now.",
  CLEARINGHOUSE_WORK_WAITING:
    "Claims are still queued on the current clearinghouse. Let them finish before you change it.",
  CLEARINGHOUSE_ACCOUNT_IN_USE:
    "That vendor account is already connected to another organization. Check the credential, or ask ChartWarden for help.",
  CLEARINGHOUSE_CREDENTIAL_LIMIT:
    "Your organization holds the most earlier clearinghouse credentials it may keep. Ask ChartWarden for help to release the ones you no longer use.",
  CLEARINGHOUSE_OUTSIDE_SWITCH_REQUIRES_OPERATOR:
    "Your organization bills outside ChartWarden and has a contract, so moving to a clearinghouse also changes its billing service mode. Ask ChartWarden for help to make the switch.",
  CLEARINGHOUSE_TEST_MODE_NOT_ALLOWED:
    "Test mode is not available here. Choose production, or ask ChartWarden for help.",
  CLEARINGHOUSE_CIPHER_UNBOUND:
    "Credentials cannot be stored right now. Nothing was saved. Tell ChartWarden if this keeps happening.",
  CLEARINGHOUSE_NOT_CONFIGURED: "Choose a clearinghouse first.",
  CLEARINGHOUSE_SECRET_REQUIRED: "Enter the vendor credential first.",
  CLEARINGHOUSE_NOT_VERIFIED:
    "Verify the connection before you activate the clearinghouse. The settings have been reloaded.",
  CLEARINGHOUSE_BAA_NOT_VERIFIED:
    "ChartWarden has not verified your vendor BAA yet, so the clearinghouse cannot be activated. The settings have been reloaded.",
  CLEARINGHOUSE_BAA_NOT_RECORDED: "Record your vendor BAA first.",
  CLEARINGHOUSE_BAA_DATE_INVALID:
    "The effective date must be a real date that is not in the future.",
  CLEARINGHOUSE_BAA_REF_INVALID:
    "Say where the signed BAA is kept, in 3 to 200 characters. Name the document, never a patient.",
  CLEARINGHOUSE_EVIDENCE_REQUIRED:
    "Say what was checked and by whom, in 8 to 500 characters, without naming a patient.",
  CLEARINGHOUSE_NO_PHI_CONFIRMATION_REQUIRED:
    "Confirm that your note names no patient information.",
  CLEARINGHOUSE_SECRET_INVALID:
    "The credential must be 8 to 512 printable characters with no spaces.",
  CLEARINGHOUSE_OUTSIDE_NOT_VERIFIABLE:
    "Billing outside ChartWarden has no clearinghouse connection to verify.",
  EVIDENCE_LOOKS_LIKE_PHI:
    "That text looks like it contains a patient identifier. Describe what was checked without naming a patient.",
  RATE_LIMITED: "That was tried too many times. Wait a minute, then try again.",
  DEGRADED: "This is unavailable for a moment. Nothing was changed. Try again shortly.",
  TENANT_NOT_ONBOARDING: "Your organization is no longer onboarding, so these settings are closed.",
};

/** A refusal about an input: the form stays open and each message is read beside its field. */
export const isAboutAnInput = (failure: Pick<OpsFailure, "kind" | "fieldErrors">): boolean =>
  failure.kind === "validation" && Object.keys(failure.fieldErrors).length > 0;

/** The record changed under the member (412, 409 stale, 428): it is read again and the form closes, because its pin is stale. */
export const isStalePin = (failure: Pick<OpsFailure, "kind">): boolean =>
  failure.kind === "conflict" || failure.kind === "precondition";
