// apps/backend/src/bootstrap/in-memory-ledger.ts — the in-memory-binding ledger + boot
// assertion (production-readiness audit 2026-08-03, TASK-001 / ARCH-003/006/007/015).
//
// THE PROBLEM THIS CLOSES: on a `DATABASE_URL` boot the composition root still binds a set of
// seam registrars, eraser registrars and route deps over `createInMemory*` stores. Every one of
// those is a per-process Map wearing a production contract: an erase "succeeds" against rows that
// exist nowhere, an audit event is written to memory and dies with the process, a cross-module
// reader answers "no rows" about a database it never read. Nothing fails, which is exactly the
// defect — a compliance-grade attestation minted from nothing.
//
// THE MECHANISM: the composition root (apps/backend/src/index.ts) records a ledger note beside
// every binding decision that falls back to an in-memory store while a DB client is present,
// and `assertNoInMemoryBindingsOnDbBoot` runs after ALL wiring (seams, erasers, route mounts)
// and before `listen()`:
//   · production (or WARDENX_INMEM_ASSERT=enforce anywhere): REFUSE TO BOOT, naming every binding.
//   · everywhere else (or WARDENX_INMEM_ASSERT=warn as the audit's one-iteration rollback in
//     production): log the full list loudly and continue — dev keeps working while Phase 1
//     (TASK-002/003/004) burns the list down to empty.
// A db-less boot is NOT asserted: the in-memory slice is the documented test/dev-slice posture.
//
// The ledger is deliberately additive-only within a boot: a note records that a fallback was
// CHOSEN, and nothing un-chooses it. Tests reset via __resetInMemoryLedgerForTest().

/** One in-memory binding chosen at the composition root while a DB client was present. */
export interface InMemoryBindingNote {
  /** What kind of contract the in-memory store stands behind. */
  kind: "seam" | "eraser" | "route-dep";
  /** Composition-root-unique label: module + registrar/mount + the affected contract names. */
  label: string;
  /** The backlog task that replaces this binding with a Drizzle store (audit report 14). */
  task: string;
}

const notes = new Map<string, InMemoryBindingNote>();

/**
 * Record that a binding decision fell back to an in-memory store. Called by the composition
 * root beside the registrar/mount call that made the choice — the note and the fallback must
 * live in the same diff, so TASK-002/003/004 remove both together.
 */
export function noteInMemoryBinding(note: InMemoryBindingNote): void {
  notes.set(`${note.kind}:${note.label}`, note);
}

/** Every in-memory binding recorded this boot, stable-sorted for deterministic output. */
export function inMemoryBindingNotes(): InMemoryBindingNote[] {
  return [...notes.values()].sort((a, b) =>
    `${a.kind}:${a.label}`.localeCompare(`${b.kind}:${b.label}`),
  );
}

export class InMemoryBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InMemoryBindingError";
  }
}

/** How the assertion reacts to a non-empty ledger on a db boot. */
export type InMemoryAssertMode = "enforce" | "warn";

/**
 * Resolve the assertion mode. `WARDENX_INMEM_ASSERT` wins when set (`enforce` anywhere,
 * `warn` as the audit's sanctioned one-iteration rollback in production); otherwise
 * production enforces and every other environment warns. An unrecognized value ENFORCES —
 * a typo in a safety flag must fail closed, not silently downgrade to a warning.
 */
export function resolveInMemoryAssertMode(env: {
  WARDENX_INMEM_ASSERT?: string;
  NODE_ENV?: string;
}): InMemoryAssertMode {
  const flag = env.WARDENX_INMEM_ASSERT?.trim().toLowerCase();
  if (flag === "warn") return "warn";
  if (flag) return "enforce"; // "enforce" or any unrecognized value — a typo'd safety flag fails closed
  return env.NODE_ENV === "production" ? "enforce" : "warn";
}

/**
 * The TASK-001 boot assertion. Call after ALL wiring (bootSeams + registerModuleRoutes) and
 * before `listen()`. No-op when no DB client is present (the in-memory slice is the documented
 * db-less posture). With a DB client and a non-empty ledger: throw in `enforce` mode, log the
 * full list in `warn` mode. Either way the list is never silent.
 */
export function assertNoInMemoryBindingsOnDbBoot(opts: {
  dbPresent: boolean;
  env?: { WARDENX_INMEM_ASSERT?: string; NODE_ENV?: string };
  /** Injected sink for the warn path (default console.warn) — testable, PHI-free by construction. */
  warn?: (message: string) => void;
}): void {
  if (!opts.dbPresent) return;
  const pending = inMemoryBindingNotes();
  if (pending.length === 0) return;
  const lines = pending.map((n) => `  · [${n.kind}] ${n.label} → ${n.task}`);
  const message =
    `${pending.length} in-memory binding(s) are standing behind production contracts on a ` +
    `DATABASE_URL boot — each one fakes success against a per-process Map ` +
    `(production-readiness audit TASK-001):\n${lines.join("\n")}`;
  const mode = resolveInMemoryAssertMode(opts.env ?? process.env);
  if (mode === "enforce") {
    throw new InMemoryBindingError(
      `Refusing to boot — ${message}\nSet WARDENX_INMEM_ASSERT=warn for the audit's one-iteration rollback.`,
    );
  }
  (opts.warn ?? console.warn)(`⚠️  ${message}`);
}

/** Test-only: clear the ledger between cases. */
export function __resetInMemoryLedgerForTest(): void {
  notes.clear();
}
