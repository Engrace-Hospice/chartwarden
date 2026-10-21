// @chartwarden/billing — TypeBox route schema barrel (M23 §4.1 / §4.2). The request/response SHAPE contracts
// for the 42-route inventory — one module per route group. PURE shape gates: the P3 routes import these as
// Fastify `{ schema: { body, querystring, params, response } }`; the validation/lifecycle/penny-math
// invariants behind each shape live in the pure domain + service layers, NEVER in a schema.
//
// ENUM VOCABULARY: the wire surface speaks the DB pgEnum vocabulary (UPPERCASE states, full eligibility
// union) per spec §4.2 — see `./common`. The package-canonical lowercase `ClaimState` lives in contracts.

// shared fragments (enum schemas, cursor pagination, error envelope)
export * from "./common";

// claim lifecycle write routes (#1 / #4 / #5 / #7 / #8 / #9)
export * from "./claim-assemble";
export * from "./claim-update";
export * from "./claim-submit";
export * from "./claim-replace";
export * from "./claim-void";

// claim read routes (#2 / #3 / #10 / #11 / #12 / #13)
export * from "./claim-read";

// validation routes (#6 / #14 / #15 / #16 / #17)
export * from "./validate";
export * from "./validation-override";

// rule-config CRUD (#18 / #19 / #20 / #21)
export * from "./rule-config";

// eligibility (#22 / #23)
export * from "./eligibility-check";

// notices (#24–#27 NOE, #28–#31 NOTR)
export * from "./noe";
export * from "./notr";

// reference-data + admin (#32 / #33 sequestration, #34–#36 MAC credentials)
export * from "./sequestration-policy";
export * from "./mac-credential";

// dashboards / metrics (#37 / #38)
export * from "./ar-dashboard";
export * from "./metrics";

// internal seam endpoints (#39 / #40) + platform admin (#41 / #42)
export * from "./internal-seam";
export * from "./platform-admin";
