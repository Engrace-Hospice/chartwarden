// @chartwarden/dosespot — the pure EPCS architecture domain (§2.4 D18, §1311.115/116/120/300, M12-T05).
//
// The IO-free EPCS pieces the M12 service/route layer (M12-T08) composes: the `dosespot.epcs` platform flag
// + the per-tenant certification gate (D18 / §1311.300), the IAL2 identity-proofing status tracker + expiry
// alerts (§1311.115), the DEA schedule-authorization check (§1311.120 / the `dea_schedule_authorized` ABAC
// predicate), and the 60-second 2FA signing-session submachine (§1311.116) that brackets the medication-order
// machine's `epcs_identity_pending` branch and leaves the §1311.205 `epcs_signing_attempt` records-of-
// application trail. The whole surface is a DENY-STUB in Phase 1: the `dosespot.epcs` flag is OFF, so
// `planEpcsSigningSession` always throws `EPCS_FEATURE_DISABLED` before a nonce is minted — built and tested,
// but no Phase-1 route transmits a controlled-substance Rx through it. No DB, no DoseSpot client, no crypto;
// `@chartwarden/types` only.
export * from "./errors";
export * from "./effects";
export * from "./cert-gate";
export * from "./ial2";
export * from "./dea-schedule";
export * from "./signing-session";
