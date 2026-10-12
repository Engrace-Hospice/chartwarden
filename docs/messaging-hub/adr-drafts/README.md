# Messaging Hub (M36) — ADR drafts

These five drafts are **not** part of the ADR register. They live here so the product owner can review them before any are
promoted to `docs/adr/`. They are deliberately absent from `docs/adr/README.md`; `bun run arch:adr-docs` only scans `docs/adr`
and does not see this directory. Source plan: [`../README.md`](../README.md) (decisions D1-D11), [`../02-architecture-and-domain.md`](../02-architecture-and-domain.md)
§8, [`../audit/PHASE_0_AUDIT.md`](../audit/PHASE_0_AUDIT.md).

| Intended no. | Draft | Needed before | Supersedes / extends | Depends on (drafts) | Status |
|---|---|---|---|---|---|
| 0054 | [Realtime transport: Socket.IO + Valkey](./ADR-0054-realtime-transport-socketio-valkey.md) | Phase 1 (WP 1.1) | **Supersedes ADR-0036 Decision 2 and 3 only** (Decision 1 and the contract-only-package consequence stay in force) | none | Proposed |
| 0055 | [Message revisions and redaction](./ADR-0055-message-revisions-and-redaction.md) | Phase 1 (WP 1.3) | Extends M36 spec §3.4, ADR-0004; interacts with ADR-0051 | 0054 (event hint) | Proposed |
| 0056 | [Clinical acknowledgment vs read receipts](./ADR-0056-clinical-acknowledgment-vs-read-receipts.md) | Phase 4 (WP 4.1-4.6); `ack` retirement in Phase 1 | Retires `message_receipt` `ack` (audit F7) | 0055 (ack binds to a revision), 0057 (who is paged) | Proposed; needs clinical-lead sign-off of D4 numbers |
| 0057 | [Escalation ownership M19 / M36](./ADR-0057-escalation-ownership-m19-m36.md) | Phase 4 (WP 4.3); contract in Phase 0 (WP 0.5) | Extends ADR-0005 (seams) | 0056 | Proposed; needs a named M19 owner |
| 0058 | [Global search: blind-token index](./ADR-0058-messaging-global-search-blind-token-index.md) | Phase 2 (WP 2.7b) | Extends ADR-0038, ADR-0045 | 0055 (deletion on redaction) | Proposed; **design review required before acceptance** |

Cross-citations: 0054, 0055, 0056, 0057, 0058 cite each other by number. **Promote in numeric order, or all together**, otherwise the
CITATIONS rule of `scripts/check-adr-docs.ts` fails on a reference to a number that has no file.

## What the ADR gate requires (read from `scripts/check-adr-docs.ts`)

- File name `docs/adr/ADR-NNNN-<slug>.md`; numbers unique and **contiguous from 0001** (no gaps, so a skipped number fails).
- A parseable `**Status:**` line; first word one of Accepted / Proposed / Superseded / Rejected / Deprecated. `Superseded` must cite
  `ADR-NNNN` on that line.
- One row in the `docs/adr/README.md` index table in the form
  `| [NNNN](ADR-NNNN-slug.md) | Title | Resolves | Status |`; the row's first status word must equal the file's.
- Every `ADR-NNNN` mention in any ADR resolves to a file; every relative markdown link starting `./` or `../` resolves from `docs/adr/`.
  The drafts therefore cite repo files as backticked paths, not links, and link ADRs by bare file name.
- Section headings (Context / Decision / Alternatives / Consequences / Migration / Verification / Open questions) are **not** gated;
  the repo's existing ADRs use a bullet header (Status, Date, Phase, Extends/Supersedes, Related), which the drafts copy.

## Promotion checklist

1. **Number check.** `git fetch`; list `docs/adr` on `main` and open PR branches (`git ls-tree origin/main docs/adr`, `gh pr list`).
   If 0054-0058 are taken, renumber the files **and** every `ADR-005x` cross-citation inside the five drafts and in this table.
2. **Owner decisions in hand.** Product owner accepts each draft; D4 numbers signed by the clinical lead (0056); M19 owner named
   (0057); design review record (security architect + privacy officer, D10) linked and the pre-production leakage test passed
   (0058, otherwise leave Status Proposed); clinical lead has signed the eligible roles for the Critical class (0056, D7) and the
   single-officer countersign period is set (0055, D9).
3. Copy the files to `docs/adr/` with the same names; set the real Status line and date; delete the "Number check" note.
4. **ADR-0036.** It is Accepted and ADRs are immutable once Accepted, but it needs a pointer to 0054. The gate allows only a whole-ADR
   `Superseded` status and 0036 Decision 1 remains in force, so do **not** flip it to Superseded. Add an additive line to its header,
   for example "Decision 2 and 3 superseded by ADR-0054", leaving the Status word `Accepted`, and update its index row's text.
   Decided 2026-10-11 by the product owner (D5): this approach is approved; the gate is not loosened.
5. **ADR index.** Add one row per ADR to `docs/adr/README.md` (status word identical to the file; the Resolves column cites the audit
   finding, for example F1, F3, F7, F12, D1-D4, and the plan).
6. Run `bun run arch:adr-docs` (and `bun run arch:fitness`); fix numbering, citations and links.
7. **docs/README.** Add the ADRs to the `docs/README.md` index (the master index of docs under `docs/`) and remove or update links to
   this `adr-drafts/` directory in `docs/messaging-hub/*.md` (`02` §8 table: replace "Proposed ADR" rows with links).
8. If `CLAUDE.md` changes in the same commit, copy it verbatim to `AGENTS.md`.
9. Run `/ecc:code-review` on the branch diff in a fresh agent before pushing; batch with other pushes (metered Actions minutes).
10. Delete the promoted drafts from this directory (or leave a one-line pointer) so two copies cannot drift.
