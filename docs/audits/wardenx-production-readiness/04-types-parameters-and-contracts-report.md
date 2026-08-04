# 04 — Types, Parameters & Contracts Report

**High: 4 · Medium: 4 · Low: 5 · Verified-fixed: 4.** Baseline strong: `tsc -b` exits 0 under `strict: true`; zero real `as any`/`: any`/ts-suppressions in any src. The risk is contract drift, not raw `any`.

> **Cross-dimension link:** PARAM-001 (headers unrepresentable in OpenAPI) and PARAM-002
> (summary-only enrichment hides the real body/202) are the *contract* root of **FLOW-008** — the
> M23 claim writes that fail at runtime because the client cannot express `Idempotency-Key`/`If-Match`.
> Fixing the emitter (headers + non-200 status) and de-casting the web API layer (TYPE-001) removes
> both the contract lie and the ~275 stale casts that hide it.

Generated files analyzed for drift: `docs/api/openapi.json` (emit.ts + enrichments.ts), `packages/ui/src/core/api/schema.ts` (66,917 lines).

## Raw pattern counts (src, non-test)

| Pattern | apps/backend | apps/web | apps/portal | apps/admin | packages/* |
|---|---|---|---|---|---|
| `as any` / `: any` / ts-ignore | 0 | 0 | 0 | 0 | 0 |
| `as unknown as` | 137 | 257 | 8 | 14 | 8 |
| `as never` | — | 138 | (212 total across 3 SPAs) | — | — |
| non-null `x!.` | 31 | 1 | 0 | 0 | — |
| `JSON.parse(` | 17 | 4 | 0 | 0 | — |

## PARAM-001 — If-Match / Idempotency-Key headers unrepresentable in OpenAPI (0 header params across 1,217 ops)
- **High** / P1 / High confidence / Blocker: No (runtime works; the contract lies)
- Evidence: openapi.json scan — 0 `in:"header"` params; `scripts/openapi/emit.ts` has no "header" support. Runtime requires them everywhere: `modules/23-billing-medicare/routes/claims.routes.ts:296` (IDEMPOTENT, IF_MATCH preHandlers), same M7/M8/M21/M25/M26/M27. Frontend: `apps/web/src/modules/23-billing-medicare/claim-editor.tsx:180-184` sends If-Match inside `init as never`.
- Fix: headers enrichment field (or derive from preHandlers); regen client; delete obsoleted casts.
- Acceptance: If-Match declared on every requireIfMatch route; `as never` count drops; client:check green.

## PARAM-002 — Summary-only enrichment satisfies the gate; body/headers/202 absent — M23 claim submit proven
- **High** / P1 / High / Blocker: No
- Evidence: `scripts/openapi/enrichments.ts:3362-3364` submit entry = summary only; emitted requestBody null, responses {"200":"OK"}. Runtime `claims.routes.ts:293-306` enforces If-Match + step-up + idempotency, returns 202. Systemic: **45 `code(202)` sites in modules, 0 `"202"` in openapi.json; emit.ts:125-133 hardcodes "200"**. Client op → `requestBody?: never`; claim-editor casts path+init as never.
- Fix: (1) real body+response+status for submit/replace/void; (2) `status?: 200|201|202|204` in enrichment shape; (3) ratchet treats body-less POST/PUT/PATCH as unenriched unless annotated.

## TYPE-001 — ~275 stale casts in web/admin API wrappers mask now-fully-typed contracts
- **High** / P1 / High / Blocker: No
- Evidence: `apps/web/src/modules/21-supplies/supplies-api.ts:446-448` casts as never + `as unknown as CursorPage` while openapi.json now emits ALL 7 query params AND the full response schema; header comment claiming "not TypeBox-published" is STALE. Concentrations: 19-oncall/oncall-api.ts 37+38, 21-supplies 37+37, 16-bereavement 33+33, 20-field-safety 30+30; admin M35 screens (dunning.tsx:46, webhooks.tsx:43, promos.tsx:43, plan-edit.tsx:62, revenue.tsx:42-44).
- Consequence: a server DTO rename breaks these screens at runtime only — a parallel, ungated contract.
- Fix: mechanical de-cast to schema.ts types; where headers block removal, fix PARAM-001 first.
- Acceptance: zero as-never/as-unknown-as in the 4 web api files + admin M35 screens.

## TYPE-002 — Portal read DTOs `{items: Record<string,unknown>[]}` — CONFIRMED-PRESENT
- **Medium** / P2 / High
- Evidence: `modules/31-portal/routes/portal-typebox.ts:108-111` (LayListResponse); wire = patternProperties `^(.*)$`. 8 casts: apps/portal/src/screens/{visits.tsx:83, documents.tsx:43, bereavement.tsx:51, amendments.tsx:52, medications.tsx:67}.
- Fix: per-category TypeBox row schemas. Acceptance: no patternProperties under /api/v1/portal/*; 8 casts deleted.

## TYPE-003 — 113 mutating ops with never-typed bodies in the generated client
- **Medium** / P2 / High
- Evidence: 696 POST/PUT/PATCH bindings, 113 `requestBody?: never`; 118 ops no response content (concentrated M29 /api/admin/externalinterfaces/*). Mixed population: some genuinely body-less (consent sign, cap period close), some genuinely-bodied (claim submit) — nothing distinguishes them.
- Fix: explicit `body: null` annotation for deliberate body-less actions; ratchet flags unannotated omissions.

## PARAM-003 — Money: float arithmetic + Type.Number() money at three billing edges
- **Medium** / P2 / Medium
- Evidence: `modules/25-remittance/events-by-m25.ts:19` money = Type.Number() (835 amounts in event contracts); `25-remittance/routes/read-service-drizzle.ts:223` `totalDollar += Number(row.dollar)` float accumulation then toFixed(2); `23-billing-medicare/services/cap-projection-adapter.ts:45` Math.round on float; `26-cap/routes/write-service-drizzle.ts:219,348` Number(a.weight) in settlement calc. Elsewhere cents-integer/decimal-string discipline holds (M21, M35 clean).
- Fix: decimal-string money in m25 events; integer-cents/SQL sums; decimal-aware weight kernel.

## PARAM-004 — Date-only strings parsed as UTC instants; UTC "today" for org-local dates
- **Low** / P3 / High
- Evidence: `apps/web/src/modules/22-documents/patient-documents.tsx:235-241` new Date(dob) off-by-one in negative offsets; dup in 13-emar/patient-emar.tsx:253, 07-care-plan/care-plan-view.tsx:358, 09-assessments/assessment-timeline.tsx:245. Backend UTC-today: 09-assessments db:87, 37-ipu service-drizzle.ts:1122, 16-bereavement death-discharge.ts:70; 17-scheduling routes:109 slices UTC instant for ABAC serviceDate.
- Fix: shared local date-only helper; org-timezone today server-side.

## TYPE-004 — Wire enums as bare Type.String() (stragglers: M4 + portal)
- **Low** / P3 / Medium. `modules/04-audit/routes/audit-typebox.ts:39-42,68-69` (actorKind, eventType, resourceKind, outcome, severity); portal status LayStr. M8/M24/M25 pinned — these are stragglers.

## TYPE-005 — `tx as unknown as DbClient` idiom (~90 sites); `row!` after .returning() (31)
- **Low** / P3 / High. 08-encounters db:238 (+19), 11-orders (21), 07-care-plan (17), 10-hope (9), 09-assessments (8); non-null asserts in 14-idg db:183,396-401,572-578,616,663-664,707-738. Fix: Queryable interface; `one(rows)` asserter.

## TYPE-006 — JSON.parse inventory: cursor decoders guarded-but-cast; one unvalidated element shape
- **Low** / P3. 15/17 backend sites are guarded cursor decodes; `05-patient/patient-route-service-db.ts:91-93` checks only array length before casting `[string,string,string]` (worst case 500; injection-safe).

## Body-validation posture — VERIFIED SOUND (M26 class did not recur)
Sampled M2, M8, M9, M14, M17, M18, M23, M26, M28, M31, M36, M37, M39: every mutating handler uses per-module `parse(schema, request.body)` (Value.Convert + Value.Check + ValidationError, e.g. encounters-typebox.ts:420-431, with compile-time Conforms<> locks). The 23 remaining `request.body as` sites are pre-validation ABAC target lifts or webhook raw-body reads that never feed the write path. **Caveat: Fastify native `schema:` validation used in 0 files — validation is 100% convention; consider a fitness check that every mutating handler references `parse(`.**

## Verified-fixed
- **M26 unvalidated body casts — FIXED**: m26-typebox imported by all 4 route files (cap.routes.ts:20, settlement.routes.ts:9, psr.routes.ts:8, platform.routes.ts:9); regression suite `__tests__/m26-request-validation.test.ts`; pattern propagated to M15/M24.
- **Raw-any hygiene — CLEAN** across all apps/packages.
- **Enum pinning in newer billing DTOs — largely done** (stragglers TYPE-004).

## Inventory table (worst load-bearing instances)

| Sev | File:Line | Pattern | Consequence | Fix |
|---|---|---|---|---|
| High | scripts/openapi/emit.ts:125-133 | success hardcoded "200" | 45 runtime-202 routes documented 200 | status in enrichment |
| High | scripts/openapi/emit.ts | no header support | If-Match/Idempotency-Key absent from 1,217 ops | emit headers |
| High | scripts/openapi/enrichments.ts:3362 | summary-only claim-submit | gate-green contract-less billing action | body+status; tighten ratchet |
| High | apps/web/.../claim-editor.tsx:182 | POST(path as never, init as never) | billing writes untyped | follows above |
| High | apps/web/.../supplies-api.ts:446 (+3 files, ~275) | stale mirror casts | ungated parallel DTO contract | de-cast |
| Med | 31-portal/portal-typebox.ts:110 | Record(String,Unknown) items | portal wire = anything; 8 casts | row schemas |
| Med | 25-remittance/events-by-m25.ts:19 | money = Type.Number() | float dollars in events | decimal string |
| Med | 25-remittance/read-service-drizzle.ts:223 | float dollar accumulation | penny drift | cents/SQL SUM |
| Med | schema.ts | 113 never-bodied mutations; 118 content-less responses | omissions look legitimate | body:null annotation |
| Low | patient-documents.tsx:235 (+3) | new Date(dob) | DOB off-by-one | local date parser |
| Low | 04-audit/audit-typebox.ts:39-42 | enums as Type.String() | no exhaustiveness | literal unions |
| Low | encounters db:238 (~90) | tx as unknown as DbClient | compiler blind | Queryable iface |
| Low | 14-idg db:183+ | row! after returning() | TypeError vs envelope | one() asserter |
| Low | 05-patient db:91 | cursor elements unchecked | 500 on crafted cursor | typeof checks |
