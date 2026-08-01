// @wardenx/ai-platform — the §4.1 invocation pipeline's pure rules (M32-T04).
//
//   · ./routing     §3.2.4/§3.2.13/W8 — which backend serves, and which one the ledger names
//   · ./token-cap   §3.2.9/D6/D7/W2 — the monthly window and the four-valued cap state
//   · ./gates       §6/§4.1 — the gate ORDER, in one pure function
//
// The stores, the dispatch and the `ai_invocation` write live in
// `apps/backend/src/modules/32-ai-platform/invocation`; nothing here touches a database, a clock or a
// vendor.
export * from "./routing";
export * from "./token-cap";
export * from "./gates";
