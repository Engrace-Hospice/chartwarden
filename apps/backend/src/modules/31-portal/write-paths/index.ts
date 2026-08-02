// apps/backend/src/modules/31-portal/write-paths/index.ts — M31-T06 barrel for the portal write paths.
//
// The three clinical-record write surfaces (§1.2 "the four" minus M36 secure messaging, which M36 owns
// end-to-end): caregiver-attested administration (§7.7 / M13 D10 — including the live resolver that CLOSES
// M13's `CaregiverPortalSessionResolver` deny-stub), document upload → M22 intake (§7.8), and amendment
// request → M5 §164.526 (§7.9). Every core is PURE (injected facts in, a validated upstream payload or a
// `PortalWriteError` out); the route + upstream-seam calls land in T07.
export * from "./errors";
export * from "./caregiver-attestation";
export * from "./caregiver-portal-session-resolver";
export * from "./document-upload";
export * from "./amendment-request";
