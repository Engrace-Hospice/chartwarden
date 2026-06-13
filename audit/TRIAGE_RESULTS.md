# WardenX — Open-Blockers Triage Results

**Compiled:** 2026-06-13
**Method:** One agent per module read the **current** spec text + the 23 ADRs and dispositioned every
June-13 finding. Conservative rule: a finding is **RESOLVED-VERIFY only with hard current-spec evidence**;
otherwise **OPEN**. Companion to `audit/OPEN_BLOCKERS_LEDGER.md`.

---

## 🔑 Headline finding — "changelog says fixed, body says not fixed"

In the **majority** of modules, the spec carries a top-of-file *Remediation Changelog* / *re-lock
banner* asserting each finding was fixed per its ADR — **but the spec body was not edited to match.**
The agents repeatedly found: banner claims X resolved; the DDL / RLS SQL / enum / route table /
`§13` manifest patch still contains the original defect.

This means:
- The **ADRs are correct and ratified**; the architecture-layer decisions are sound.
- The **module spec bodies were largely not brought into conformance** — only a banner was prepended.
- Therefore most "OPEN" items are **mechanical conformance edits** to make the body match its own
  changelog + the governing ADR — not new design work.

Representative (agent-verified):
- **M22** — banner cites ADR-0020 etc., but §7.10 still embeds `{patientLastName}` in the signed-URL
  filename (F02), §3.2 still grants UPDATE on append-only tables (F08), footer still says "v0.4."
- **M34** — banner says `organization_id` added to 9 tables (F02) and `platform_ops` re-based on M3
  RBAC (F03), but the Drizzle schema, RLS SQL, and ABAC predicate bodies are all unchanged.
- **M36** — banner says `dependsOn` reverted to `[1,2,3,4]` (F01), but §12 checklist still lists
  `+[5,6,11,22,40]` and §4.6.1 still imports from `@wardenx/foundation`.
- **M39** — banner drops the invented manifest fields (F07) and the §164.528 claim (F03), but §13.1
  still carries the invented fields and §12.9 still asserts the §164.528 feeder.

---

## Disposition tally (per module)

| Module | Findings | RESOLVED-VERIFY | OPEN | STALE-FIX / DISPUTED |
|---|--:|--:|--:|--:|
| M02 | 19 | 6 | 13 | 0 |
| M03 | 13 | 10 | 3 | 0 |
| M07 | 15 | 2 | 13 | 0 |
| M09 | 12 | 1 | 11 | 0 |
| M10 | 20 | 3 | 17 | 0 |
| M14 | 19 | 1 | 17 | 1 |
| M15 | 12 | 4 | 8 | 0 |
| M16 | 16 | 5 | 11 | 0 |
| M18 | 17 | 1 | 16 | 0 |
| M19 | 15 | 4 | 11 | 0 |
| M20 | 17 | 2 | 15 | 0 |
| M22 | 27 | 2 | 24 | 1 |
| M26 | 20 | 0 | 19 | 1 |
| M30 | 21 | 1 | 20 | 0 |
| M34 | 17 | 1 | 16 | 0 |
| M35 | 18 | 0 | 17 | 1 |
| M36 | 14 | 4 | 10 | 0 |
| M39 | 15 | 1 | 11 | 2 (1 stale + 1 trim) |
| **TOTAL** | **307** | **≈48** | **≈252** | **≈7** |

> M03 is the standout: foundation re-lock (step-up F01, role catalog F06, permission-key F07, seam
> generalization F03) is genuinely implemented in the body — 10/13 resolved. M26/M35 are 0 resolved
> (banner-only). The big regulatory specs (M22, M30, M10) are almost entirely OPEN.

---

## ⛔ STALE-FIX / DISPUTED — do NOT apply the audit's recommendation verbatim

These would violate a ratified ADR or revert a correct value. Action is to **conform to the ADR**, not
to apply the audit "Fix" column.

