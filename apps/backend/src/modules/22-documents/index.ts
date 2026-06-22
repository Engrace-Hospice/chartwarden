// apps/backend/src/modules/22-documents — M22 Document Management backend module.
//
// M22-T03 landed the pure §2.2 document-lifecycle domain under `./domain` (the aggregate state machine, the
// append-only version ledger, retention-class rules, legal hold, the §164.528 access-log + signed-URL TTL,
// the D1 per-tenant MinIO key model, and the §2.4 patient-merge redirect). The schema landed in M22-T02; the
// seams (T04/T05), outbox wiring (T06), routes/service (T07), and screens (T10) land in later tasks.
export * from "./domain";
