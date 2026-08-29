// apps/backend/__tests__/_m6-outbox.ts — the REAL M6 outbox port for the live write suites (F-100).
//
// `createDbAdmissionRouteService(db)` defaults its outbox to `NOOP_OUTBOX`, which accepts anything.
// Every M6 live suite took that default — nine constructions across eight files — so the module drove
// its entire production write surface against a publisher that validates nothing, while production binds
// one that `Value.Check`s the payload against the boot catalog and REFUSES on failure. A payload the
// suites waved through is a `payload_schema_violation` and a rolled-back write on the real route.
//
// That is not hypothetical: `POST /f2f/:id/complete`, `/f2f/:id/window-override`, `/admissions/:id/hold`
// and `/admissions/:id/resume` each raised it for every caller, and the completion one killed the whole
// CMS-418.22(a)(4) face-to-face chain (attestation is only reachable from `completed`). The file's own
// comments record the same symptom being found live three times before, one event at a time — which is
// what a suite that cannot see the failure class produces.
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import type { AdmissionWriteOutboxPort } from "../src/modules/06-admission/admission-route-service-db";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";

/** The production-shaped M6 publisher: catalog-validating, refuse-on-failure. */
export function validatingM6Outbox(): AdmissionWriteOutboxPort {
  const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M6_OUTBOX_EVENTS]));
  return {
    publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m6" }),
  };
}
