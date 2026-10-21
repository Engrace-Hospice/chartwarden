# ChartWarden × Archon — Deterministic Coding Setup

[Archon](https://github.com/coleam00/Archon) (coleam00) is an open-source **harness builder**:
it makes AI coding *deterministic and repeatable* by encoding your dev process as a YAML DAG of
nodes — AI steps (`prompt:`), deterministic gates (`bash:`), loops (`loop:` … `until:`), and human
approval (`interactive: true`). The **workflow structure**, not the agent's improvisation, controls
the flow.

ChartWarden is an ideal fit because Phase 0 already gives every task an **objective pass/fail** (the six
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

| Need                      | Status here               | Install if missing                                 |
| ------------------------- | ------------------------- | -------------------------------------------------- |
| Bun ≥ 1.3                | ✅ 1.3.5                  | `curl -fsSL https://bun.sh/install \| bash`       |
| GitHub CLI, authenticated | ✅`gh` as `fabwebdev` | `brew install gh && gh auth login`               |
| Claude Code               | ✅ (you're in it)         | `curl -fsSL https://claude.ai/install.sh \| bash` |

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

## 3. "Connect" it to ChartWarden

The harness-builder Archon doesn't run as a long-lived MCP server you point a client at — it
**drives Claude Code from your repo**. So "connecting" = installing the CLI and running it from the
ChartWarden root:

```bash
cd /Users/fabrice/Apps/WardenX
archon workflow list                       # bundled defaults + our chartwarden-piv
archon validate workflows chartwarden-piv      # expect: 1 valid, 0 with errors
archon                                      # launches Claude Code in this repo under the harness
archon workflow status                     # monitor active runs (CLI; no web dashboard in v0.3.2)
```

> **Always run from the ChartWarden repo root, not the Archon repo** (per Archon's docs).
>
> **Verified here:** Archon **v0.3.2** is installed (`/usr/local/bin/archon`) and configured
> (`~/.archon/config.yaml`: `defaultAssistant: claude`, model `sonnet`). Loop nodes **require**
> `loop.max_iterations` (our `chartwarden-piv` sets 40 for `implement`, 10 for `fix`) — `archon validate
> workflows` enforces this.

Our custom workflow lives at `.archon/workflows/chartwarden-piv.yaml` (the documented override
location — repo-local workflows take precedence over Archon's bundled defaults).

## 4. How our pieces map onto Archon

| Archon concept               | ChartWarden artifact                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow (YAML DAG)          | `.archon/workflows/chartwarden-piv.yaml` (plan → implement-loop → **validate gate** → fix → finalize → auto-PR; no interactive approve — [ADR-0031](adr/ADR-0031-chartwarden-piv-no-interactive-approve.md)) |
| AI `prompt:` node input    | `docs/plans/M01-M02_VERTICAL_SLICE_PLAN.md` (the task plan) + the cited `docs/modules/` spec sections                                    |
| Deterministic `bash:` gate | `bun run build && bun run arch:fitness && bun run test` — a task is **done only when this is green**                                |
| `until:` loop condition    | "all tasks in the plan complete" / "gate green"                                                                                              |
| `finalize` + auto-PR       | review happens on the **GitHub PR** (no interactive pause — it hung under #1067; [ADR-0031](adr/ADR-0031-chartwarden-piv-no-interactive-approve.md)) |
| Knowledge grounding          | the spec corpus in `docs/` + the manifest (`architecture/module-manifest.ts`); the plan tells the agent exactly which §sections to read |

## 5. Run the first slice

The CLI shape is `archon workflow run <name> [message]` (no `--plan`/`--input` flag in v0.4.x). The
plan is chosen by the **run message**: the `setup` node greps a `docs/plans/*.md` path out of the
message and writes it to `.archon/run-plan.txt`, which every node reads. With **no message** it falls
back to the M1+M2 slice default, so just:

```bash
cd /Users/fabrice/Apps/WardenX
# isolated worktree (recommended) so the run can't disturb your working tree:
archon workflow run chartwarden-piv --branch feat/m1-m2-slice
# …or run directly on the current branch:
archon workflow run chartwarden-piv --no-worktree
```

To target **Wave A (M3+M4)** instead, name the plan path in the run message (the `setup` node resolves
it to `.archon/run-plan.txt` for every node, incl. fresh-context loop iterations):

```bash
archon workflow run chartwarden-piv --branch feat/wave-a "Use the plan at docs/plans/WAVE_A_M3-M4_PLAN.md"
```

The loop implements one plan task at a time in a **fresh context**, runs the fitness gate after each,
self-fixes on red, then **commits and opens the PR automatically — there is no interactive pause**
(review happens on the GitHub PR). Watch progress with `archon workflow status`.

> **Why no pause (ADR-0031).** Earlier `chartwarden-piv` ended at an `interactive: true` approve node. It
> **hung** on both the slice and Wave A (Archon [#1067](https://github.com/coleam00/Archon/issues/1067),
> the nested-Claude class issue), after building everything — forcing manual recovery. **v0.3.0** drops
> the interactive node: `finalize` composes the commit message + PR body (with an explicit reviewer
> call-out for any fitness-gate edits) and `pr` commits → pushes → opens the PR. See
> [ADR-0031](adr/ADR-0031-chartwarden-piv-no-interactive-approve.md).

> **Note on nesting.** Archon drives the `claude` CLI. Still launch it from a **normal terminal**
> (verify `echo "$CLAUDECODE"` prints blank), not inside a Claude Code / editor session — to avoid other
> nested-execution issues even though the approve hang itself is now moot.

(Bundled alternative: `archon workflow run archon-plan-to-pr` — a maintained plan→PR DAG; point its
plan input at the same file and set its validate step to `bun run build && bun run arch:fitness && bun
run test`.)

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
