# ADR-0029 — Split `x12-worker-client` into per-module adapter packages

- **Status:** Accepted (applied 2026-06-14 — manifest edited, `.cjs` mirror updated, 2 packages
  scaffolded; `arch:fitness` green at 38 packages; Wave G plan corrected)
- **Date:** 2026-06-14
- **Phase:** pre-build governance (applies before Wave G — M23/M25 billing — builds)
- **Resolves:** the open item left by [ADR-0028](ADR-0028-adapter-package-codepaths.md) — the one
  adapter package that could not simply join a `codePath` because it is referenced by **two** modules.
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (codePaths define ownership +
  one owner per path; `dependsOn` defines who may import whom) and ADR-0028 (adapter packages are
  fitness-governed via codePaths).
- **Changes (on acceptance):** `architecture/module-manifest.ts` + `.cjs` mirror (`codePaths` for
  M23 and M25); regenerate the tree via `bun run scaffold`. No `dependsOn`/`ownedTables`/`VENDOR_ADAPTERS`
  change. Corrects one line of the Wave G plan (M25 277CA parsing — see Consequences).

## Context

The X12 EDI envelope work runs in a shared **Python `x12-worker` sidecar** (architecture §12); the
TypeScript "client" is the adapter that fronts it over internal HTTP. Two modules use it:

- **M23 (Billing-Medicare):** generates the **837I** claim and parses the **999** + **277CA**
  acknowledgments.
- **M25 (Remittance):** parses the **835** ERA.

ADR-0028 governed every *single-owner* adapter by adding it to its owner's `codePaths`. This one can't
follow that pattern: a `codePath` has exactly one owner (it defines ownership + the dependency-cruiser
`from` boundary), and **M23 may not import an M25-owned package** — `dependsOn` is `M25 → M23`, never
the reverse. A shared `packages/x12-worker-client` would force a single owner and let the non-owner
reach across an undeclared boundary (the exact thing the boundary gate forbids).

The Python sidecar itself is **not** a TypeScript package — it's a service declared in M1/services, out
of the codePath model. Only the TS adapter is importable code that needs an owner.

## Decision

**Split the adapter into two single-owner TypeScript packages, each fronting the same Python sidecar:**

| Package | Owner | Surface |
|---|---|---|
| `packages/x12-837-client` | **M23** | 837I generation + 999 + 277CA acknowledgment parsing |
| `packages/x12-835-client` | **M25** | 835 ERA parsing |

In `architecture/module-manifest.ts` (+ `.cjs`):
- M23 `codePaths`: add `"packages/x12-837-client"`.
- M25 `codePaths`: add `"packages/x12-835-client"`.

Both are hand-rolled HTTP to the sidecar (no vendor SDK), so **no `VENDOR_ADAPTERS` entry**; the sidecar
URL/credentials live **only** inside these two packages (architecture §25.14 adapter mandate). The
shared sidecar's request/response shapes are typed in `packages/types` (a leaf), so neither package
imports the other.

### 277CA ownership (removes a duplication)
277CA acknowledgments are a **claim-submission** artifact, so parsing them belongs to **M23**
(`x12-837-client`). **M25 does not parse 277CA** — it seeds its denial worklist from the
`m23.claim.rejected` outbox event (which M23 derives from its own 277CA parse). This keeps one parser
per transaction type and respects the `M25 → M23` direction (outbox needs no edge).

## Application

Same mechanical path as ADR-0028 (recommended: apply now, per ADR-0027 D-f):
1. Edit `architecture/module-manifest.ts` and the `.cjs` mirror (M23/M25 `codePaths`).
2. `bun run scaffold` → generates `packages/x12-837-client` + `packages/x12-835-client` (empty governed
   stubs) + root `tsconfig.json` references (36 → 38 packages).
3. `bun install` (link the new workspaces) → `bun run arch:fitness` stays green; `arch:parity` 1:1.

## Consequences

- The X12 adapters are fitness-governed with correct, single-owner boundaries before Wave G builds.
- Package count 36 → 38.
- **Wave G plan correction:** `WAVE_G_M23-M25-M26_PLAN.md` currently names `packages/x12-worker-client`
  with "M23 slice / M25 slice" and has M25-T04 "parse 835 + 277CA". Update to: M23-T07 →
  `packages/x12-837-client` (837 + 999 + 277CA); M25-T04 → `packages/x12-835-client` (**835 only**;
  277CA-derived denials arrive via `m23.claim.rejected`).
- `@wardenx/mobile-offline` remains the only deliberately manifest-exempt package; with this ADR there
  are **no remaining ungoverned adapter packages**.
