# WardenX × Archon — Deterministic Coding Setup

[Archon](https://github.com/coleam00/Archon) (coleam00) is an open-source **harness builder**:
it makes AI coding *deterministic and repeatable* by encoding your dev process as a YAML DAG of
nodes — AI steps (`prompt:`), deterministic gates (`bash:`), loops (`loop:` … `until:`), and human
approval (`interactive: true`). The **workflow structure**, not the agent's improvisation, controls
the flow.

WardenX is an ideal fit because Phase 0 already gives every task an **objective pass/fail** (the six
fitness gates + the per-module Definition of Done) and a **machine-readable spec source** (the
manifest). Archon's deterministic `bash:` gate becomes our fitness suite; the AI `prompt:` nodes do
the coding against a precise plan.

> **Heads-up on Archon versions.** The current `main` is the **TypeScript "harness builder"**
> (workflows in `.archon/workflows/`). The older Python "Archon OS" (task board + RAG, Supabase,
> Docker Compose on ports 3737/8181/8051) is archived on the `archive/v1-task-management-rag` branch.
> This guide targets the **current harness builder**. Verify command names against your installed
> version (`archon --help`, `archon workflow list`) — the schema is young and evolving.

---

## 1. Prerequisites (already satisfied in this environment)

| Need | Status here | Install if missing |
|---|---|---|
| Bun ≥ 1.3 | ✅ 1.3.5 | `curl -fsSL https://bun.sh/install \| bash` |
| GitHub CLI, authenticated | ✅ `gh` as `fabwebdev` | `brew install gh && gh auth login` |
| Claude Code | ✅ (you're in it) | `curl -fsSL https://claude.ai/install.sh \| bash` |

## 2. Install Archon

**Recommended (macOS) — Homebrew CLI:**
```bash
brew install coleam00/archon/archon
archon --version
```

**Or quick install (macOS/Linux):**
```bash
curl -fsSL https://archon.diy/install | bash
```
**Windows (PowerShell):** `irm https://archon.diy/install.ps1 | iex`

**Or full/from-source (also lets Claude Code self-configure it):**
```bash
git clone https://github.com/coleam00/Archon
cd Archon && bun install && claude    # then tell Claude Code: "Set up Archon"
```

## 3. "Connect" it to WardenX

The harness-builder Archon doesn't run as a long-lived MCP server you point a client at — it
**drives Claude Code from your repo**. So "connecting" = installing the CLI and running it from the
WardenX root:

```bash
cd /Users/fabrice/Apps/WardenX
archon workflow list      # should list bundled defaults + our wardenx-piv
archon                    # launches Claude Code in this repo under Archon's harness
# optional dashboard:
archon serve              # downloads + serves the web UI
```

> **Always run from the WardenX repo root, not the Archon repo** (per Archon's docs).

Our custom workflow lives at `.archon/workflows/wardenx-piv.yaml` (the documented override
location — repo-local workflows take precedence over Archon's bundled defaults).

## 4. How our pieces map onto Archon

| Archon concept | WardenX artifact |
|---|---|
| Workflow (YAML DAG) | `.archon/workflows/wardenx-piv.yaml` (plan → implement-loop → **validate gate** → fix → approve → PR) |
| AI `prompt:` node input | `docs/plans/M01-M02_VERTICAL_SLICE_PLAN.md` (the task plan) + the cited `docs/modules/` spec sections |
| Deterministic `bash:` gate | `bun run build && bun run arch:fitness && bun run test` — a task is **done only when this is green** |
| `until:` loop condition | "all tasks in the plan complete" / "gate green" |
| `interactive:` gate | human review before the PR |
| Knowledge grounding | the spec corpus in `docs/` + the manifest (`architecture/module-manifest.ts`); the plan tells the agent exactly which §sections to read |

## 5. Run the first slice

```bash
cd /Users/fabrice/Apps/WardenX
archon workflow run wardenx-piv --plan docs/plans/M01-M02_VERTICAL_SLICE_PLAN.md
```
(Or use a bundled equivalent: `archon workflow run archon-plan-to-pr` and point its plan input at the
same file — then override its validate step with our gate command. Inspect the bundled file first:
`.archon/workflows/defaults/archon-plan-to-pr.yaml`.)

The loop implements one plan task at a time in a **fresh context**, runs the fitness gate after each,
self-fixes on red, and pauses for your approval before opening the PR.

## 6. Determinism guardrails (non-negotiable, enforced by the gates)

1. **Manifest is law** — a task's `ownedTables`/`dependsOn`/`codePaths` come from
   `architecture/module-manifest.ts`. Never reshape the manifest to fit code.
2. **Architecture wins over specs** — e.g., the M1 spec references `packages/foundation`; it is
   **banned** (ADR-0005 D3). Seam interfaces → `packages/types`, outbox helper → `packages/shared`,
   `withOrgContext`+RLS → `packages/tenancy`, audit → `packages/audit`.
3. **Cross-module access is seam/outbox only** (no `dependsOn` edge) — `arch:tables` + `arch:boundaries`
   enforce it.
4. **PHI discipline** — RLS + `withOrgContext` keyed on `app.org_id`; three-column rule; `audit()` with
   the field denylist; register an eraser. `arch:tenancy` + `arch:gaps` enforce it.
5. **Every PR is green** — `arch:fitness` + `tsc -b` + Vitest, and the fitness fixtures stay red.

## Sources
- Archon repo: https://github.com/coleam00/Archon
- Archon docs: https://archon.diy · "The Book of Archon" tutorial (linked from the repo)
