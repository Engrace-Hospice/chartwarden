// apps/admin/src/modules/32-ai-platform — M32 §5.1 AI Safety Owner console slice (ADR-0030, GAP-049).
//
// ONLY the screen manifest is exported. The screen modules themselves are reached exclusively through
// the `lazy()` imports in ./screens, so re-exporting a helper from one of them here would pull all eight
// back into the eager graph and undo the code-splitting the admin bundle needs (see ./screens).
export { aiPlatformAdminScreens } from "./screens";