| Finding | Why the audit fix is wrong | Correct action |
|---|---|---|
| **M26-F01** | ADR-0002 ratifies cap year = **Oct 1–Sep 30**; spec already conforms. Audit says "revert to Nov 1–Oct 31" → would reintroduce the pre-2017 bug. | None — RESOLVED. Verify ADR-0002 citation stays. |
| **M22-F01** | Audit's proposed `dependsOn` edges create the 22→6→39→22 cycle ADR-0006 + ADR-0005 reject. | Keep manifest minimal (`[1,5]`); trim the spec's §13 proposed patch; cite ADR-0005/0006. |
| **M35-F02** | Audit says "restore `34` to `dependsOn`"; ADR-0005 D1 + the manifest review confirm M34 is a seam consumer → **no edge**. | Leave `dependsOn` minimal; bind M34 via `TenantLifecycleProvider` seam + events. |
| **M39-F02** | Audit says keep `[1,2,3,4,5,22]`; ADR-0006 **drops 22** (and 36/38/40). Spec §13.1 wrongly re-adds them. | Trim §13.1 to `[1,2,3,4,5]` per ADR-0006 (this is an OPEN edit, not "don't touch"). |
| **M39-F07** | Audit fix aligns with ADR-0005 (drop invented manifest fields) — but the spec's §13.1 still carries them. | Trim §13.1 to `{id,name,codePaths,dependsOn,ownedTables}`; registrations live in boot.ts. |
| **M14-F04** | **DISPUTED.** Agent marked STALE citing locked decision D15 (M14 owns notification composition). But **SD-017 (architecture) assigns this to M36**, and architecture wins over a module spec. | **Needs architecture-owner ruling**: either an ADR ratifying D15's cross-cutting role, or move the catalog to M36 per SD-017. Do not edit until ruled. |

---

## RESOLVED-VERIFY (already conformant — do not touch)

- **M02:** F01, F02, F04, F07, F10, F11
- **M03:** F01, F02, F03, F04, F05, F06, F07, F09, F10, F12
- **M07:** F06, F08
- **M09:** F03
- **M10:** F01, F02, F09
- **M14:** F11
- **M15:** F02, F05, F06, F07
- **M16:** F01, F09, F10, F12, F14
- **M18:** F01
- **M19:** F03, F04, F09, F10
- **M20:** F04, F10
- **M22:** F03, F18
- **M30:** F01
- **M34:** F09
- **M36:** F06a, F06b, F06c, F06d (the unified-dispatch/enum/CHECK fixes)
- **M39:** F10

---

## OPEN (~252) grouped for batched remediation

**Cross-cutting mechanical sweeps** (one rule, recurs across many modules — safe, high-volume):
- RLS session var → `app.org_id` + `WITH CHECK` (ADR-0010): M07-F08(done elsewhere)…, M14-F11(done), M20-F03, M22-F09, M30-F12, M34-F02, M36-F04, M39 (various).
- Missing 3-column tenancy (`provider_entity_id`/`location_id`) (ADR-0010): M19-F02, M34-F02, M36-F04 (+ already-done M07/M09/M10/M15).
- §20.B template sections — Idempotency-Key, queue DLQ/retry, STRIDE, DR-tier, cursor pagination, sqlcipher (ADR-0021): present as OPEN in nearly every module (M02-F09/F13/F19, M07-F09/F10/F11/F12, M09-F04/F06/F10/F12, M10-F10/F19, M14-F06/F09/F13/F17, M15-F10/F11, M16-F07/F08/F15, M18-F10/F11/F14, M19-F08/F12/F15, M20-F09/F15, M22-F11/F14/F24/F25/F27, M26-F08/F11/F17, M30-F05/F06/F07/F17/F18, M34-F06/F10/F16/F17, M35-F07/F08/F10, M36-F12).
- Wrong CFR citations (audit gives exact targets): M07-F03, M16-F16, M19-F11.
- PG16→PG18: M22-F24, M26-F18.
- Canonical app-dir names: M22-F26.
- Retention class → §24 matrix (ADR-0004): M02-F12, M10-F05, M16-F02, M19-F10, M22-F06, M30-F11, M35-F12, M36-F02/F10, M39-F06/F12/F13.
- `dependsOn`/manifest-patch trim to cite ADR-0005 (not open a new ADR): M02-F01/F04, M03-(done), M07-F02, M09-F02, M10-F03, M14-F02/F19, M15-F01, M16-F02, M18-F02/F03, M19-F01, M20-F01/F02, M22-F01, M26-F05, M30-F02, M34-F04, M35-F01/F03, M36-F01, M39-F02/F07.

**Cross-module ownership/seam fixes** (ADR-0011 / ADR-0013 / ADR-0023):
- Cross-module table import/FK/trigger → seam/reader: M10-F01(done), M26-F02, M30-F01(done)/F08, M35-F04, M39-F08.
- §164.528 disclosure writer placement (ADR-0013): M39-F03, M30-F14, M34-F08/F13, M22-F07.
- Part 2 gate-disclosure-not-creation (ADR-0014): M09-F05, M19-F09(done), M30-F14.

**Regulatory-judgment (needs SME sign-off — do NOT blind-edit):**
- M07-F01 (NP in IDG physician seat — CoP) & M14-F03 (RN coordinator).
- M10-F07 (CMS HOPE Section-J codes), M10-F02(done)/F15 (day-counting).
- M26-F13 (inpatient-cap denominator/overage math).
- M07-F04/F05 (IPOC content + review-clock), M15-F03/F04 (aide POC gate, volunteer ratio).

