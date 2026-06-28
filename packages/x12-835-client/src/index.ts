// @wardenx/x12-835-client — the M25-owned slice of the X12 sidecar adapter (architecture §25.14): the
// parse-835 / parse-277ca surface that fronts the Python `x12-worker`. Pure mapping + a fail-closed
// injected-transport client; no network code, no pyx12 shim, no PHI logging. M23 owns the disjoint
// 837-generation / 999 slice in @wardenx/x12-837-client.
export * from "./types";
export * from "./parse-835";
export * from "./parse-277ca";
export * from "./client";
