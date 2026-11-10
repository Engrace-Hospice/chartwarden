// apps/backend/src/modules/34-saas-tenant-platform/onboarding/phi-screen.ts — the wizard's patient-identifier screen.
// The implementation moved to `@chartwarden/shared` (text/patient-identifier.ts) so M23's NPI evidence and M35's add-on grant
// reason screen with the same rule; this keeps the wizard's import path.
export {
  looksLikeMbi,
  looksLikePatientIdentifier,
  looksLikeSsn,
} from "@chartwarden/shared";
