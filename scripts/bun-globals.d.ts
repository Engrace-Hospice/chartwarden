// Ambient declarations for the Bun APIs this tree actually uses (F-012 / #34).
//
// `scripts/` runs under `bun`, so the `Bun` global is real — but the repo does not depend on
// `@types/bun`, and pulling in the full runtime typings to satisfy two call sites would be a
// supply-chain decision taken for a type error. Declaring only the members used keeps the checking
// honest: a THIRD Bun API added later fails to compile until someone declares it deliberately,
// which is the behaviour a blanket `declare const Bun: any` would remove.
declare namespace Bun {
  /** Blocks the thread for `ms` milliseconds. Used by the DR drill's Postgres readiness wait. */
  function sleepSync(ms: number): void;
  /** Writes `data` to `path`, creating it if needed. Used by the DR drill's config generation. */
  function write(path: string, data: string | Uint8Array): Promise<number>;
}
