/**
 * A backup copy's name (wave 4, T7).
 * ------------------------------------------------------------------------------------------------
 * `sed -i.bak` leaves `.gitleaks.toml.bak`, an editor leaves `notes.txt~`, `patch` leaves `x.ts.orig`: a copy of a
 * file, with its content. The copy holds what the file held, so the NAME that matters is the file's: `.env.bak` and
 * `tls.key.orig` are a live environment file and a key; `src/x.ts.bak` is source. Only a copy whose original
 * says nothing (`prod.bak`, `patients.sql.bak`) is judged a database backup. A text heuristic over names. Pure.
 */

/** Suffixes that mark a copy: `.bak`, `.orig`, `.old`, `.save`, `.swp` and an editor's trailing `~`. */
const BACKUP_SUFFIX = /(?:\.(?:bak|orig|old|save|swp)|~)$/i;

/** The most suffixes taken off (`x.ts.bak~`): a name is not scanned without bound. */
const MAX_SUFFIXES = 3;

/** Extensions of source, configuration and prose files: a copy of one is not a database backup. */
const SOURCE_EXTENSION =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|ya?ml|toml|css|scss|html|py|sh|bash|zsh|txt|rs|go|lock|svg)$/i;

/** `.bak` is also what a database backup of an unnamed original is called (`prod.bak`, `patients.sql.bak`). */
const DATABASE_BACKUP_SUFFIX = /\.bak$/i;

export interface BackupName {
  /** The name with its backup suffixes taken off (the original file's name). */
  readonly original: string;
  /** Did the name carry one? */
  readonly isCopy: boolean;
  /** Could it be a database backup: a `.bak` of an original that is not a source, configuration or prose file? */
  readonly mayBeDatabaseBackup: boolean;
}

/** Take a backup suffix (or a few) off the end of `path`. */
export function backupName(path: string): BackupName {
  let original = path;
  let isCopy = false;
  for (let i = 0; i < MAX_SUFFIXES && BACKUP_SUFFIX.test(original); i++) {
    original = original.replace(BACKUP_SUFFIX, "");
    isCopy = true;
  }
  const mayBeDatabaseBackup =
    isCopy && DATABASE_BACKUP_SUFFIX.test(path) && !SOURCE_EXTENSION.test(original);
  return { original, isCopy, mayBeDatabaseBackup };
}
