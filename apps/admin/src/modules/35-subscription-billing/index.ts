// apps/admin/src/modules/35-subscription-billing — M35 §5.2 platform-ops admin slice (M35A-T04, ADR-0030).
// The barrel the admin composition root (apps/admin/src/main.tsx) imports to register M35's 14 §5.2 screens
// into the M34-owned admin shell registry. The shell never imports this slice directly — it reads the merged
// registry (the frontend seam analogue of M1's seam registry).
export { subscriptionAdminScreens } from "./screens";
