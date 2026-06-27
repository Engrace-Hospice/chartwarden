// @wardenx/quality — M30 SRA pure-domain subtree barrel (P2a).
// Pure cycle reducer + NIST 800-66r2 template + prior-cycle finding seed + 5×5 scoring (no IO). The
// integrator wires these into the package entrypoint and the backend composition root in a later phase.
export * from "./machine";
export * from "./template";
export * from "./seed";
export * from "./scoring";
