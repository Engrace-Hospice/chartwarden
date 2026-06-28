// @wardenx/quality — M30 QAPI pure-domain subtree barrel (P2a).
// Pure lifecycle reducers + governance + indicator registry (no IO). The integrator wires these into
// the package entrypoint and the backend composition root in a later phase.
export * from "./machines/project.machine";
export * from "./machines/pip.machine";
export * from "./governance";
export * from "./indicator_registry";
