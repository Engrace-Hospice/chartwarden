// apps/admin/src/modules/34-saas-platform/onboarding — a data change while the compliance officer's go-live attestation is waiting for
// approval voids that attestation: said BEFORE the operator saves. Lives in @chartwarden/ui now (the tenant wizard shares it, in its own
// wording); re-exported so admin imports keep their path. The operator wording is the default.
export { PendingAttestationWarning } from "@chartwarden/ui";
