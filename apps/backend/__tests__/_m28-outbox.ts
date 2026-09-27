// apps/backend/__tests__/_m28-outbox.ts — the REAL, catalog-validating M28 outbox port for live suites.
//
// `createDrizzleFhirGatewayStore(db)` defaults its outbox to `NOOP_FHIR_OUTBOX`, which accepts anything.
// This mirrors the M6 precedent (`_m6-outbox.ts`, F-100): a live suite that drives the store against the
// no-op default proves nothing about whether the catalog actually validates M28's payloads, because
// production binds `buildTxOutboxPublisher` over the real boot catalog and REFUSES a payload that does not
// match its schema (`Value.Check`, refuse-on-failure) — a failure mode the no-op cannot exhibit.
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M28_OUTBOX_EVENTS } from "../src/modules/28-fhir/index";
import type { FhirWriteOutboxPort } from "../src/modules/28-fhir/routes/store";

/** The production-shaped M28 publisher: catalog-validating, refuse-on-failure. */
export function validatingM28Outbox(): FhirWriteOutboxPort {
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M28_OUTBOX_EVENTS]));
  return {
    publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m28" }),
  };
}
