// @wardenx/consent — public barrel.
//
// Module 39 (Consent & Authorization Management). The package holds the pure consent domain:
// type-level kinds (M39-T01), the consent state machine + validation (M39-T04), the
// ConsentEvaluator seam implementation (M39-T05), consumed-seam wiring (M39-T06), outbox/job
// contracts (M39-T08), the consent flows (M39-T09), and the eraser (M39-T10). Drizzle schema
// lives in packages/db (a leaf cannot hold tables, ADR-0005 D2); the backend module
// apps/backend/src/modules/39-consent owns routes + boot registration.

// ── M39-T01 — kinds & structural descriptor (§2.3, §3.2) ──────────────────────────────────
export * from "./interfaces/kinds";
