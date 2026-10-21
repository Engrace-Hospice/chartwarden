// @chartwarden/cost-report — M27 pre-submission validation framework barrel (§1.1, architecture §11.B,
// D9/D16/D20/D21). Re-exports the pure rule model, the 28 platform-default rules, the NGS-J6 additive MAC
// profile, the rule engine, and the D20 auto-suggestion stub. PURE DOMAIN throughout — no Fastify, no
// Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`; no PHI (D18).

// The rule model: RuleDef / RuleResult / ValidationContext + the pure result constructors.
export * from "./types";
// The 28 platform-default rules (M27-F01/F02) + DEFAULT_RULE_SET_VERSION.
export * from "./default-rules";
// The MAC-jurisdiction-aware rule engine (runValidation) + its run-summary shape.
export * from "./rule-engine";
// The D20 auto-rule-suggestion stub.
export * from "./rule-suggestion";
// The NGS-J6 (Phase-1) additive MAC rule set (D16); other MACs ship as sibling files.
export * from "./mac-profiles/ngs-j6";
// The pure ValidationContext assembler + MAC-jurisdiction normalizer (the §11.B context shaper's pure core).
export * from "./assemble-context";
