> **This is a reusable audit prompt, not a generated report.** Running it produces a report at
> `docs/audits/GAP_ANALYSIS_<YYYYMMDD>.md` per the "Deliverable" section below.

You are a principal software architect performing a **comprehensive, evidence-based gap-analysis audit** of the WardenX hospice EHR monorepo at
`/Users/fabrice/Apps/WardenX`. You have read-only access to source code: do not modify source files, do not fix code, do not create commits. The **only file
you may write** is the final audit report under `docs/audits/`.

## Definitions

A **gap** is any concrete, verifiable instance where one of these holds:

- **Spec → impl drift**: a requirement in a spec or architecture doc has no corresponding implemented behavior.
- **Impl → spec drift**: implemented behavior contradicts or is not represented in the spec.
- **Stub / deny**: code explicitly returns `TODO`, `throw new Error("not implemented")`, a 403/501 deny-stub, or an empty placeholder.
- **Coverage hole**: an owned table, route, screen, or predicate lacks required migration, enrichment, RLS test, or ABAC registration.
- **Seam break**: a cross-module contract exists on one side but is unbound, stubbed, or silently fails on the other.
- **Security / compliance hole**: PHI, tenancy, audit, or governance control is absent, bypassable, or regressing.
- **Build / test failure**: any command in the fitness kit fails or emits non-green output due to a code defect (see "Test-infra vs. code failures" below).
- **Documentation rot**: a doc references a non-existent file, module, or behavior.

A **style issue, refactor opportunity, or "could be nicer"** is not a gap unless it masks one of the above.

## Execution protocol

1. **Workflow fan-out with fixed batching.** If your runtime supports parallel subagents or workflow steps, run this audit as a fan-out of **14 first-pass workers**:

   - **8 module-batch workers**, each covering 5 modules in numeric order and executing Sections 3 and 5 for its batch:
     - Batch 1: M01–M05
     - Batch 2: M06–M10
     - Batch 3: M11–M15
     - Batch 4: M16–M20
     - Batch 5: M21–M25
     - Batch 6: M26–M30
     - Batch 7: M31–M35
     - Batch 8: M36–M40
   - **6 section workers**, one each for: the fitness kit (Section 2), cross-module seams (Section 4), UI/UX parity (Section 6), security/compliance (Section 7), documentation (Section 8), and discovered gaps (Section 9).
   - Each worker returns structured findings with evidence; nothing is written to the final report until it passes the evidence verification pass below.
   - If your runtime does not support fan-out, execute sequentially in the same batch order, preserving the same section structure and evidence standards.
2. **No assumptions.** If you cannot verify a claim with a file read, grep, or command output, do not state it as fact. Put it in "Unverified assumptions."
3. **Evidence standard.** Every finding must include:

   - `file:line` or exact command + relevant output snippet
   - The specific spec/doc/architecture line it violates, if applicable
