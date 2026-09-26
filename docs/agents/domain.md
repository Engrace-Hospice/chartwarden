# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

This is a **single-context** repo:

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── ADR-0001-rhc-two-tier-rate.md
│   └── ADR-0002-hospice-cap-year.md
├── apps/
└── packages/
```

The workspace is a monorepo (`apps/*`, `packages/*`), but the documentation corpus is deliberately
single-context: `docs/README.md` is the one entry point and four fitness gates treat `docs/` as a
single body. Don't scatter per-package `CONTEXT.md` files.

## In this repo

- **`CONTEXT.md` does not exist yet.** That is expected — proceed silently. `/domain-modeling`
  creates it lazily when a term actually gets resolved.
- **`docs/adr/` is a live register**, 47 ADRs + a `README.md` index, gated by
  `scripts/check-adr-docs.ts` (`bun run arch:adr-docs`, in `arch:fitness`): contiguous unique
  numbering, index parity, and an index status cell that must agree with the file.
- **ADRs are immutable once Accepted.** Contradicting one means writing a NEW ADR that supersedes
  it (and citing the successor in the old one's Status line) — never editing the accepted decision.
- The repo's own authority rule still governs: `docs/architecture/` wins over module and screen
  specs, which are implementation proposals.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (M8/M9/M10 read direction) — but worth reopening because…_