**OUT-OF-BAND (cannot be closed by editing markdown — legal/operational):**
- BAA/ZDR/QSOA execution & vendor security review: M18-F01(catalogued, exec pending), M19-F04, M22-F10, M26-F10, M36-F07 (TCPA), plus every INT-014 gate.
- Security-Owner sign-offs: M10-F12 (SECURITY DEFINER), M20-F16 (HR/legal consent posture).
- AI activation gates requiring BAA+ZDR: M14-F10, M16-F06.

**Internal-coherence reconciliation passes (ADR-0022) — large per-spec edits:**
- M18-F09, M19-F06, M22-F16/F19, M26-F06, M30-F03 — each is "two contradictory state machines / schemas / catalogs"; biggest single-spec efforts.

---

## Recommended execution order (revised after triage)

1. **Cross-cutting mechanical sweeps** — safe, ADR-governed, unambiguous; clears the largest count fastest. Run `arch:fitness` after each module.
2. **Foundation finish** — M02 (13 open) to match M03's done state; M03 has only 3 minor open (F08 STRIDE, F11 queue/retention, F13 typing).
3. **`dependsOn`/manifest trims** — apply ADR-0005/0006 to every spec's §13 patch (incl. the M39-F02/F07 and M22-F01 stale-fix corrections).
4. **Cross-module seam/ownership + §164.528 + Part 2** (ADR-0011/0013/0014).
5. **Internal-coherence reconciliation passes** (ADR-0022) — M18/M19/M22/M26/M30.
6. **Regulatory-judgment subset** — only with SME sign-off.
7. **OUT-OF-BAND tracker** — checklist of BAA/ZDR/QSOA + Security-Owner sign-offs; gates go-live, not spec completion.
8. **M14-F04** — escalate for architecture-owner ruling before editing.

---

## Sweep progress log

### Batch 1 — trivial mechanical (2026-06-13) ✅ applied, `arch:fitness` green

- **RLS session var → `app.org_id` (ADR-0010 D2)** — fixed in DDL/prose of **M18, M20, M26, M29, M35, M37** (token swap only; column already `organization_id`/`org_id`). Advances M20-F03 (var part; platform-floor pattern-2 still open). *Deferred: M22-F09, M25 — these use a `tenant_id` **column** and need the full §8.2 rewrite, not a token swap.*
- **Postgres 16 → PostgreSQL 18 (ARCH-270/SD-081)** — fixed in **M21, M22, M26, M30, M33**. Closes **M26-F18**; advances M22-F24 (PG part; DLQ/OTel/§9.2 artifact still open).
- **Canonical app-dirs (SD-001/ARCH-020)** — `apps/frontend-web→apps/frontend`, `-mobile→apps/mobile`, `-portal→apps/portal` in **M22, M31, M39**. Closes **M22-F26**.
- Verified: no residual `Postgres 16`, no residual `apps/frontend-{web,mobile,portal}`, no residual non-canonical `current_setting('app.*')` except the deferred M22/M25 `tenant_id`-column cases.

### Deferred from the "mechanical" sweep (moved to other tracks)
- **CFR citations (M16-F16, M19-F11, M07-F03)** → **SME track.** Reason: the audit's own M16 target (`418.56(c)` for the bereavement plan-of-care) is debatable vs `§418.64(d)(2)`; CFR is regulatory-judgment, not mechanical.

### Remaining sweep batches (not yet started)
- **Batch 2 — §20.B template sections** (ADR-0021): Idempotency-Key, queue DLQ/retry, STRIDE, DR-tier, cursor pagination, sqlcipher — recurs in ~all modules. Larger per-module additions.
- **Batch 3 — manifest/`dependsOn` trims** (ADR-0005/0006): trim each spec's §13 patch to the minimal edge set + cite ADR; includes the STALE-FIX corrections (M22-F01, M35-F02, M39-F02/F07).
- **Batch 4 — cross-module seam/ownership + §164.528 + Part 2** (ADR-0011/0013/0014).
- **Batch 5 — internal-coherence reconciliation passes** (ADR-0022): M18/M19/M22/M26/M30.

### Batch 3 — manifest/`dependsOn` trims (2026-06-13) — partial; `arch:fitness` green

Grounding: `architecture/module-manifest.ts` is the single source of truth (already minimal,
0 cycles). Each spec's §13 "proposed patch" over-claims. Done so far:

- **M39 — full §13.1 trim** (closes/advances F01, F02, F07): `dependsOn → [1,2,3,4,5]` (ADR-0006: 22 dropped, breaks 22↔39 cycle); codePaths → `[packages/consent, apps/backend/...]` (drops `packages/domain/consent`, F01); removed all invented `ModuleDef` fields (publishedSeams/consumedSeams/registers*/aiProhibitedSurface — F07). D22 row also corrected.
- **M22 — §13.1 binding diff trim** (closes F01 manifest part): `dependsOn → [1,5]` (ADR-0005/0006); removed invented `publishedSeams`/`forwardSeamsConsumed` fields; §13.2 rationale table reframed as relationship inventory.

