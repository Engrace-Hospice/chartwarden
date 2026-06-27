// @wardenx/quality — M30 HQRP & Quality package entrypoint (public barrel).
//
// M30 is the hospice Quality plane: the HQRP measure-calculator suite (HCI / HVLDL / HOPE-derived /
// operational), the CAHPS vendor-adapter contract + sampling/ingest pipelines, and the operator
// workflows — QAPI projects/PIPs, the annual HIPAA Security Risk Assessment (SRA), the incident
// register, mortality review, CoP-citation compliance, infection surveillance, and the risk register.
// The Drizzle schema for all 18 M30 tables lives in the central barrel (packages/db/src/schema/quality)
// per repo convention; this package holds the FIVE published seam interfaces, the pure lifecycle
// reducers + guard functions, the measure calculators, and the constant catalogs. Backend wiring
// (routes, repositories, workers, outbox/alert registration) lands in later phases.
//
// P2a scope: PURE DOMAIN ONLY — no Fastify, no DB queries, no BullMQ, no outbox emit. Every symbol below
// is a type, an interface, a pure function, or a constant catalog. The integrator owns this barrel; it
// re-exports the public surface of every P2a subtree so downstream phases import from the package root
// rather than by file path.

// The §4.3 FIVE published seam interfaces (QualityMeasureProvider / IncidentRegisterProvider /
// QapiProjectProvider / ComplianceStatusProvider / SecurityRiskAssessmentReader) + the published-name
// tuple the later boot assert validates against. Interfaces only — port-injected registration is later.
export * from "./seams";
// The §2.1 / §4.2 / §4.3 canonical shared DOMAIN VALUE TYPES the seams and every subtree reference
// (row-backed types derived from the frozen schema + the pgEnum-mirroring string unions).
export * from "./contracts";
// The §4.6 permission-key catalog (`M30_PERMISSIONS`) the backend projects into M3 in a later phase.
export * from "./permissions";
// The §4.7 / §6.7 ABAC predicate-NAME catalog (`M30_ABAC_PREDICATES`) M30 surfaces reference.
export * from "./abac";

// The §3.1 measure-calculator subtree: the shared result/input kernel, per-FY period math, the
// measure registry/catalog, and the four calculator families (HCI, HVLDL, HOPE-derived, operational).
export * from "./measures/index";
// The §4.5 / §4.13 / §7.2 CAHPS subtree: the published vendor-adapter contract + per-org registry and
// the two pure pipelines (decedent sampling, result-ingest min-cell suppression).
export * from "./cahps/index";
// The §2.2 QAPI subtree: the pure project + PIP lifecycle reducers, governance, and indicator registry.
export * from "./qapi/index";
// The §2.2 SRA subtree: the pure cycle reducer, NIST 800-66r2 template, prior-cycle finding seed, 5×5 scoring.
export * from "./sra/index";
// The §2.2 / §2.3 / §4.10 / §10 incident subtree: kind catalog + required-field rules, mandatory-reporter
// determination, the seven-state lifecycle machine, and auto-incident creation from upstream events.
export * from "./incidents/index";
// The §2.2 / §4.12 / §7.13 mortality-review subtree: the three-dimension form + completeness predicates,
// the lifecycle machine, and auto-creation from `m6.discharge.death` (deferred-clock + Part 2 promotion).
export * from "./mortality_review/index";
// The §7.7 CoP-citation compliance subtree: the citation catalog + the six-month review-cadence math.
export * from "./cop_compliance/index";
// The §7.8 infection subtree: surveillance-event shaping + the ≥3-events/14d outbreak detector.
export * from "./infection/index";
// The §7.9 risk-register subtree: the in-process projection that mirrors the `risk_register_view` SQL.
export * from "./risk_register/index";
