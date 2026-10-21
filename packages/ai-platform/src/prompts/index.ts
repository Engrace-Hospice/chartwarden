// @chartwarden/ai-platform — §4.5/§4.10 the prompt registry contract + its pure rules (M32-T05).
//
//   · ./prompt-registry   `AIPromptRegistry`, the D18 prefix-match rule, the content-hash pin, and
//                         R30's insert-the-new-row-and-deprecate-the-old activation plan.
//
// The implementation (store, LRU + TTL cache, git artifact reader) is in
// `apps/backend/src/modules/32-ai-platform/prompts`.
export * from "./prompt-registry";