**DISPUTES — RESOLVED 2026-06-13 (ADRs ratified Accepted + applied end-to-end):**
- **M35-F02** → **[ADR-0025](../docs/adr/ADR-0025-m34-m35-dependency-direction.md)** (Accepted). M34↔M35 ruled a bidirectional seam relationship. Applied: `module-manifest.{ts,cjs}` M35 `dependsOn [34]→[]`; M35 D23/D24 + M34 D23 cite ADR-0025. CLOSED.
- **M14-F04** → **[ADR-0024](../docs/adr/ADR-0024-m14-notification-composition-ownership.md)** (Accepted, Option A). Notification composition + recipient resolution for cross-module events moved to M36. Applied: 2 tables (`notification_template`, `tenant_notification_template_overlay`) moved M14→M36 in `module-manifest.{ts,cjs}` (M14 11→9, M36 13→15, total 451); M14 spec shed the role (D14/D15/D16 tombstoned, composers/tables/prose removed); M36 spec gained the tables (§3.13) + composition role (§4.11) + RecipientResolvers; M6/M22 consumer decls repointed to M36 (M11 already correct). `arch:fitness` green. CLOSED.

**Remaining (~21 specs) — NOT a blind sweep.** Every other spec's §13 carries the over-claimed
"relationship inventory" list. Per the prior `MANIFEST_DEPENDSON_REVIEW` the accepted resolution is
**keep the manifest minimal + annotate the spec list "do not bulk-apply" + strip invented ModuleDef
fields** — not force each spec to the manifest verbatim (the manifest has its own quirks: M34 omits 1,
M22 omits 2/3/4, etc., reflecting actual-import calls the module owner must confirm). Residual work per
spec: (a) ensure the §13 block carries the relationship-inventory clarifier inline, (b) strip any
invented `ModuleDef` fields, (c) flag any genuine direction-reversal as DISPUTED. Best done as a
per-module pass, not a corpus find/replace.

### Batch 2 — §20.B template sections (ADR-0021), wave 1 (2026-06-13) ✅ applied, `arch:fitness` green

Added the missing template sections (STRIDE, DR-tier+degraded-mode, BullMQ queue params/DLQ,
per-route Idempotency-Key, cursor pagination, sqlcipher offline, audit-event catalog) — tailored to
each module's real routes/queues/threats — to **6 modules**:
- **M02** (F09 STRIDE, F13 queue/idempotency/error-envelope, F19 DR Tier 1)
- **M07** (F09 idempotency, F10 queue, F11 STRIDE, F12 DR Tier 2 + gate fail-posture)
- **M09** (F04 sqlcipher, F06 idempotency, F10 DR Tier 2 + BCP, F12 queue + clinical-urgent alerts)
- **M14** (F06 queue, F09 STRIDE + authz matrix, F13 idempotency, F17 DR Tier 2)
- **M18** (F10 DR Tier 1, F11 idempotency, F14 §8 audit + queue DLQ, F16 OOB-payload)
- **M19** (F08 DR Tier 1 + BCP re-entry + boot-refusal removal, F12 queue + single cadence, F15 STRIDE + cursor + audit catalog)
Remaining Batch-2 modules (wave 2+): M03, M10, M15, M16, M20, M22, M26, M30, M34, M35, M36, M39.

### Batch 3b — strip invented ModuleDef fields (2026-06-13) ✅ applied, `arch:fitness` green

`ModuleDef` carries EXACTLY `{id, name, codePaths, dependsOn, ownedTables}` (ARCH-146/ADR-0005).
Stripped every non-canonical field from the §13 manifest-entry literals of **M16, M21, M25, M26,
M29, M32, M34, M35** (in addition to M22/M39 done in Batch 3). Removed fields included:
`publishedSeams`, `consumedSeams`, `forwardSeamDenyStubs`/`forwardSeamConsumers`,
`consumedOutboxEvents`/`emittedOutboxEvents`/`ownsOutboxEvents`/`outboxEventKinds`,
`prohibitedAiPromptTargets`, `riskProfile` (nested), `dataClassesOwned`,
`securityDefinerFunctions`, `rolesOwned`, `cronJobs`, plus the non-canonical metadata
`phase`, `tier`, `key`, `status`, `specVersion`, `specPath`, `displayName`. Each replaced with a
comment noting these are wired at boot, not in the manifest. This closes the **F07-class** invented-
field findings (M39-F07 etc.) and the **M16-F02 illegal `phase` field**. `dependsOn` values were left
unchanged (the edge-set trims are the separate, judgment-laden Batch-3 remainder; M35's dependsOn is
the disputed item).
