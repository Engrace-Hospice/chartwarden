// CW-DS-01 — how scripts/object-store-copy.ts reads and reports its tombstone settings: which list, whether the run destroys or only
// counts (a DRY RUN unless `--apply-tombstones` / OBJECT_COPY_TOMBSTONES_APPLY=1), the per-run cap, the plan line printed before
// anything is destroyed, and the alert for a clean run that left listed objects on the replica. Moved out of the copy tool unchanged
// (the tool re-exports every name here, so its public surface is the same); it needs nothing from the copy tool at run time.
import { readFile } from "node:fs/promises";
import { NO_TOMBSTONES, type TombstoneIndex, parseTombstones } from "./object-tombstones";

export type Env = Record<string, string | undefined>;

/** CW-DS-01 — most objects one run may destroy on the strength of the tombstone list (a bigger plan is refused whole). */
export const DEFAULT_MAX_TOMBSTONE_DELETIONS = 100;

/** CW-DS-01 — what the run did with the list: `dry-run` counts and reports, `apply` destroys, `refused` is `apply` over the limit. */
export type TombstoneMode = "off" | "dry-run" | "apply" | "refused";

/** The plan made before anything is destroyed. Counts only: the keys name erased patients. */
export interface TombstonePlan {
  readonly mode: TombstoneMode;
  /** Objects the list names (on any store). */
  readonly listed: number;
  readonly buckets: number;
  /** Listed objects the target holds: what an apply destroys. */
  readonly onTarget: number;
  readonly limit: number;
}

/** The part of a copy summary the pending alert reports (counts only). */
export interface TombstonePendingSummary {
  readonly tombstoneMode: TombstoneMode;
  readonly tombstonesOnTarget: number;
  readonly deleted: number;
  readonly skippedTombstoned: number;
}

/**
 * CW-DS-01 — a CLEAN scheduled run whose list still named objects the replica held and was not applied: nothing failed, so no
 * `object_copy.failed`, but the copy holds destroyed documents until OBJECT_COPY_TOMBSTONES_APPLY=1. Counts only. (The count is
 * taken at the start of the run: the forward copy's own delete-missing may already have removed some of them by its end.)
 */
export function tombstonesPendingBody(summary: TombstonePendingSummary, now: Date): string {
  return JSON.stringify({
    kind: "object_copy.tombstones_pending",
    summary: `second copy: the tombstone list names ${summary.tombstonesOnTarget} object(s) the replica held at the start of the run and OBJECT_COPY_TOMBSTONES_APPLY is not 1, so nothing was destroyed on the list's strength`,
    details: {
      tombstoneMode: summary.tombstoneMode,
      tombstonesOnTarget: summary.tombstonesOnTarget,
      deleted: summary.deleted,
      skippedTombstoned: summary.skippedTombstoned,
    },
    occurredAt: now.toISOString(),
  });
}

/**
 * CW-DS-01 — the tombstone list named by `--tombstones <file>` or OBJECT_COPY_TOMBSTONES_FILE, read fresh on every run. A file
 * that is named but cannot be read or parsed throws, so the run stops before touching an object (and the schedule pages).
 */
export async function loadTombstones(env: Env, argv: readonly string[]): Promise<TombstoneIndex> {
  const at = argv.indexOf("--tombstones");
  const path = (at >= 0 ? argv[at + 1] : env.OBJECT_COPY_TOMBSTONES_FILE)?.trim();
  if (at >= 0 && !path) throw new Error("--tombstones needs a file path");
  if (!path) return NO_TOMBSTONES;
  return parseTombstones(await readFile(path, "utf8"));
}

const WHOLE_NUMBER = /^[1-9]\d*$/;
export const TOMBSTONE_FLAGS = ["--tombstones", "--apply-tombstones", "--max-deletions"] as const;

/** `--flag=value` is not understood and would be dropped silently (a restore that loads no list resurrects destroyed documents). */
export function assertNoEqualsForms(argv: readonly string[]): void {
  for (const arg of argv)
    for (const flag of TOMBSTONE_FLAGS)
      if (arg.startsWith(`${flag}=`))
        throw new Error(
          `${flag}= is not understood: pass the flag and its value as separate arguments`,
        );
}

