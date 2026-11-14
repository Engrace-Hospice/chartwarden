// apps/web/src/modules/34-saas/wizard — what a member is told when the billing steps' calls (the clearinghouse and the MAC credential)
// are refused. The codes every lane shares (stale versions, the PHI screen, the rate limit) are @chartwarden/ui's one sentence each; this
// adds only what is the billing steps' own, in the tenant's voice: the server's sentence is the fallback and is operator-worded in places.
// Authorization-class refusals (step-up, forbidden) are not here: `describeOpsError` gives them their own kinds.
import { COMMON_OPS_ERROR_COPY, type OpsErrorCopy, type OpsFailure } from "@chartwarden/ui";

const SECRET_UNREADABLE =
  "ChartWarden could not open the vendor credential stored for your organization. Choose the clearinghouse again and enter the credential.";

/** A module constant: `useOpsWrite` and `useLoad` need a stable copy map. */
export const BILLING_ERROR_COPY: OpsErrorCopy = {
  ...COMMON_OPS_ERROR_COPY,
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
  CLEARINGHOUSE_CONTRACT_UNAVAILABLE:
    "Your organization's contract could not be read, so the switch away from outside ChartWarden was not made. Try again shortly, or ask ChartWarden for help.",
  CLEARINGHOUSE_TEST_MODE_NOT_ALLOWED:
    "Test mode is not available here. Choose production, or ask ChartWarden for help.",
  CLEARINGHOUSE_CIPHER_UNBOUND:
    "Credentials cannot be stored right now. Nothing was saved. Tell ChartWarden if this keeps happening.",
  CLEARINGHOUSE_SECRET_UNREADABLE: SECRET_UNREADABLE,
  CLEARINGHOUSE_CREDENTIAL_UNREADABLE: SECRET_UNREADABLE,
  CLEARINGHOUSE_NOT_CONFIGURED: "Choose a clearinghouse first. The settings have been reloaded.",
  CLEARINGHOUSE_SECRET_REQUIRED: "Enter the vendor credential first.",
  CLEARINGHOUSE_NOT_VERIFIED:
    "Verify the connection before you activate the clearinghouse. The settings have been reloaded.",
  CLEARINGHOUSE_BAA_NOT_VERIFIED:
    "ChartWarden has not verified your vendor BAA yet, so the clearinghouse cannot be activated. The settings have been reloaded.",
  CLEARINGHOUSE_BAA_NOT_RECORDED: "Record your vendor BAA first. The settings have been reloaded.",
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
  DEGRADED: "This is unavailable for a moment. Nothing was changed. Try again shortly.",
};

/** The refusal of a MAC write or test for a provider entity the member's role does not cover (the routes are provider-entity scoped). */
export const MAC_ENTITY_FORBIDDEN =
  "Your role cannot change this provider entity's MAC credential. Ask your administrator.";

/** The record changed under the member (412, 409 stale, 428): it is read again and the form closes, because its pin is stale. */
export const isStalePin = (failure: Pick<OpsFailure, "kind">): boolean =>
  failure.kind === "conflict" || failure.kind === "precondition";

/**
 * Codes that say what is on screen is no longer what the server holds, though the kit classes them "refused": the connection or BAA
 * verification moved under the member (an operator voided the BAA, a colleague changed the choice). Their copy says "reloaded", so the
 * panel must reload.
 */
const MOVED_CODES: ReadonlySet<string> = new Set([
  "CLEARINGHOUSE_NOT_VERIFIED",
  "CLEARINGHOUSE_BAA_NOT_VERIFIED",
  "CLEARINGHOUSE_BAA_NOT_RECORDED",
  "CLEARINGHOUSE_NOT_CONFIGURED",
  "CLEARINGHOUSE_CHANGED_DURING_VERIFY",
  "TENANT_NOT_ONBOARDING",
]);

/** The view on screen is out of date: a stale pin, or a refusal whose copy says the settings were reloaded. Reload, then say so. */
export const isViewMoved = (failure: Pick<OpsFailure, "kind" | "code">): boolean =>
  isStalePin(failure) || (failure.code !== null && MOVED_CODES.has(failure.code));
