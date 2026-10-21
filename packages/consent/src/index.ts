// @chartwarden/consent — public barrel.
//
// Module 39 (Consent & Authorization Management). The package holds the pure consent domain:
// type-level kinds (M39-T01), the consent state machine + validation (M39-T04), the
// ConsentEvaluator seam implementation (M39-T05), consumed-seam wiring (M39-T06), outbox/job
// contracts (M39-T08), the consent flows (M39-T09), and the eraser (M39-T10). Drizzle schema
// lives in packages/db (a leaf cannot hold tables, ADR-0005 D2); the backend module
// apps/backend/src/modules/39-consent owns routes + boot registration.

// ── M39-T01 — kinds & structural descriptor (§2.3, §3.2) ──────────────────────────────────
export * from "./interfaces/kinds";

// ── M39-T04 — lifecycle state machines (§2.2/§2.4) + validation rules (§2.3) ───────────────
export * from "./lifecycle";
export * from "./validation";

// ── M39-T05 — the published ConsentEvaluator seam (§4.3) + its injectable store port ───────
export * from "./seams/consent-evaluator";

// ── M39-T07 — the ConsentRouteService backend (§4.1 routes; cursor pagination §4.12) ───────
export * from "./routes/service";

// ── M39-T08 — the BullMQ queue catalog + pure reminder/expiration engines (§4.9) ───────────
export * from "./jobs";

// ── M39-T09 — the tenant-overlay tighten-only validator (§7.6) ─────────────────────────────
export * from "./overlay";

// ── M39-T10 — the consent-subtree destruction engine (§3.8; Part 2 lifetime + legal-hold refusal) ─
export * from "./destruction";
