# Handoff to Claude Code: compliance harness on top of ECC

Paste this file, or point Claude Code at it, when you open the ChartWarden repo locally. It is the
condensed result of a planning session. You don't need the original conversation.

## What landed (branch `harness/compliance`, one patch)

| Path | Purpose |
|---|---|
| `.claude/settings.json` | Read denies for secrets, an **ask** list (harness, compliance, CI, deploy, push, ssh), an allow-list for read-only gates, ECC env tuning, and the hook wiring |
| `.claude/rules/phi-and-secrets.md` | Always loaded. Synthetic data only, no secrets, no prod access |
| `.claude/rules/{migrations,auth-and-audit,ai-features}.md` | Path-scoped rules that load only when those files are touched |
| `.claude/agents/compliance-reviewer.md` | Fresh-context HIPAA/SOC 2 diff review, run after `/ecc:code-review` |
| `.claude/skills/{compliance-pr,synthetic-phi,soc2-evidence}/` | Pre-PR pass, fixture conventions, audit-evidence packet |
| `scripts/harness/*.ts` | PreToolUse guard, Stop gate, PostToolUse ledger, `harness:phi-scan`, `harness:ledger:verify` |
| `scripts/check-compliance-controls.ts` | New `arch:compliance` gate, added to `arch:fitness` |
| `compliance/controls.yaml` | HIPAA §164.308/.310/.312 + SOC 2 TSC → evidence register: 21 rows, 7 honest partial/gap rows with dates |
| `compliance/synthetic-identifiers.json` | Allowed test SSNs/MBIs, seeded from values already in the repo |
| `.gitleaks.toml`, `.githooks/pre-commit`, CI job `secret-and-phi-scan` | Secret + PHI scanning on commit and in CI (gitleaks v8.30.1, checksum-pinned) |
| `docs/compliance/AGENT_HARNESS.md` | How each piece works, and why ECC's observer hooks are disabled |
| `docs/compliance/AISOC_INTEGRATION.md` | Runtime SOC plan (AiSOC as a sidecar inside the BAA boundary, ports 15000/15432/15379/15434) |
| `.gitignore` | `.claude/` is no longer ignored wholesale. Only local ledger, cache and settings files are |
| `CLAUDE.md` = `AGENTS.md` | New short "Compliance harness" section |

## Apply

```bash
git checkout -b harness/compliance
git apply --index chartwarden-compliance-harness.patch     # or unzip the file bundle at repo root
chmod +x .githooks/pre-commit
bun install && bun run setup:hooks
```

## Verify (this was all green in the planning session)

```bash
bun run arch:compliance
bun run harness:phi-scan --all
bunx vitest run scripts/__tests__/harness-patterns.test.ts scripts/__tests__/harness-hooks.test.ts \
  scripts/__tests__/compliance-controls.test.ts scripts/__tests__/fitness-runner.test.ts
bunx vitest run scripts/__tests__            # all gate self-tests
bun run typecheck && bun run arch:fitness
```

Then restart Claude Code in the repo and trust the folder. Check the harness live:
- Ask it to `cat .env`. It should be denied by `[chartwarden-harness]`.
- Ask it to write a test using a made-up but issuable-looking SSN (not 000/666/9xx). It should be denied, with a pointer to the registry.
- Make a small edit and end the turn. The Stop gate runs the change-scoped gates once, then skips on
  later turns until files change.
- Run `bun run harness:ledger:verify` and confirm the chain is intact.

## Known state of the uploaded snapshot (not caused by this patch)

- **CI does not gate main.** In `deploy.yml` the `verify` job, which calls `ci.yml`, is commented out,
  and `release` no longer `needs: verify`. `ci.yml`'s `pull_request` trigger only targets `fix/admission`.
  So a push to main builds, signs and deploys without CI running. The only gate is the opt-in pre-push
  hook. CLAUDE.md's debounce paragraph still describes `verify` as active. The register marks
  CW-CM-01 and CW-SEC-01 `partial` until this is fixed (review_by 2026-12-15). This is the
  highest-priority fix in this list.

- `arch:audit-exceptions` is **red on the snapshot**. Four new advisories (GHSA-44jh-23m7-hpcf,
  GHSA-q84f-53jg-9ppm, GHSA-r4xp-prcw-77qf, GHSA-965c-763c-88jm) are not in `ACCEPTED_ADVISORIES`.
  Fix the dependencies or add reviewed exceptions. `arch:fitness` will stay red until then.
- `bun run lint` reports 1,163 errors on the snapshot both with and without this patch. The patch
  adds none.
- The git history in the zip was not available, so `gitleaks git` (history scan) was not run against
  the real history. Run it once: `gitleaks git . --config .gitleaks.toml --redact`.

## Human decisions still open

1. **Confirm `compliance/synthetic-identifiers.json`.** It grandfathers every SSN/MBI-shaped value
   already committed (e.g. `539-22-4821`, `710-23-0081`, `6HU2YC8KT57`). Confirm none of them is a real
   person's identifier.
2. **Anthropic BAA / ZDR for Claude Code use.** Agents are kept away from PHI by design. If anyone
   ever pastes real chart content into a session, it is a disclosure unless the BAA covers it
   (CW-BA-01).
3. **Gap rows** (`partial`/`gap` in `controls.yaml`, all due by 2027-01-31): TLS gate, signed risk
   analysis, SIEM/alerting (AiSOC), incident tabletop, whole-DB restore drill with RTO/RPO, SAST
   (Semgrep ratchet), and a machine-checked vendor BAA register.
4. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` also turns off Claude Code auto-update in this repo.
   Remove it if you prefer auto-update.

## Suggested next tasks for Claude Code

- `/ecc:plan` "Close CW-VM-01: add pinned Semgrep packs with a findings ratchet to CI".
- `/ecc:plan` "AiSOC Phase 1: OCSF 6003 exporter from M4 audit events plus live suite" (see AISOC_INTEGRATION.md).
- `/ecc:plan` "Close CW-BA-01: compliance/vendors.yaml plus gate (vendor, PHI scope, BAA date, renewal)".