4. **Evidence verification pass.** Before any first-pass finding is admitted into the report:

   - **Every P0 and P1 finding** must be independently re-checked — re-read the cited `file:line` or re-run the cited command yourself (or via a dedicated verify worker) and confirm the evidence actually supports the claim as stated.
   - **A random ~20% sample of P2/P3 findings** gets the same re-check, to catch systematic worker error rather than assuming lower severity means lower risk of hallucination.
   - A finding that fails verification (citation doesn't exist, doesn't say what was claimed, or the gap doesn't actually hold) is **not silently dropped** — demote it to "Unverified assumptions" with the reason it failed, or drop it only if you can positively confirm no gap exists (state the check that disproved it).
   - A finding that passes verification is marked `"verified": true` in the JSON appendix; anything not run through this pass is `"verified": false`.
   - Do not let the orchestration/synthesis step simply concatenate worker output — evidence-checking is a separate step, not implied by the workers' own "cite your sources" instruction.
5. **Unknown unknowns.** After completing Sections 3–8, actively look for gaps not listed in this prompt (e.g., orphan routes, dead code, mismatched env vars, missing indexes, broken CI gates). Add them under "Discovered gaps."
6. **Severity rubric.** Use this rubric consistently:

   - **P0**: breaks prod, violates compliance/PHI/tenancy, blocks certification, or fails build/test due to code defects
   - **P1**: feature incomplete, seam broken, spec drift on a clinical/revenue path
   - **P2**: missing coverage, UI parity gap, doc drift, non-blocking stub
   - **P3**: cosmetic, minor inconsistency, low-risk placeholder
7. **Scope-based completion.** The audit is complete only when:

   - All 40 modules have been examined for Sections 3 and 5 (via the 8 batch workers).
   - All seams in Section 4 have been traced.
   - Sections 2, 6, 7, 8, and 9 have been fully executed.
   - Every P0/P1 finding — and the P2/P3 sample — has been through the evidence verification pass.
   - Every finding carries evidence.
     Do not stop early because a section looked clean; record "No gaps found" and list the checks run.

## Test-infra vs. code failures

When `bun run test`, `bun run arch:fitness`, or any live/RLS suite fails, classify the root cause before reporting:

- **Code failure**: a test fails because the implementation is wrong, incomplete, or violates a contract. Report as a gap.
- **Test-infra failure**: a test fails because of environment, harness, Docker/DB connectivity, missing services, snapshot drift, or flaky tooling. Do
  **not** report as a product gap; instead record it under "Global / systemic findings → Test infrastructure" with the failing suite, error, and remediation for
  the harness.

If you cannot determine which it is, mark it "Unverified" and explain why.

## 1. Grounding — read before analyzing

Read these in order:

1. `AGENTS.md`
2. `docs/README.md`
3. `docs/DEVELOPMENT.md`
4. `docs/architecture/WARDENX_ARCHITECTURE_v0_11.md`
5. `docs/architecture/ARCHITECTURE_25_15_FITNESS.md`
6. `architecture/module-manifest.ts` and `architecture/module-manifest.cjs`
7. `docs/modules/README.md`

State the authority hierarchy you will use when specs conflict.

## 2. Run the architecture-fitness kit

Execute each command and capture the full output. If any command fails, record it as a gap with the exit code and stderr.

- `bun install`
- `bun run build`
- `bun run arch:fitness`
- `bun run status:matrix`
- `bun run openapi:coverage`
- `bun run ui:parity`
- `bun run frame:fidelity`
- `bun run test`
- `bun run arch:abac-predicates`
- `bun audit`

For each command report: pass/fail, the metric it measures, and any non-green output. Classify any failure as code or test-infra per the note above.

## 3. Module-by-module implementation audit

For each module in your assigned batch:

- Locate its spec under `docs/modules/`.
- Locate `ownedTables`, `codePaths`, and `dependsOn` in `architecture/module-manifest.ts`.
- Verify schema tables have Drizzle migrations under `apps/backend/src/db/migrations/`.
- Verify routes exist under `apps/backend/src/modules/<nn>-<name>/`.
- Verify every route has OpenAPI enrichment (request/response contracts).
- Verify live RLS tests (`*.live.test.ts`) cover every owned table.
- Verify unit/integration tests run and pass.
- Identify any route that is a deny-stub or TODO.
- Identify any `requireAbac(_, "name")` guard whose predicate name is not registered in `packages/auth/src/abac/registry.ts`.

## 4. Cross-module seam audit

Trace and verify these seams. For each, report live / stubbed / missing and cite exact files.

- M23 → M26: `CapAccrualReader` / `CapSettlementProvider` consumption
- M26 → M27: CMS-1984-14 cap calc inputs
- M27 → M30: HCI/operational measure data binding
- M1 → M30: transactional outbox-row emit for quality events
- M30 → M33: metrics provider registration and event consumption
- M6 → M30: `DeathDischargeReader` for HOPE rollup
- M8 → M30: `SignedEncountersReader` for HVLDL inputs
- M40-free provider-entity resolver usage
- Per-job `withOrgContext` RLS on workers (recompute/outbreak)

Also search for any other cross-module imports/exports that are stubbed or dead-ended.

## 5. Spec vs. implementation drift

For each module in your assigned batch:

- Are all spec'ed routes present and enriched?
- Are request/response schemas accurate and complete?
- Are business rules enforced in code or only documented?
- Are error codes and status codes aligned with the spec?
- Are ownership/tenancy fields (`organizationId`, `tenantId`) present on every owned table and enforced in queries?

## 6. UI/UX parity audit

Using `docs/design/screens/` and `docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`:

- List every screen spec not yet registered in the implementation.
- List every registered screen with unknown `requiredPermission`.
- List every frame-fidelity mapping that is `pending` or `partial`.
- Identify duplicate screen ids or paths.
- Verify every `screens.ts` is wired into its `main.tsx`.

## 7. Security, compliance, and governance audit

Verify the 2026-06-27 remediation is intact:

- Production ABAC evaluator + `step_up_recent` wiring
- PHI-safe Fastify logging; no PHI in browser storage
- Chromed-route auth guard with fail-closed navigation
- PHI read-audit coverage gate (`apps/backend/src/bootstrap/plugins/read-audit.ts`)
- Production env validation (`apps/backend/src/bootstrap/env.ts`)
- M34 `platform.bypass_invoked` auditor
- Durable break-glass persistence (Drizzle store + live §2.2 branch)

Also scan for:

- Secrets or credentials in code
- Unregistered ABAC predicate names
- Missing RLS policies on owned tables
- Missing audit triggers on PHI tables

## 8. Documentation and corpus audit

- Identify any doc under `docs/` that references a non-existent file or module.
- Identify any module spec that contradicts the architecture docs; flag the conflict.
- Verify `docs/modules/README.md` links all resolve.
- Check for stale TODO comments or placeholders older than the current milestone.

## 9. Discovered gaps

List any gap not covered above. Examples to hunt for:

- Orphan routes not in any module spec
- Dead code or unreachable handlers
- Mismatched environment variables between `.env.example` and `apps/backend/src/bootstrap/env.ts`
- Missing DB indexes on foreign keys or tenancy columns
- Broken or missing CI gates
- Circular dependencies not caught by dependency-cruiser
- Inconsistent error formats across modules

## Deliverable

Write the audit report to:

- `docs/audits/GAP_ANALYSIS_<YYYYMMDD>.md`

If a file with that name already exists, append a timestamp suffix (`_HHMMSS`) rather than overwriting.

The report must be a single Markdown file with these exact sections:

### 1. Executive summary

- Total gaps by severity (P0 / P1 / P2 / P3)
- Top 5 risks that could break prod or block certification
- One-sentence overall health assessment

### 2. Fitness kit results

| Command | Pass/Fail | Metric | Non-green output | Failure class (code/test-infra/unverified) |

### 3. Per-module gap table

| Module | Area | Gap | Evidence | Severity | Verified | Recommended fix |

### 4. Cross-module seams table

| Source | Target | Seam | Status | Evidence | Verified | Risk |

### 5. Global / systemic findings

- Build/test failures (code)
- Test infrastructure failures
- Architecture-fitness failures
- Security/compliance gaps
- Documentation drift
- Discovered gaps

### 6. Remediation backlog

A prioritized task list. Each item must include:

- Exact file(s) to change
- What "done" looks like
- Verification command or test to run

### 7. Unverified assumptions

List anything you could not conclusively check and why, including any finding that failed the evidence verification pass.

### 8. Machine-readable appendix

Append a fenced JSON block with this schema:

```json
{
  "generated_at": "<ISO timestamp>",
  "repo": "WardenX",
  "summary": { "p0": 0, "p1": 0, "p2": 0, "p3": 0 },
  "gaps": [
    {
      "id": "GAP-001",
      "severity": "P0|P1|P2|P3",
      "category": "spec-drift|stub|coverage|seam|security|build|doc|discovered",
      "module": "M01|M02|...|M40|global",
      "title": "...",
      "evidence": ["file:line", "command output"],
      "verified": true,
      "recommended_fix": "...",
      "verification": "..."
    }
  ],
  "test_infra_failures": [
    {
      "suite": "...",
      "error": "...",
      "remediation": "..."
    }
  ]
}
```

## Rules

- Cite every claim with file:line or command output.
- Do not report style issues or refactors unless they mask a real gap.
- Prefer "not implemented/stubbed" over "missing" when the code explicitly denies or returns TODO.
- If a spec and architecture conflict, architecture wins; note the conflict explicitly.
- Do not stop at the first batch of failures. Complete all sections.
- If a section produces zero gaps, state "No gaps found" and show the checks you ran.
- Every P0/P1 finding must show `"verified": true` with a distinct verification step from its original discovery, or it must appear in "Unverified assumptions" instead of the gap tables.

Begin the audit now.
