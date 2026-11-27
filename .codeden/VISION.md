---
# .codeden/VISION.md — ChartWarden (Engrace-Hospice/chartwarden)
# Boundary and scoring contract for scout, worker and reviewer agents.
# The YAML block is the contract. The prose below explains it. If they disagree, the YAML wins.
# AGENTS.md / CLAUDE.md say HOW to build and test. This file says WHAT may be touched and WHY.
vision_version: 1
reviewed_on: 2026-11-26            # zones derived from main @ a669125 (2026-11-25), 14-day window
review_cadence: weekly             # see "Weekly maintenance"
phase: pre-go-live-hardening       # all modules implemented; synthetic data only; no live tenant PHI

autonomy:
  mode: full-loop                  # scout -> issue -> worker -> checks -> cross-provider review -> merge
  pr_base_branch: develop          # never main: a push to main deploys to the production VPS
  auto_merge:
    into: develop
    classes: autonomous_pr         # see change_classes
    zones: target_improvement_domains
    requires:                      # ALL must hold; if any is missing or unknown, leave the PR for a human
      - pr-ci-green                # the PR workflow on develop ran and passed (not a local claim)
      - cross-provider-review-approved
      - security-scan-clean
      - no-frozen-or-active-or-warm-path
      - within-diff-limits
      - red-before-green-after-in-git-log
    max_per_day: 6
  never_auto_merge: [red_test_only_pr, "any PR outside target_improvement_domains"]
  promote_develop_to_main: human-only
  on_develop_ci_break: revert-own-merge-then-pause
  pause_after_consecutive_failures: 3
  on_subscription_limit: stop-all-sessions   # never fall back to a pricier model or API billing
  max_open_factory_prs: 5
  max_concurrent_workers: 2
  max_concurrent_live_suites: 1    # live suites DROP ROLE cluster-wide; they cannot run in parallel
  max_issues_per_scout_run: 3
  ci_dispatch: human-only          # never `gh workflow run`; Actions minutes are metered

diff_limits:
  max_changed_lines: 300           # excludes generated reports, lockfiles, snapshots
  max_files: 10
  concerns_per_pr: 1
  layers: "one module, or one package, per PR"

