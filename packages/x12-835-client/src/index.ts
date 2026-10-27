// @chartwarden/x12-835-client — the M25-owned X12 remittance adapter (architecture §25.14): an in-process,
// fail-closed TypeScript 835 parser (ADR-0037) plus the 277CA sidecar-port mapper. No network or storage
// code, no PHI logging. M23 owns the disjoint 837-generation / 999 slice in @chartwarden/x12-837-client.
export * from "./types";
export {
  parseX12835,
  parseX12835AllSets,
  type ParseX12835Options,
} from "./parse-x12-835";
export * from "./parse-277ca";
export * from "./client";
export * from "./envelope-header";
