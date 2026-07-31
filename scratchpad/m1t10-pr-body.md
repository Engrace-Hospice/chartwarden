Implements the keystone follow-up from #107 (item 1): the **M1-T10 transactional outbox persister**, so module mutations actually write `outbox_event` rows. Unblocks real cross-module event emit for **M30 + M33** (M34 deferred — see below).

### What it does
- **`apps/backend/src/bootstrap/outbox-persister.ts`** —
  - `buildBootOutboxCatalog([M30,M33,M34])` assembles the full M1+M30+M33+M34 catalog at the composition root (`@wardenx/shared` is a leaf and can't import module event files), fail-closed on duplicate event names.
  - `buildTxOutboxPublisher(catalog)` validates each emit via `publishOutboxEvent` (the 3 catalog checks) then inserts the `outbox_event` row **through the caller's `withOrgContext` tx** (true transactional outbox).
  - `wireOutboxCatalog(db, catalog)` boot-populates `outbox_event_catalog` (fail-soft).
- **M30 + M33** `WriteOutboxPort` migrated `emit({eventName,payload})` → `publish(tx, {eventName, payload, organizationId, aggregateKind, aggregateId})`; every emit site threads the tx + org + uuid `aggregateId`. Port stays optional (unbound = no-op).
- Composition root binds M30 + M33 over per-module `callerModule`-pinned publishers. **M34 stays unbound** — its tenant-lifecycle emit payloads are non-conformant (generic payload + 4 phantom events in `CATALOG_LIFECYCLE_EVENTS`); binding it would roll back those mutations. Tracked in #107; its events are still in the boot catalog for collision-checking + future binding.

### Conformance (the regression guard)
A non-conforming payload now **rolls back its mutation**, so every emit was audited against its registered `payloadSchema`:
- **Real bug caught + fixed:** `m30.qapi.pip_closed` sent `projectId = linkedProjectId ?? ""` against a `minLength:1` schema → would have rolled back every *unlinked*-PIP closure. Fixed the payload (`?? null`) **and** the genuinely-wrong schema (`projectId: id → nullableId`, matching the nullable FK; empty string still rejected).
- All other 13 M30 + 3 M33 emit sites already conform. Added `m30-outbox.test.ts` + `m33-outbox.test.ts` (18 tests) asserting every emitted payload `Value.Check`s true against its schema, with negative cases.

### Stack
Top of the chain: `feat/m1-t10-outbox-persister` → `feat/m30-followup-wiring` (#108) → `feat/r2-m30-hqrp` (#106) → `main`. Intended to merge into `main` after #106 and #108 land.

Gate green: build + arch:fitness + **3301 tests**.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
