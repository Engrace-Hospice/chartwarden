// @chartwarden/forms — Module 22 Pillar 2 (Form Rendering) FEATURE package (M22-T01 domain/layout).
//
// One renderer interface, two backends (react-pdf for structured clinical forms; Puppeteer for
// complex-layout artifacts). M22-T01 ships the DOMAIN-only surface: the FormTemplate descriptor + the
// 31-key platform-floor template registry (§4.5) + the PrintVendorAdapter contract (§3.1). The actual
// react-pdf/Puppeteer adapters, per-template TypeBox payload schemas, the `vX_Y_Z.tsx` components, the
// overlay composer, and the seam-registration boot land in later M22 tasks. Leaf-import only
// (`@chartwarden/types`) — no app/db import on the contract surface.

export type { FormTemplateDescriptor } from "./templates/interface";
export {
  FORM_TEMPLATE_REGISTRY,
  BEREAVEMENT_LETTER_KINDS,
  V1_TEMPLATE_VERSION,
  findFormTemplate,
} from "./templates/registry";
export type { BereavementLetterKind } from "./templates/registry";
export {
  PLATFORM_FIELD_VALUE_SPACE,
  TemplateResolutionError,
  listPlatformTemplates,
  resolveTemplate,
  validateOverlay,
} from "./templates/library";
export type {
  OverlayValidationResult,
  OverlayViolation,
  ResolvedTemplate,
  TenantTemplateOverlay,
} from "./templates/library";
export type {
  PrintVendorAdapter,
  PrintDispatchResult,
} from "./adapters/print-vendors/interface";
export { denyStubPrintVendorAdapter } from "./adapters/print-vendors/interface";
