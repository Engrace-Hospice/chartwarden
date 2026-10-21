# ChartWarden — Manifest `dependsOn` Review (proposed-patch add-edge analysis)

**Status:** Architecture review — recommendation for the architecture owner to ratify.
**Scope:** The ~26 module specs that carry an unapplied "proposed manifest patch" changing
`dependsOn`. Companion to `FITNESS_ENFORCEMENT_AUDIT.md` and `FITNESS_EVENT_SEAM_CATALOG.md §E`.
**Inputs:** `architecture/module-manifest.ts` (post inverted-edge removal) + the per-spec patch
targets, analyzed by `scripts/audit-fitness.ts` and an ad-hoc transitive cycle pass.

---

## 1. Governing principle (ADR-0005)

`dependsOn` encodes **compile-time import edges only**:

- **D1 — seam/outbox consumption needs NO edge.** Consuming another module purely via an
  outbox event (event name + payload type in `packages/types`) or a boot-registered seam
  (interface in `packages/types`, impl injected at boot) adds **no** `dependsOn` edge — both
  channels are leaf-typed and runtime-wired, so there is no cross-package import to forbid.
- **D4 — foundation helpers need NO edge.** `packages/audit` (M4), `packages/auth` (M2/M3),
  `packages/tenancy` (M1), `packages/db/src/schema` are importable by every module without a
  `dependsOn` edge. So an "add M1/M2/M3/M4" proposal is **categorically rejected** as an edge.
- **D5 — any edge delta requires a transitive cycle analysis**, not just a direct-edge check.

The manifest is therefore intentionally **minimal**: it lists only genuine compile-time
imports, and it is the single source of truth the dependency-cruiser import rules are
generated from. A spec's prose **"Depends on:"** list is a *relationship inventory* (imports +
seams + outbox + foundation) and is legitimately a **superset** of `dependsOn`.

---

## 2. What the proposed patches actually are

Aggregated across the ~26 patch-carrying specs, the proposed `dependsOn` targets contain
**186 add-edges** beyond the current (minimal) manifest. Classified:

| Category | Count | Disposition |
|---|--:|---|
| **Foundation helpers (1–4)** | 63 | **NO-EDGE** — auto-rejected per **D4** |
| **Cycle-forming** (adding the edge closes a cycle) | 4 | **NO-EDGE** — provably seam/outbox per **D1** (an edge here is illegal) |
| **Acyclic candidates** | 119 | **Default NO-EDGE** — per the seam/event catalog these are seam/reader/outbox consumption; an edge is justified *only* where a spec states a real compile-time import of the producer's package |

**Headline finding:** applying every proposed target verbatim as edges produces **12 import
cycles** (§3). Cycles are illegal (no-circular rule). Therefore the proposed targets **cannot**
be the edge set — they are relationship inventories. **Recommendation: do not bulk-apply the
proposed `dependsOn` targets.** Keep the manifest minimal; the inverted-edge removals already
applied (M9/M10/M11→M8, M22→M39) were the only corrections the *edge set* required.

---

## 3. Cycle proof (maximal proposed graph)

With every proposed target applied verbatim, the `dependsOn` graph contains 12 cycles,
including:

```
M11 -> M29 -> M11
M12 -> M28 -> M12
M28 -> M13 -> M28
M23 -> M26 -> M23
M11 -> M29 -> M27 -> M12 -> M11
M29 -> M27 -> M12 -> M28 -> M29
M23 -> M26 -> M25 -> M24 -> M23
…
```

Each cycle is a pair/loop of modules that consume each other — which **must** be realized as
seam/outbox (no-edge), exactly as ADR-0005 D1 intends. The current manifest is **acyclic (0
cycles, 153 edges)** and stays so.

---

## 4. Per-edge disposition

### 4a. Provably NO-EDGE — cycle-forming (4)
An edge here would create an import cycle; the relationship is necessarily seam/outbox:

| Proposed edge | Closes cycle with | Realize as |
|---|---|---|
| `M11 → M29` | M29 → M11 (M29 consumes M11 `OrderProvider`/ORM seam) | seam/outbox |
| `M12 → M28` | M28 → M12 (M28 projects M12 `MedicationRequest`) | seam |
| `M13 → M28` | M28 → M13 (M28 projects M13 `MedicationAdministration`) | seam |
| `M23 → M26` | M26 → M23 (M26 reads M23 `ClaimDayProjectionProvider`) | seam |

### 4b. Auto NO-EDGE — foundation helpers (63)
Every proposed `+1 / +2 / +3 / +4` across M12/M13/M14/M17/M18/M19/M20/M21/M22/M23/M25/M26/
M27/M28/M29/M30/M34 — rejected per **D4** (audit/auth/tenancy/db-schema are import-free).

### 4c. CONFIRMED NO-EDGE — acyclic candidates (119) ✅ per-spec pass complete
These do not form a cycle, so the cycle test alone cannot reject them — so each was confirmed
against its owning spec's **patch rationale**, which states the consumption mechanism per dep.
**Every rationale is outbox / seam / reader / forward-seam** — none is a compile-time import of
another module's feature package. Representative (verbatim from the specs):

| Proposed dep | Spec rationale | Mechanism → disposition |
|---|---|---|
| M16 → 22 | "emitting `m16.bereavement.outreach_artifact_requested` **to** M22" | outbox → **no-edge** |
| M16 → 8 | "**subscribing to** `m8.encounter.signed`" | outbox → **no-edge** |
| M16 → 39 | "M39 **owning** the per-contact consent gate" | ConsentEvaluator seam → **no-edge** |
| M16 → 38 | "**referencing** the relationship value set" | TerminologyProvider seam → **no-edge** |
| M16 → 40 | "discipline taxonomy / MDM catalog **consumed**" | MDM reader seam → **no-edge** |
| M16 → 9 | "**forward seam** — the column is nullable…" | forward seam → **no-edge** |
| M11 → 5 | "referencing `patient.id`" | PatientReader seam → **no-edge** |

Cross-check: the only "imports `packages/…`" statements in the corpus are either *forbidden*-
import rules ("dependency-cruiser fails CI") or "only the interface / only the seam types" —
i.e. seam access. **Result: 0 of the 119 are compile-imports; 0 edges added.** The current
minimal `dependsOn` set is complete and correct; no further manifest change is warranted.

---

## 5. Recommendation

1. **Keep `dependsOn` minimal and as-is.** Do not apply the proposed targets as edges — they
   over-specify (relationship inventory) and would introduce 12 cycles.
2. **The edge corrections are done:** inverted `M9/M10/M11 → M8` and incorrect `M22 → M39`
   removed (`fix(manifest): remove inverted dependsOn edges`).
3. **Spec patch notes reworded — DONE.** Each of the 26 patch-carrying specs now carries an
   inline clarifier after its `dependsOn from […] to […]` target: *"relationship inventory —
   not the `dependsOn` edge set; per ADR-0005 D1/D4 seam/outbox/foundation consumers are
   no-edge — see audit/MANIFEST_DEPENDSON_REVIEW.md; do not bulk-apply"* (47 insertions).
4. **Manifest header guard — DONE.** `architecture/module-manifest.ts` now warns explicitly
   against bulk-applying the spec targets and points here.
5. **No fitness-gate change required** — `arch:fitness` already enforces acyclicity + ownership
   on the correct minimal manifest (40 modules, 451 tables, 153 edges, 0 cycles).

**Net:** the 119 acyclic candidates were confirmed per-spec as **all no-edge** (0 compile
imports); no further manifest change is warranted. The minimal `dependsOn` set is complete and
correct, and the spec/manifest guards prevent a future drift-inducing bulk-apply.
