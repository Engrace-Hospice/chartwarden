// apps/admin/src/modules/34-saas-platform/onboarding — what the operator is told for each code the wizard's writes answer with.
// The server's sentence is the fallback (the envelope never carries record content); these say what to DO next. Authorization-class
// codes (step-up, forbidden) are not here: `describeOpsError` gives them their own kinds.
import { CLEARINGHOUSE_RELEASE_QUIET_DAYS } from "@chartwarden/types";
import type { OpsErrorCopy, OpsErrorDetail, OpsFailure } from "@chartwarden/ui";

export const WIZARD_ERROR_COPY: OpsErrorCopy = {
  ACTIVATION_GUARDS_FAILED:
    "The tenant cannot go live yet: the checks below do not pass right now. The step has been reloaded.",
  GO_LIVE_ATTESTATION_STALE:
    "The attestation no longer stands (its attester is no longer the assigned compliance officer). The step has been reloaded. Revoke the attestation so the compliance officer can attest again.",
  ONBOARDING_STEP_OUT_OF_ORDER: "An earlier step is not finished yet. Steps are done in order.",
  ONBOARDING_STEP_ALREADY_SETTLED: "This step is already done. Re-open it to change it.",
  ONBOARDING_STEP_NOT_ATTESTABLE:
    "The platform verifies this step from its own data, so it cannot be marked done by hand.",
  ONBOARDING_STEP_NOT_SKIPPABLE: "This step cannot be skipped.",
  ONBOARDING_STEP_NOT_SETTLED: "Only a step that is done or skipped can be re-opened.",
  ONBOARDING_TASK_CHANGED:
    "This step changed while you were looking at it. It has been reloaded. Review it and try again.",
  TENANT_NOT_ONBOARDING: "This tenant is not in onboarding, so onboarding changes are closed.",
  EVIDENCE_LOOKS_LIKE_PHI:
    "That text looks like it contains a patient identifier. Describe what was checked without naming a patient.",
  GO_LIVE_PENDING:
    "A go-live attestation is pending. Revoke it first, then re-open the step. The compliance officer will need to attest again.",
  GO_LIVE_SAME_PERSON:
    "The person who attested readiness cannot also approve it. A different operator must approve.",
  GO_LIVE_APPROVER_WROTE_BAA:
    "You recorded, changed or uploaded the signed agreement of this tenant's BAA, so you cannot approve go-live. A different operator must approve.",
  GO_LIVE_NOT_ATTESTED: "The compliance officer has not attested readiness yet.",
  GO_LIVE_ATTESTATION_EXPIRED:
    "The attestation is more than 14 days old. Revoke it so the compliance officer can attest again.",
  GO_LIVE_TWO_PARTY_REQUIRED:
    "Going live takes the compliance officer's attestation and then a different operator's approval.",
  ORGANIZATION_ACTIVATION_FAILED:
    "Approval was recorded but the organization could not be opened. Approve again to retry.",
  COMPLIANCE_OFFICER_NOT_A_MEMBER:
    "The compliance officer must be an active member of this organization.",
  COMPLIANCE_OFFICER_LACKS_ROLE: "The compliance officer must hold the compliance officer role.",
  COMPLIANCE_OFFICER_LOCKED:
    "The compliance officer can only be changed while the tenant is onboarding or live.",
  COMPLIANCE_OFFICER_PLATFORM_STAFF:
    "ChartWarden staff cannot be a tenant's compliance officer. Pick one of the customer's own staff.",
  BAA_UPLOAD_TOO_LARGE:
    "The signed agreement is too large to upload. It can be at most 10 MiB; save it as a smaller PDF and try again.",
  // A 413 with no envelope comes from a proxy in front of the API, whose cap may be wrong: do not quote the API's limit.
  PAYLOAD_TOO_LARGE:
    "The server refused this upload as too large. If the file is under 10 MiB, tell engineering: the upload should have been accepted.",
  BAA_DOCUMENT_REQUIRED: "An executed BAA needs the document id of the signed agreement.",
  INVALID_ORG_TIMEZONE: "That is not a valid time zone. Use an IANA name such as America/Denver.",
  INVALID_DISPLAY_NAME: "That display name is not valid.",
  IF_MATCH_REQUIRED:
    "This record changed while you were looking at it. It has been reloaded. Review what it says now and enter your change again.",
  CLEARINGHOUSE_RESPONSES_PENDING: `This tenant may still receive vendor responses on its earlier keys, so they stay reserved. Try again once it has had no production claim in flight and none sent for ${CLEARINGHOUSE_RELEASE_QUIET_DAYS} days.`,
  CLEARINGHOUSE_CREDENTIAL_LIMIT:
    "This tenant holds the most earlier clearinghouse keys it may keep. Release the ones it no longer uses at the vendor (Release earlier credentials, on the Clearinghouse card of the tenant's page), then save the new key.",
  VERSION_CONFLICT:
    "This record changed since you opened it. It has been reloaded. Review what it says now and enter your change again.",
  // The route kit's stale If-Match (409): the MAC credential save answers it where the clearinghouse and BAA routes answer 412.
  STALE_VERSION:
    "This record changed since you opened it. It has been reloaded. Review what it says now and enter your change again.",
};

/** A refusal that is about an input (not the reason itself): the prompt gets out of the way so the error is read beside that input. */
export const isAboutAnInput = (failure: Pick<OpsFailure, "kind" | "fieldErrors">): boolean =>
  failure.kind === "validation" &&
  Object.keys(failure.fieldErrors).some((field) => field !== "reason");

/**
 * The codes that say the step, or the tenant, is no longer in the state the operator was looking at (another operator or the tenant
 * moved it): the wizard view on screen is out of date, so the action that met one re-reads it. The copy for these says "reloaded".
 */
const VIEW_MOVED_CODES: ReadonlySet<string> = new Set([
  "ONBOARDING_TASK_CHANGED",
  "ONBOARDING_STEP_ALREADY_SETTLED",
  "ONBOARDING_STEP_NOT_SETTLED",
  "TENANT_NOT_ONBOARDING",
  "GO_LIVE_NOT_ATTESTED",
  "GO_LIVE_ATTESTATION_STALE",
  "GO_LIVE_ATTESTATION_EXPIRED",
  "ACTIVATION_GUARDS_FAILED",
]);
export const viewHasMoved = (failure: Pick<OpsFailure, "code">): boolean =>
  failure.code !== null && VIEW_MOVED_CODES.has(failure.code);

/** The activation guards the go-live approval re-judges, in the operator's words. */
export const GUARD_COPY: Readonly<Record<string, string>> = {
  canonicalTasksComplete: "Every required step is done or skipped",
  baaExecuted: "The latest BAA is executed, with the signed agreement filed for this tenant",
  baaExpiryClearsNinetyDays: "The executed BAA has more than 90 days left",
};

/** One failing guard as a sentence: never a raw key, and a guard this screen has no words for still shows (with its name). */
export const guardLabel = (guard: string, serverSentence?: string): string =>
  GUARD_COPY[guard] ?? serverSentence ?? `A go-live check does not pass (${guard})`;

/** The refusal's per-guard lines (ACTIVATION_GUARDS_FAILED): each failing guard, then each earlier step still open. */
export const guardFailureLines = (details: readonly OpsErrorDetail[]): string[] =>
  details.map((d) => (d.field === "guard" ? guardLabel(d.code, d.message) : d.message));
