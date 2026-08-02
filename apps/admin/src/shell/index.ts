// apps/admin/src/shell — M34 admin-shell barrel (ADR-0030). The Platform-Ops console's registry host:
// the empty screen registry the composition root registers each platform-module slice into.
export { createAdminRegistry } from "./registry";
export type { AdminScreen, AdminScreenDescriptor, AdminScreenModule } from "./registry";
