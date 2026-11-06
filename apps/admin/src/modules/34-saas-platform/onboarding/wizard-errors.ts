// apps/admin/src/modules/34-saas-platform/onboarding — what the operator is told for each code the wizard's writes answer with.
// The server's sentence is the fallback (the envelope never carries record content); these say what to DO next. Authorization-class
// codes (step-up, forbidden) are not here: `describeOpsError` gives them their own kinds.
import type { OpsErrorCopy } from "@chartwarden/ui";

export const WIZARD_ERROR_COPY: OpsErrorCopy = {
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
    "You recorded this tenant's BAA, so you cannot approve go-live. A different operator must approve.",
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
  BAA_DOCUMENT_REQUIRED: "An executed BAA needs the document id of the signed agreement.",
  INVALID_ORG_TIMEZONE: "That is not a valid time zone. Use an IANA name such as America/Denver.",
  INVALID_DISPLAY_NAME: "That display name is not valid.",
};