# Any PR touching these paths is refused. Scouts may file an ISSUE about them; workers never edit them.
frozen_paths:
  # change management, harness, compliance register (CODEOWNERS)
  - .claude/**
  - .agents/**
  - .codex/**
  - .codeden/**
  - .githooks/**
  - .github/**
  - .gitleaks.toml
  - .trivyignore.yaml
  - bunfig.toml
  - AGENTS.md
  - CLAUDE.md
  - CONTEXT.md
  - compliance/**
  - scripts/harness/**
  - scripts/check-*.ts
  - scripts/*allowlist*.ts
  - scripts/*baseline*.ts
  - scripts/outbox-deferred-consumers.ts
  - scripts/outbox-subscription-exceptions.ts
  # architecture authority
  - architecture/**
  - docs/architecture/**
  - docs/adr/**
  - docs/modules/**
  - docs/plans/**
  # dependencies, build, deploy
  - "**/package.json"
  - bun.lock
  - "tsconfig*.json"
  - biome.json
  - Dockerfile
  - Dockerfile.web
  - docker-compose.yml
  - deploy/**
  - ops/**
  - services/**
  # schema and data
  - packages/db/migrations/**
  - packages/db/src/**
  - drizzle.config.ts
  # identity, authorization, audit, tenancy, consent
  - packages/auth/**
  - packages/audit/**
  - packages/tenancy/**
  - packages/consent/**
  - apps/backend/src/modules/02-identity/**
  - apps/backend/src/modules/03-authorization/**
  - apps/backend/src/modules/04-audit/**
  - apps/backend/src/modules/39-consent/**
  - apps/backend/src/bootstrap/**
  - apps/backend/src/index.ts
  # AI governance, vendor adapters with unverified contracts
  - packages/ai-platform/**
  - apps/backend/src/modules/32-ai-platform/**
  - packages/dosespot/**
  - apps/backend/src/modules/12-dosespot/**
  # generated — regenerate with the owning command, never hand-edit
  - audit/**
  - graphify-out/**

# In flight: humans are changing these daily. Scouts do not scan them. Workers do not open PRs in them.
active_zones:
  - apps/backend/src/modules/08-encounters/**
  - apps/web/src/modules/08-encounters/**
  - packages/hearthnote/**
  - packages/narrative-vocab/**
  - apps/backend/src/modules/10-hope/**
  - apps/web/src/modules/10-hope/**
  - packages/hope/**
  - apps/backend/src/modules/23-billing-medicare/**
  - apps/backend/src/modules/24-billing-medicaid/**
  - apps/backend/src/modules/25-remittance/**
  - apps/web/src/modules/23-billing-medicare/**
  - apps/web/src/modules/24-billing-medicaid/**
  - apps/web/src/modules/25-remittance/**
  - packages/billing/**
  - packages/medicaid-adapters/**
  - packages/x12-837-client/**
  - packages/x12-835-client/**
  - "apps/*/src/modules/07-care-plan/**"
  - "apps/*/src/modules/15-discipline-care-plans/**"
  - "apps/*/src/modules/16-bereavement/**"
  - "apps/*/src/modules/20-field-safety/**"
  - "apps/*/src/modules/21-supplies/**"
  - "apps/*/src/modules/22-documents/**"   # includes WardenLens
  - packages/intake-extraction/**
  - apps/web/src/shell/**
  - packages/ui/**
  - packages/types/**

# Warm: recent human work. Scouts may file issues and red-test-only PRs. No product-source edits.
warm_zones:
  - "apps/*/src/modules/05-patient/**"
  - "apps/*/src/modules/06-admission/**"
  - "apps/*/src/modules/09-assessments/**"
  - "apps/*/src/modules/14-idg/**"
  - "apps/*/src/modules/17-scheduling/**"
  - "apps/*/src/modules/18-evv/**"
  - "apps/*/src/modules/19-oncall/**"
  - "apps/*/src/modules/34-saas-tenant-platform/**"
  - e2e/**

# Open for hardening: quiet for 14+ days. Allowed change classes apply here in full.
target_improvement_domains:
  - "apps/*/src/modules/11-orders/**"
  - "apps/*/src/modules/13-emar/**"
  - "apps/*/src/modules/26-cap/**"
  - "apps/*/src/modules/27-cost-report/**"
  - "apps/*/src/modules/28-fhir/**"
  - "apps/*/src/modules/29-external-interfaces/**"
  - "apps/*/src/modules/30-quality/**"
  - "apps/*/src/modules/31-portal/**"
  - "apps/*/src/modules/33-reporting/**"
  - "apps/*/src/modules/35-subscription/**"
  - "apps/*/src/modules/36-messaging/**"
  - "apps/*/src/modules/37-ipu/**"
  - "apps/*/src/modules/38-terminology/**"
  - "apps/*/src/modules/40-mdm/**"
  - "apps/*/src/modules/41-billing-commercial/**"
  - apps/portal/**
  - apps/admin/**
  - packages/orders/**
  - packages/emar/**
  - packages/cap-management/**
  - packages/cost-report/**
  - packages/fhir/**
  - packages/reporting/**
  - packages/terminology/**
  - packages/mdm/**
  - packages/supplies/**

change_classes:
  autonomous_pr:                   # worker may open a draft PR in target_improvement_domains
    - missing-test                 # unit or dom test for existing, untested behaviour
    - error-envelope               # flat `{ error }` reply or swallowed error -> typed ChartWardenError
    - phi-in-log                   # a log line, error or event carrying a name or record content
    - accessibility                # WCAG 2.1 AA: labels, roles, focus order, contrast via existing tokens
    - read-path-performance        # N+1, missing pagination cursor, unbounded list; no schema change
    - type-tightening              # remove `any` / unsafe cast where the real type already exists
    - doc-link-rot                 # broken path or link in non-frozen docs
  red_test_only_pr:                # commit a failing test, title "F-NNN · red test only — needs a fix"
    - clinical-logic-defect        # HOPE items, assessments, eMAR, IPOC clocks, certification periods
    - money-logic-defect           # pricing, cap math, claims, remittance, cost report
    - any-defect-in-warm-zone
  issue_only:                      # file a GitHub issue with evidence; never a PR
    - tenant-isolation-or-rls
    - authorization-or-abac
    - audit-trail-gap
    - secret-or-credential-exposure
    - anything-in-frozen-paths
    - anything-in-active-zones
  forbidden:                       # never file, never fix
    - dead-code-removal
    - unused-export-or-file-removal
    - rename-or-move
    - formatting-or-style-sweep
    - dependency-add-or-bump
    - refactor-without-defect
    - new-feature-or-new-route
    - comment-or-wording-polish
    - weakening-a-gate-allowlist-or-test
    - feature-flag-default-change

scoring:                           # scout computes per finding; file only if score >= 8
  formula: "2*impact + evidence + confidence - blast_radius - collision"
  threshold: 8
  impact:        {5: "patient safety or wrong clinical record", 4: "wrong claim/payment or PHI exposure", 3: "user-blocking defect or WCAG A failure", 2: "untested regulated path", 1: "quality-of-life"}
  evidence:      {3: "failing test committed or attached", 2: "exact repro steps with file:line", 1: "static reading only", 0: "pattern match"}
  confidence:    {3: "checked against module spec AND ADRs", 2: "checked against spec", 1: "code only", 0: "guess"}
  blast_radius:  {0: "one file", 1: "one module", 3: "crosses a seam or event", 5: "shared package or contract"}
  collision:     {0: "path untouched for 14 days", 2: "touched in last 14 days", 5: "open PR or branch touches it"}

routing:                           # author and reviewer are never the same provider
  claude_haiku_low:    [missing-test, doc-link-rot, type-tightening]
  claude_sonnet_medium: [error-envelope, phi-in-log, read-path-performance, backend red tests]
  claude_opus_high:    ["scout triage for clinical-logic-defect and money-logic-defect", "max 4 sessions/day"]
  codex:               [accessibility, "all apps/web, apps/admin, apps/portal UI work"]
  review_of_claude_prs: codex
  review_of_codex_prs: claude_sonnet_medium   # claude_opus_high when the diff is in a patient-chart screen
---

# ChartWarden — vision for autonomous agents

## 1. What this product is

ChartWarden is a multi-tenant hospice EHR. Clinicians chart visits in it, the agency bills Medicare
and Medicaid from it, and surveyors audit it. Four properties outrank every other goal:

1. **Tenant isolation.** One agency never reads another's rows. RLS is enabled and forced, and proven live as the `chartwarden_app` role.
2. **A defensible record.** Signed clinical text is never overwritten. Every PHI read and write leaves an audit event.
3. **Fail closed.** An unbound seam, an unverified vendor contract or a missing agreement refuses. It never guesses.
4. **Architecture wins.** `docs/architecture/` outranks module and screen specs. Specs outrank your reading of the code.

An improvement that weakens any of these is a regression, whatever else it fixes.

## 2. Where the product is now

Phase: **pre-go-live hardening**. Every module has real implementation on `main`; the generated
status matrix (`audit/implementation-status/IMPLEMENTATION_STATUS.md`) is the per-module truth. All
data is synthetic. No tenant holds real PHI. Go-live is gated by human items in
`audit/GO_LIVE_ACTION_CHECKLIST.md` (agreements, sign-offs, SME confirmations), which no agent can close.

Humans are landing a very large number of changes a day. Assume any file was edited today. The job
of the factory in this phase is to **harden code the humans have moved away from**, and to hand
humans precise, evidenced findings everywhere else.

## 3. Incomplete is not dead

Never conclude that code is unused, abandoned or removable. In this repository the following are
deliberate, load-bearing states:

- **Deny-stubs and declared absences.** A seam registered with a denying stub, or a constant such as `HCI_UNAVAILABLE_INDICATORS`, is the designed behaviour.
- **Reasoned lists.** Entries in `scripts/*allowlist*.ts`, `scripts/outbox-deferred-consumers.ts` and `scripts/outbox-subscription-exceptions.ts` are tracked debt with an owner. They shrink by human decision.
- **Flags that default OFF.** AI capabilities, the Rust bridge (`RUST_*`), `DOSESPOT_PRODUCTION_ENABLED`. OFF is the shipped state.
- **Generated trees.** `apps/` and `packages/` scaffolding comes from `architecture/module-manifest.ts`. A thin or empty file may be a manifest slot.
- **Bridged routes.** Anything named in `RUST_BRIDGE_ROUTES` is being moved to the Rust service in another repository.
- **Preview entry points.** `apps/web/*-preview.html` and their sources are design-review surfaces.

"Bound is not computing" cuts both ways: no importer does not mean no purpose. Dead-code findings
are a forbidden class. If you believe something is truly orphaned, say so in one line inside an
issue you are filing for another reason.

## 4. What a high-signal improvement looks like

Ranked. Work the list from the top.

1. **An untested regulated path gains a test.** Clinical clocks, eligibility, pricing, claim assembly, retention. A test that would have passed before your change is not a test: commit it red first.
2. **A failure becomes loud and typed.** Swallowed errors, flat error replies, best-effort wrappers that hide a failed audit insert.
3. **PHI leaves a place it should not be.** Names or record content in logs, error messages, event payloads, URLs, client storage.
4. **A screen becomes operable by keyboard and screen reader.** WCAG 2.1 AA is the floor our customers are held to under HHS Section 504.
5. **A list stops loading everything.** N+1 reads, offset pagination, unbounded exports, with no schema change.
6. **A type tells the truth.** An `any` or cast replaced by the type that already exists.

Low signal, do not file: anything in `change_classes.forbidden`, a finding with no file and line,
a finding whose fix needs a migration, and any "consider" or "might" suggestion.

## 5. Rules for every factory PR

- Base `develop`. One concern. Within `diff_limits`. Open as draft; mark ready only when every `auto_merge.requires` item holds.
- Use `.github/pull_request_template.md` in full, including red-before/green-after transcripts and gate output.
- Local gates come first, PR CI second. Run `bun run typecheck && bun run arch:fitness && bun run test` locally and paste the output. Run the gates individually; a short-circuited chain proves nothing.
- Never run a live suite against the shared Docker cluster. Never run two live suites at once.
- If a gate, hook or `[chartwarden-harness]` deny blocks you, stop and file an issue. Do not route around it.
- If a generated report must change, regenerate it with its command. If your diff needs a frozen path to change, stop: it is an issue.
- Cite the module spec section or ADR that makes your change correct. Audit files under `audit/` carry stale "recommended fixes"; never apply one without checking the ADRs.
- A second agent from the other provider reviews every PR. Its approval is a merge requirement, so it reviews the diff cold, without the worker's reasoning.
- After an auto-merge, watch `develop`. If its checks go red, revert your own merge first, then file an issue.

## 6. Human-gated, always

Promotion of `develop` to `main` (that is a production deploy). Any merge outside `auto_merge`. Anything in `frozen_paths`. Migrations and schema. Auth, permission, RLS and audit logic.
Dependency changes. CI and deploy. Feature-flag defaults. Any vendor or external endpoint. Anything
that changes what a clinician signs or what a payer is billed.

## 7. Weekly maintenance (human)

Every Monday, or when a milestone lands:

1. List 14-day activity: `git log --since='14 days ago' --no-merges --name-only --format='' | grep -oE 'modules/[0-9]{2}-[a-z0-9-]+' | sort | uniq -c | sort -n`
2. Move modules that went quiet from `active_zones` to `warm_zones`, and from `warm_zones` to `target_improvement_domains`.
3. Move anything you are about to start into `active_zones` **before** you start.
4. Mirror `frozen_paths` into CodeDen's protected areas. Update `reviewed_on`.
