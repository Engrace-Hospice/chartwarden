// packages/hearthnote/src/templates/index.ts — M8-T05. Template-engine barrel.
export type { HearthnoteTemplate, TemplateSection } from "./types";
export { templateKey } from "./types";
export { TEMPLATES, requiredSectionIds, resolveTemplate } from "./registry";
