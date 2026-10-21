// @chartwarden/saas-tenant-platform — SaaS Tenant Platform (Module 34).
//
// Public surface of the package. This is the platform control plane: tenant lifecycle +
// onboarding state machine, per-tenant DEK lifecycle / cryptographic shred, DSAR & tenant-export
// fulfilment, platform-ops support sessions (tenant-consented break-glass), and the platform-tenant
// BAA register + feature-flag admin UI (M34 spec §1.1). The Drizzle schema lives in the central
// barrel (packages/db/src/schema/saas) per repo convention; this package holds the seams, repos,
// services, and state machines that land in later M34 phases.
//
// First spine: the §4.6 seam interfaces — the four M34 publishes (lifecycle / key / onboarding /
// support-session) + the export-shard fan-out contract every PHI module implements, plus the one
// forward seam M34 consumes from M35 (subscription entitlements, deny-stub today, D15). Repos /
// services / state machines and the boot-time seam registrations land in later phases.
export * from "./seams";
export * from "./repositories";
export * from "./services";
// M34's outbox-subscription consumers (the M22 §1.1-handshake DSAR back-ref).
export * from "./consumers";
// M34's OWN export shard (the inverse-fan-out self-shard) + the seam registry / boot wiring.
export * from "./tenant-export-shard";
export * from "./seam-bootstrap";
// M34's OWN destruction-cert eraseFn for the `saas_tenant_platform_class` data class (D6, §3.5/§8.4).
export * from "./eraser";
