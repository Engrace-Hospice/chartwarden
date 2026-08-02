// @wardenx/portal — Module 31 Patient/Family Portal PWA. The domain-contract re-exports (M31-T01) plus the
// §5.1 screen registry (M31-T08): the caregiver/bereaved surface built against the module's generated client.
export * from "./domain";
export { PortalApp } from "./app";
export type { PortalAppProps } from "./app";
export { portalScreens, createPortalRegistry } from "./screens/registry";
export type { PortalScreen } from "./screens/registry";
export { PORTAL_SCREEN_MANIFEST } from "./screens/manifest";
export type { PortalScreenMeta } from "./screens/manifest";
