# ADR-0021 — §20.B module-spec template requirements made CI-gated (corpus-wide)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 6 (systemic template sweep)
- **Resolves:** X11; the per-route idempotency / queue-semantics / STRIDE / DR-tier / SEC-052 /
  cursor-pagination / offline-storage gaps across nearly every module
- **Changes:** `ARCHITECTURE_25_15_FITNESS.md`; every module spec (CI-gated)

## Context

The §20.B module-spec template lists required sections, but they were enforced by prose, so almost
every module is missing one or more: `Idempotency-Key` on mutating routes, full BullMQ queue
parameters, a STRIDE threat model, a DR tier + degraded-mode, SEC-052 bulk-export controls, cursor
pagination on PHI lists, and encrypted offline storage. These are not design choices — they are
platform invariants that were simply omitted.

## Decision

Each of the following becomes a **CI-gated template requirement** (a module spec / PR that omits it
fails the fitness pipeline), not optional prose:

1. **`Idempotency-Key` per mutating route** — every POST/PUT/PATCH/DELETE on a non-idempotent route
   declares the header + the 24 h / `409`-on-body-mismatch semantics (ARCH-263, M1 middleware).
2. **Full queue parameters** — every BullMQ queue declares `attempts` / backoff / concurrency /
   **DLQ** + an idempotent-consumer assertion (SD-059, DR-022). No queue ships with undeclared
   semantics.
3. **STRIDE threat model** — every module spec has a STRIDE section mapping its top threats to
   controls/tests (SEC-007).
4. **DR tier + degraded-mode** — every module declares its DR/BCP RTO/RPO **tier (1–5)** and its
   degraded-mode behavior; **Tier-1/2 services may not let any external dependency block
   documentation or medication administration** (DR-010). Owning modules of patient/clinical data
   feed the **Weekly BCP Print** pack (M05/M06/M11/M12/M13).
5. **SEC-052 bulk-export controls** — any export of >10 PHI records carries justification capture,
   1/hour/user rate limit, 10k-record cap (elevated approval beyond), 24 h URL TTL, and warn/critical
   severity + notification. (M04 §164.528 export, M22, M26, M28 `$export`, M33, M34 already pinned.)
6. **Cursor pagination on PHI lists** — every PHI-bearing list/search route uses opaque cursor
   pagination (`next_cursor` + `has_more`); **offset pagination is forbidden** on PHI lists (SD-052).
7. **Encrypted offline storage** — mobile/field offline PHI is stored in **encrypted SQLite
   (sqlcipher)**, never plain IndexedDB; screen-capture posture stated (SEC; M08/M09/M17/M22).

## Consequences

- `ARCHITECTURE_25_15_FITNESS.md` records these as template requirements; a template-completeness
  lint flags a spec missing a STRIDE / DR-tier / queue-params / idempotency section.
- The corpus-wide application is per-module reconciliation work (each module adds the missing
  sections); the requirement is now **enforced**, so the build stays red until a module conforms —
  the same gated-sweep model as the Phase-2 tenancy three-column rule (ADR-0010).