/**
 * CW-DS-01 — how a run applies the list: a dry run unless `--apply-tombstones` / OBJECT_COPY_TOMBSTONES_APPLY=1, and at most
 * `--max-deletions <n>` / OBJECT_COPY_TOMBSTONES_MAX_DELETIONS objects per run (the flag wins). Throws on an apply value that is
 * not 1/0/true/false (a typo must not read as a dry run), on a limit that is not a whole number >= 1, and on either setting
 * without a list (it would be dropped silently). A one-off run passes `{}` as `env`: only the scheduled copy reads them there.
 */
export function tombstoneApplyFromArgs(
  env: Env,
  argv: readonly string[],
  listNamed: boolean,
): { readonly apply: boolean; readonly maxDeletions: number } {
  const applyText = env.OBJECT_COPY_TOMBSTONES_APPLY?.trim().toLowerCase() ?? "";
  if (!["", "0", "1", "true", "false"].includes(applyText))
    throw new Error(
      "OBJECT_COPY_TOMBSTONES_APPLY must be 1 or 0 (anything else is refused, not read as a dry run)",
    );
  const apply = argv.includes("--apply-tombstones") || applyText === "1" || applyText === "true";
  const at = argv.indexOf("--max-deletions");
  const limitText = (at >= 0 ? argv[at + 1] : env.OBJECT_COPY_TOMBSTONES_MAX_DELETIONS)?.trim();
  if (!listNamed && (apply || at >= 0 || limitText))
    throw new Error(
      "--apply-tombstones, --max-deletions, OBJECT_COPY_TOMBSTONES_APPLY and OBJECT_COPY_TOMBSTONES_MAX_DELETIONS need a tombstone list (--tombstones <file> or OBJECT_COPY_TOMBSTONES_FILE)",
    );
  if (at >= 0 && !limitText) throw new Error("--max-deletions needs a whole number >= 1");
  if (!limitText) return { apply, maxDeletions: DEFAULT_MAX_TOMBSTONE_DELETIONS };
  if (!WHOLE_NUMBER.test(limitText))
    throw new Error(
      `${at >= 0 ? "--max-deletions" : "OBJECT_COPY_TOMBSTONES_MAX_DELETIONS"} needs a whole number >= 1 (got "${limitText}")`,
    );
  return { apply, maxDeletions: Number(limitText) };
}

/** The line printed (stderr) after the target was counted and before anything is destroyed. Counts only, never a key. */
export function describeTombstonePlan(plan: TombstonePlan): string {
  const head = `tombstones: the list names ${plan.listed} object(s) in ${plan.buckets} bucket(s); the target holds ${plan.onTarget} of them (limit ${plan.limit} per run).`;
  switch (plan.mode) {
    case "off":
      return `${head} Nothing to do.`;
    case "dry-run":
      return `${head} DRY RUN: nothing is destroyed on the strength of the list; re-run with --apply-tombstones (OBJECT_COPY_TOMBSTONES_APPLY=1) to destroy them.`;
    case "apply":
      return `${head} APPLYING: destroying ${plan.onTarget} object(s), every version.`;
    case "refused":
      return `${head} REFUSED: ${plan.onTarget} is over the limit ${plan.limit}; nothing is destroyed. Raise it deliberately with --max-deletions <n> (OBJECT_COPY_TOMBSTONES_MAX_DELETIONS) once you have checked the list.`;
  }
}

/**
 * CW-DS-01 — the apply/limit settings of one run. The scheduled copy takes them from the environment only; a one-off run takes
 * them from its flags only, so an OBJECT_COPY_TOMBSTONES_APPLY=1 a container inherited from .env.production can never turn the
 * dry run an operator typed into a destruction.
 */
export function resolveTombstoneSettings(
  env: Env,
  argv: readonly string[],
  scheduled: boolean,
): { readonly apply: boolean; readonly maxDeletions: number } {
  const named = argv.includes("--tombstones") || Boolean(env.OBJECT_COPY_TOMBSTONES_FILE?.trim());
  return tombstoneApplyFromArgs(scheduled ? env : {}, argv, named);
}
