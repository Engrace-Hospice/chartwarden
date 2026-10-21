// @chartwarden/admin — the WardenX-staff Platform-Ops console SPA (M34 §5.1 shell + the M35 §5.2
// subscription-billing slice, ADR-0030). Public surface: the shell app + its registry host contract.
export { AdminApp } from "./app";
export type { AdminAppProps } from "./app";
export { createAdminRegistry } from "./shell/registry";
export type { AdminScreen, AdminScreenDescriptor, AdminScreenModule } from "./shell/registry";
