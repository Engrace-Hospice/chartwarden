// apps/backend/src/modules/32-ai-platform/prompts — §4.5/§4.10 `AIPromptRegistry` (M32-T05).
//
//   · ./store     `ai_prompt_template` (platform-shared: reads on the tenant handle, R30's write under
//                 the audited bypass) + the artifact-mount port, whose Phase-1 default resolves nothing
//   · ./registry  the registry itself — the D18 prefix queries answer from the TABLE and are never
//                 cached; only resolved details are, keyed on the content hash
//   · ./service   R30's activation, which reads the artifact rather than trusting the submitted hash
//
// The seam publish (`ai.prompt_registry`) is M32-T06's and the R29/R30 routes are M32-T07's.
export * from "./store";
export * from "./registry";
export * from "./service";
