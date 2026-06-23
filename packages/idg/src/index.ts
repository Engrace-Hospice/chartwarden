// @wardenx/idg — Module 14 (Interdisciplinary Group / IDG) feature package.
//
// M14-T01 lands the domain layout + metadata: the §1.1 / §2.2 / §2.5 pure-data policy constants
// (`policy.ts`: `IDG_REQUIRED_QUORUM`, `IDG_SCHEDULE_POLICY`, `DISCIPLINE_VIEW_POLICY`, the post-discharge
// wrap-up + step-up freshness + payload-schema-version floors). The cross-module enum/seam/outbox/alert
// CONTRACTS + the §2.6 D4 decision union + the §2.4 D1 packet snapshot live in the leaf `@wardenx/types`
// (`idg.ts`) so downstream consumers (M7/M11/M12/M16/M22/M28/M30/M33/M36) import them with no `dependsOn`
// edge.
//
// The pure (IO-free, `@wardenx/types`-only) domain that reads these constants — the §2.2 meeting state
// machine + decision/action-item/minutes logic (M14-T03) and the §2.4 D1 / §2.5 D7 packet-snapshot builder +
// W-PKT-02 freeze guard + W-SUD-01 read-path redactor (M14-T04). It lives HERE (the M11 `@wardenx/orders` /
// M12 `@wardenx/dosespot` / M13
// `@wardenx/emar` precedent) rather than the `@wardenx/domain` leaf because it reads the local
// `DISCIPLINE_VIEW_POLICY` / quorum constants.

export * from "./policy";
export * from "./lifecycle";
export * from "./packet";
