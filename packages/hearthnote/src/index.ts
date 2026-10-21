// packages/hearthnote/src/index.ts — M8-T05 (spec §2.6, architecture §10.5).
//
// `@chartwarden/hearthnote` is the HearthNote narrative engine: the deterministic Layer-1 core (template
// engine + byte-identical assembly) and the flag-gated Layer-2 LLM enhancement deny-stub. Layer 3 (the
// always-on compliance gate) is enforced by Module 8's lifecycle/service (M8-T04/T09) reading this
// package's template `required` flags + `missingRequiredSections`; it is not re-implemented here. No IO,
// no vendor SDK — the only dependencies are the leaf `@chartwarden/narrative-vocab` corpus and `@chartwarden/types`.
export * from "./templates/index";
export * from "./assembly/index";
export * from "./layer2/index";
