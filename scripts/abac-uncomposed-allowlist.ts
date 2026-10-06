/**
 * ABAC predicates that are DECLARED (registered, or listed in a module's `*_PREDICATES` set) and that no
 * `requireAbac` — directly or through a one-level local wrapper — composes. Read by
 * `scripts/check-abac-composed.ts` (`bun run arch:abac-composed`, GAP-067).
 *
 * Each entry is a real finding from the first scan, with the reason it is not composed TODAY. None of
 * these is a statement that the control is satisfied elsewhere unless the reason says so; several are
 * open gaps (named). The list is a ratchet:
 *   - a NEW registered-but-uncomposed predicate fails the gate until it is composed or listed here WITH a
 *     reason;
 *   - an entry that becomes composed (or is no longer declared) fails the gate until it is deleted, so
 *     this file only shrinks.
 */
export const ABAC_UNCOMPOSED_ALLOWLIST: Readonly<Record<string, string>> = {
  // ── M22 ──────────────────────────────────────────────────────────────────────────────────────────
  document_within_admission_window:
    "M22 §4.7 post-discharge 13-month read window: registered and unit-tested, but no document read route composes it (reads gate on document_owner_or_caseload only). Open gap.",

  // ── M7 — enforced service-side ───────────────────────────────────────────────────────────────────
  dpoa_active:
    "M7 enforces DPOA activity service-side in its care-plan route service (and M9 reuses the same fact); no route-level guard names the bare predicate.",
  sud_disclosure_allowed:
    "M7 enforces SUD disclosure service-side through the ConsentEvaluator seam (authoring redaction); no route-level guard names the bare predicate.",

  // ── M39 — §4.8 cross-module consent predicates, registered for consumers that have not composed them ──
  family_caregiver_access_active:
    "M39 §4.8 predicate registered for the portal/caregiver surfaces; no consuming route composes it yet.",
  portal_access_active:
    "M39 §4.8 predicate registered for M31; M31 gates portal access through its own session class instead. No route composes it.",
  media_release_active:
    "M39 §4.8 predicate registered for media/photo capture surfaces; no consuming route composes it yet.",
  research_participation_active:
    "M39 §4.8 predicate registered for research export surfaces; no consuming route composes it yet.",
  advance_directive_acknowledged:
    "M39 §4.8 predicate registered for admission/care-plan gating; no consuming route composes it yet.",
  hipaa_release_active:
    "M39 §4.8 predicate registered for disclosure surfaces; no consuming route composes it yet.",

  // ── M37 — the five §4.7 resolvers; the unit/episode/equipment facts live in domain + service code ──
  "m37.ipu.rn_coverage_active":
    "Removed from the routes on purpose: requireAbac's getTarget is synchronous and the coverage fact is a DB window, so it always denied. Enforced in the M37 service transaction instead (see 37-ipu/routes/guards.ts).",
  "m37.irc_episode.within_cap":
    "Evaluated as the pure isWithinCap domain reading inside M37 services; no route composes the predicate.",
  "m37.equipment.inspection_current":
    "Evaluated as the pure inspection-currency domain reading inside M37 services (412 EQUIPMENT_INSPECTION_OVERDUE); no route composes the predicate.",
  "m37.ipu.staff_member":
    "Registered for unit-scoped reads; M37 unit reads are RBAC + RLS only today. Open gap.",

  // ── M32 — route-unbound by design (header of 32-ai-platform/abac-predicates.ts) ───────────────────
  ai_capability_clinician_opted_out:
    "Inverted polarity (TRUE means opted OUT); consumed by the AI SDK gate, never a route. Binding it at a route would gate access on having opted out.",
  ai_prohibited_zone_respected:
    "A boot-time validator run by the consuming modules against the prompt registry, not a request guard.",

  // ── M35 — need DB-resident facts a synchronous getTarget cannot supply ────────────────────────────
  plan_change_within_period_grace:
    "Re-asserted server-side in the M35 plan-change service (outside the 7-day grace only a restricted path is allowed); a route guard cannot resolve the period.",
  promo_applicable_to_subscription:
    "Needs the subscription's current period; enforced in the M35 promo-apply service, not at the route.",

  // ── M6 ───────────────────────────────────────────────────────────────────────────────────────────
  "compliance.scope":
    "Registered but unbound: M6's compliance-window routes are RBAC (compliance.read/close/override) plus compliance.window_override; admission.scope covers the owning admission. Open gap to bind or delete.",

  // ── M30 ──────────────────────────────────────────────────────────────────────────────────────────
  part2Redisclosure:
    "A row-redaction predicate for promoted quality rows, evaluated by the M30 service; its M5/M39 reach is still a deny-stub (index.ts), so it redacts every promoted row. Not a route guard.",

  // ── M28 FHIR — evaluated in the handler, not through M3 (no WardenX session on those routes) ──────
  fhir_export_scope_satisfied:
    "FHIR bulk-export routes carry no WardenX session for requireAbac; the handler evaluates this in-process at $export.",
  fhir_client_active:
    "Route-unbound and fail-closed by design (28-fhir/abac-predicates.ts): evaluated in the FHIR handler against the client row, not through M3.",
  fhir_export_recipient_authorized:
    "Route-unbound and fail-closed by design: the per-resource consent intersection runs at egress inside the export job.",

  // ── packages/scheduling — a policy-engine gate list, not M3 predicates ────────────────────────────
  clinician_membership_active:
    "A PRE_SCHEDULE_GATE_PREDICATES name evaluated by the scheduling policy engine at publish time; it is not registered with M3 and no route guard exists for it.",
  volunteer_gate_satisfied:
    "A PRE_SCHEDULE_GATE_PREDICATES name evaluated by the scheduling policy engine for volunteer visits only; not an M3 predicate.",
  drive_time_feasible:
    "A PRE_SCHEDULE_GATE_PREDICATES name evaluated by the scheduling policy engine; not an M3 predicate.",

  // ── M3 base predicates — modules compose their own PE/location predicates ─────────────────────────
  provider_entity_scope:
    "M3 base predicate (§4.2): the intrinsic seed. Modules gate PE scope through their own resolvers (see the authenticate hook note); no route composes the bare name.",
  location_scope:
    "M3 base predicate (§4.2): the intrinsic seed. Modules gate location scope through their own resolvers; no route composes the bare name.",
};
