# Design-Corpus Consistency Audit — 2026-08-14

Scope: all of [`docs/design/`](../docs/design/) — 8 root docs, 113 screen specs (10 directories),
`pencil-prompts/` — against `main`. Method: three parallel code-grounded audits (root docs;
core/clinical/compliance specs; revenue/admin/platform/portal/mobile/staffing/integration specs).
Companion to the architecture/module/ADR/plans audits of 2026-08-13/14.

**Context that shapes the verdict: this was already the best-gated corpus** (`docs:ui` internal
consistency, `ui:parity` spec↔implementation bridge, `frame:fidelity`) and it shows — all links
and ADR citations resolved, index parity was perfect, and the row-level data in the deferred-
screens ledger was accurate. **What the gates could not see was truthfulness against code**, and
that is where everything below was hiding. All severity-A/B findings are fixed in this merge.

## 1. The headline defects (root docs) — FIXED

1. **`DESIGN.md` still instructed destroying shipped work.** It claimed the token files "currently
   carry bootstrap-grade placeholders" and §11 said to replace `index.css` wholesale — false since
   the R0/R1 Lantern reconciliation. Following it would have deleted the `--space-*` scale and two
   shipped WCAG fixes (`--color-muted` moved to `#726d64` per WX-PR-018 — §11 still carried the
   AA-failing `#8C877F`). Now: an ADOPTED status banner, §11 marked historical with a
   do-not-paste warning, the muted token corrected, "69 specs" → 113, and §6.9's `cn()`/Radix
   primitives marked target (only `modal`/`confirm-dialog` are built).
2. **`FRONTEND_RECONCILIATION_SCOPE.md` understated the built surface ~3× in present tense**
   ("91 screens across 19/40 modules"; a "~53-screen zero-web backlog" — all shipped; real:
   290 screens across 41 module sets). Now carries a SUPERSEDED banner pointing at the
   gate-generated `audit/ui-parity/UI_PARITY.md`.
3. **`DEFERRED_SCREENS.md`** claimed to be "the single status source" while its own line ~464
   correctly defers to the generated parity report; its "merged backends" scope line listed 9
   modules (all 39 are merged); `packages/ui/src/api` → `core/api`. Row-level statuses were
   almost entirely accurate (1 genuinely-stale `deferred` row: User Profile & Preferences).
4. **The documented Pencil workflow was unrunnable**: four phantom MCP tool names
   (`batch_design`, `batch_get`, `get_editor_state`, `set_variables`, `snapshot_layout`) across
   `pencil-prompts/README.md`, `SCREENS.md`, `FRAME_FIDELITY_PLAYBOOK.md` — corrected to the real
   tool set (`get_app_state`/`execute`/`get_screenshot`/`export_nodes`). Stale "69 specs / 30 v2
   specs" counts corrected in `UI_README.md` (now v6, all 10 directories listed),
   `LAYOUT_PATTERNS` (derivation-set note + partial-coverage-matrix note), `SCREENS.md`
   (D1–D7 heading), and the playbook's exemplar set (only the M02 Auth screens are `matched`).

## 2. Screen-spec findings — the enum-drift class — FIXED

The dominant failure mode: a spec enumerating a status/severity/type vocabulary **in the
indicative** that drifted from the shipped DDL enum. Worst instances (all corrected in place):

- **Built surfaces (most dangerous):** notifications severity set (`INFO/WARN/MEDIUM/HIGH/CRITICAL`
  vs the shipped 3-value `alert_severity`); the ops outbox screen's `Pending/Published/Failed/
  Dead-Lettered` vs `pending|dispatching|dispatched|failed` (and retry/DLQ actions marked target —
  the shipped surface is two read-only routes); the consent type-picker omitting the live
  `bereavement_outreach_consent`; `/reset` vs the registered `/reset-password`; step-up described
  as a modal (it is a chrome-less full-page route by design).
- **Vocabulary corrections:** M23 claim states (DENIED is not Medicaid-only; PARTIAL_PAID added),
  NOE/NOTR states, `fhir_client_status` (both FHIR specs, which also contradicted each other),
  `mdm_baa_status`, auditor-engagement lifecycle, `hope_submission_status` + RFA kinds + validation
  severities, HL7 feed kinds (no MDM^T02 feed).
- **Permission keys:** `privacy.baa.manage`→`mdm.baa.manage`, `qapi.incident.manage`→real M30
  keys, `quality.audit.manage`/`quality.measures.configure`→`quality.measure.*`; nine invented
  `compliance.*`/`privacy.*`/`security.*` keys across five unbuilt-screen specs and the
  `validateM39AIBlock` symbol left annotated as proposed/target. Event names in three clinical
  specs corrected to registered `m6.*`/`dosespot.*` forms; Medicaid rule keys and the phantom
  `state_medicaid_mco`/`state_medicaid_program` tables annotated.

## 3. Enforcement added

`docs:ui` (`scripts/check-ui-screens.ts`) now also validates, corpus-wide including root docs:
four-digit ADR citations resolve and relative links resolve (29 citations · ~287 links).
Deliberately no cited-path or enum rule — specs are proposals; enum-vocabulary truth is this
audit layer (a future idea: derive a vocab lint from `packages/db/src/enums.ts`, recorded here,
not built).

## 4. Still-open (recorded, not fixed)

- The five unimplemented glossary base patterns (Assistant, Portal List, Media Room, Bed Board,
  Admin Console) remain deferred-to-first-use — accurate as stated.
- The six external-party portal specs (surveyor, DME vendor, facility nurse…) describe wholly
  unbuilt surfaces; M31's shipped grant kinds are patient/family-only. Legal proposals.
- `DESIGN_REVIEW.md`'s 120-vs-370 frame-count self-inconsistency (point-in-time doc, self-dated).
