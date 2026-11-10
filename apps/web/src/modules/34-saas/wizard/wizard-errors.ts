// apps/web/src/modules/34-saas/wizard — what the tenant is told for each code the wizard's reads and writes answer with. The server's
// sentence is the fallback (the envelope never carries record content); these say what to DO next, in the tenant's words and never
// naming an operator. Authorization-class codes (step-up, forbidden) are not here: `describeOpsError` gives them their own kinds.
import type { OpsErrorCopy, OpsFailure } from "@chartwarden/ui";

export const WIZARD_ERROR_COPY: OpsErrorCopy = {
  ONBOARDING_STEP_OUT_OF_ORDER: "An earlier step is not finished yet. Steps are done in order.",
  ONBOARDING_STEP_ALREADY_SETTLED: "This step is already done. Re-open it to change it.",
  ONBOARDING_STEP_NOT_ATTESTABLE:
    "ChartWarden checks this step from its own data, so it cannot be marked done by hand.",
  ONBOARDING_STEP_NOT_SKIPPABLE: "This step cannot be skipped.",
  ONBOARDING_STEP_NOT_TENANT_SKIPPABLE:
    "Only ChartWarden can skip this step. Your organization may skip MAC credentials, payer enrollment and DoseSpot kickoff when they do not apply to it.",
  ONBOARDING_STEP_NOT_SETTLED: "Only a step that is done or skipped can be re-opened.",
  ONBOARDING_STEP_OWNER_MISMATCH:
    "This step belongs to someone else: your organization's administrator, your compliance officer or ChartWarden. You can read it here.",
  ONBOARDING_TASK_CHANGED:
    "This step changed while you were looking at it. It has been reloaded. Review it and try again.",
  TENANT_NOT_ONBOARDING:
    "Your organization is not in onboarding, so onboarding changes are closed.",
  EVIDENCE_LOOKS_LIKE_PHI:
    "That text looks like it contains a patient identifier. Describe what was checked without naming a patient.",
  GO_LIVE_PENDING:
    "A go-live attestation is waiting for ChartWarden's approval. Reassign the compliance officer or ask ChartWarden to revoke it, then re-open the step. The page has been reloaded.",
  GO_LIVE_NOT_COMPLIANCE_OFFICER:
    "Only your organization's compliance officer can attest that you are ready to go live.",
  ACTIVATION_GUARDS_FAILED:
    "Your organization cannot go live yet: the checks listed below do not pass. The page has been reloaded.",
  COMPLIANCE_OFFICER_NOT_A_MEMBER:
    "The compliance officer must be an active member of your organization.",
  COMPLIANCE_OFFICER_LACKS_ROLE:
    "That person does not hold the compliance officer role yet. Give them the role, then assign them.",
  COMPLIANCE_OFFICER_LOCKED:
    "The compliance officer can only be changed while your organization is onboarding or live.",
  COMPLIANCE_OFFICER_PLATFORM_STAFF:
    "ChartWarden staff cannot be your compliance officer. Pick one of your own staff.",
  INVALID_ORG_TIMEZONE: "That is not a valid time zone. Use an IANA name such as America/Denver.",
  INVALID_DISPLAY_NAME: "That display name is not valid.",
  IF_MATCH_REQUIRED:
    "This record changed while you were looking at it. It has been reloaded. Review what it says now and enter your change again.",
  VERSION_CONFLICT:
    "This record changed since you opened it. It has been reloaded. Review what it says now and enter your change again.",
  STALE_VERSION:
    "This record changed since you opened it. It has been reloaded. Review what it says now and enter your change again.",
  RATE_LIMITED: "That was tried too many times in a row. Wait a few minutes and try again.",
};

/** A refusal that is about an input (not the step): the prompt gets out of the way so the error is read beside that input. */
export const isAboutAnInput = (failure: Pick<OpsFailure, "kind" | "fieldErrors">): boolean =>
  failure.kind === "validation" && Object.keys(failure.fieldErrors).length > 0;

/**
 * The codes that say the step, or the organization, is no longer in the state the person was looking at (an operator or a colleague
 * moved it): the wizard view on screen is out of date, so the action that met one re-reads it. The copy for these says "reloaded".
 */
const VIEW_MOVED_CODES: ReadonlySet<string> = new Set([
  "ONBOARDING_TASK_CHANGED",
  "ONBOARDING_STEP_ALREADY_SETTLED",
  "ONBOARDING_STEP_NOT_SETTLED",
  "TENANT_NOT_ONBOARDING",
  "ACTIVATION_GUARDS_FAILED",
  "GO_LIVE_PENDING",
]);
export const viewHasMoved = (failure: Pick<OpsFailure, "code">): boolean =>
  failure.code !== null && VIEW_MOVED_CODES.has(failure.code);

/** The go-live checks the server re-judges, in the tenant's words. */
const GUARD_COPY: Readonly<Record<string, string>> = {
  canonicalTasksComplete: "Every required step is done or skipped",
  baaExecuted: "Your BAA with ChartWarden is executed",
  baaExpiryClearsNinetyDays: "Your executed BAA has more than 90 days left",
};

/** One failing check as a sentence: never a raw key, and a check this screen has no words for still shows (with its name). */
export const guardLabel = (guard: string, serverSentence?: string): string =>
  GUARD_COPY[guard] ?? serverSentence ?? `A go-live check does not pass (${guard})`;
