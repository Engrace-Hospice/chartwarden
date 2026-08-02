// apps/backend/src/modules/31-portal/read-surfaces — M31-T04. The lay-language read layer: consume the
// upstream portal-summary seams (M5/M12/M13/M16/M17/M19/M22 + M38 lay labels), project each to a
// D17-minimized lay view, fail-CLOSED for disclosure. PURE projectors (`project.ts`) + impure fail-closed
// resolvers (`resolve.ts`) + the §8.4 minimization rules (`minimize.ts`) + the M38 lay-label utility
// (`terminology.ts`). The routes that gate (T03 consent + ABAC) and emit (§164.528 accounting) these views
// land in M31-T07; the telehealth + write surfaces are M31-T05/T06.
export * from "./terminology";
export * from "./minimize";
export * from "./views";
export * from "./project";
export * from "./resolve";
