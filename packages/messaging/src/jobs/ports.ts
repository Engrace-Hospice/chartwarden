// @wardenx/messaging — in-memory adapters for the messaging job processors (M36-T08, §4.4).
//
// Deterministic, infra-free ports the job unit tests run against — the same forward pattern as the
// M4 audit / M38 terminology job ports. The adapter records what the processor asked it to do so a
// run's effects are assertable; the production Drizzle/Valkey/DEK-decrypt adapters bind the
// identical port shapes at boot.
import type { HashMismatchEvent, HashVerifyPorts, HashVerifySampleRow } from "./processors";

/**
 * In-memory {@link HashVerifyPorts}. `recomputed` maps a messageId → the hash the decrypt-and-rehash
 * would yield, or `null` to simulate a destroyed tenant DEK (offboarded tenant; decode skipped).
 * Captures every emitted `m36.integrity.hash_mismatch` for assertion.
 */
export function createInMemoryHashVerifyPorts(seed: {
  readonly recomputed?: Readonly<Record<string, string | null>>;
}): { ports: HashVerifyPorts; mismatches(): HashMismatchEvent[] } {
  const mismatches: HashMismatchEvent[] = [];
  const ports: HashVerifyPorts = {
    recomputeHash: (row: HashVerifySampleRow) =>
      Promise.resolve(seed.recomputed?.[row.messageId] ?? null),
    emitMismatch: (event) => {
      mismatches.push(event);
      return Promise.resolve();
    },
  };
  return { ports, mismatches: () => mismatches };
}
