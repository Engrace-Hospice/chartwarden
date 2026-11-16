/**
 * Ways to read a secret that no file name gives away: a recursive sweep over a directory that holds live
 * environment files, a copy of such a tree, the process environment, the keychain, a CLI's stored token.
 * ----------------------------------------------------------------------------------------------------
 * `grep -r x deploy/production` reads every live .env under it (grep -r ignores .gitignore). A text heuristic over
 * a few known locations and commands; what it does not name it cannot see. Pure.
 */
import { globMatches, globTokens } from "./glob";
import { fold } from "./path-alias";

/**
 * Where live environment files sit when the caller cannot list the tree (a unit test that injects only `exists`): the
 * usual ones in this repo. In production the classifier is handed the tree's real env files (`live-env-files.ts`, CR5-7)
 * and they are added to these; this list is no longer the definition.
 */
const FALLBACK_LIVE_ENV_FILES: readonly string[] = [
  ".env",
  "apps/backend/.env",
  "apps/web/.env",
  "apps/admin/.env",
  "deploy/production/.env.production",
  "deploy/production/.env.tenant",
  "deploy/production/.deploy-alert.env",
];

let LIVE_ENV_FILES: readonly string[] = FALLBACK_LIVE_ENV_FILES;
/** Did the listing of the tree's live env files see everything? When not, any directory "may" hold one (wave 8, CR6-6). */
let LIVE_ENV_COMPLETE = true;

/**
 * Add the live env files found in the tree to the fallback list (one classified command's view; `[]` clears it), and say
 * whether the listing was complete: an incomplete one makes every repo directory "may reach a live env file".
 */
export function setListedLiveEnvFiles(files: readonly string[], complete = true): void {
  LIVE_ENV_FILES = [...new Set([...FALLBACK_LIVE_ENV_FILES, ...files])];
  LIVE_ENV_COMPLETE = complete;
}

/** A repo-relative directory as the file system folds its name; the root (`""`) stays the root (`fold` makes it `/`). */
const foldedDirectory = (dir: string): string => (dir === "" ? "" : fold(dir));

/**
 * Does a recursive read of the repo-relative directory `dir` (`""` is the root) reach a live environment file that
 * exists? `exists` takes a repo-relative path. Compared as the file system folds names (case, normalization): `APPS/PORTAL`
 * is `apps/portal` (wave 8, ADV6-10).
 */
export function reachesLiveEnv(dir: string, exists: (file: string) => boolean): boolean {
  if (!LIVE_ENV_COMPLETE) return true;
  const d = foldedDirectory(dir.replace(/\/+$/, "").replace(/^\.$/, ""));
  return LIVE_ENV_FILES.some((f) => {
    const folded = fold(f);
    return (d === "" || folded === d || folded.startsWith(`${d}/`)) && exists(f);
  });
}

/** The existing live env files, each with every directory above it: what a recursive read of a tree can land on. */
function liveEnvPaths(exists: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const file of LIVE_ENV_FILES) {
    if (!exists(file)) continue;
    out.push(file);
    for (let slash = file.lastIndexOf("/"); slash > 0; slash = file.lastIndexOf("/", slash - 1)) {
      out.push(file.slice(0, slash));
    }
  }
  return out;
}

/**
 * Can this wildcard (a pathspec or a shell glob, repo-relative) match a directory that holds an existing live env
 * file, or the file itself? `*` is taken to cross `/`, as a git pathspec does, which is the wider reading.
 */
export function globReachesLiveEnv(glob: string, exists: (file: string) => boolean): boolean {
  if (!LIVE_ENV_COMPLETE) return true;
  const tokens = globTokens(fold(glob.replace(/\/+$/, "")));
  return liveEnvPaths(exists).some((path) => globMatches(tokens, fold(path)));
}

/**
 * Does the repo-relative directory `dir` (`""` is the root) hold an existing live env file as a DIRECT child? That is
 * all a non-recursive `diff DIR DIR` compares.
 */
export function holdsLiveEnvDirectly(dir: string, exists: (file: string) => boolean): boolean {
  if (!LIVE_ENV_COMPLETE) return true;
  const d = foldedDirectory(dir.replace(/\/+$/, "").replace(/^\.$/, ""));
  return LIVE_ENV_FILES.some(
    (f) => foldedDirectory(f.slice(0, Math.max(f.lastIndexOf("/"), 0))) === d && exists(f),
  );
}

/** The name of an environment variable that holds a secret. */
const SECRET_VARIABLE =
  /^[A-Z0-9_]*(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|_KEY)S?$/;
export const isSecretVariable = (name: string): boolean => SECRET_VARIABLE.test(name);

export { environmentLeak } from "./env-shapes";

export interface SecretVerdict {
  readonly decision: "ask" | "deny";
  readonly reason: string;
}

/** `docker inspect` prints the container's environment unless its format names something else. */
const INSPECT_LEAKS = /\.Env\b|\{\{\s*(?:json\s+)?\.(?:Config)?\s*\}\}/;

/**
 * A command that hands over a stored secret or the environment of a process: the keychain, a CLI's token,
 * `printenv NAME` for a secret name, `docker inspect`. Null for any other command.
 */
export function storedSecretVerdict(prog: string, args: readonly string[]): SecretVerdict | null {
  if (
    prog === "security" &&
    /^(?:find-(?:generic|internet)-password|dump-keychain|export|find-key)$/.test(args[0] ?? "")
  ) {
    return {
      decision: "deny",
      reason:
        "Reading the macOS keychain puts credentials into the transcript. Ask the human for any value you truly need.",
    };
  }
  if (prog === "gh" && args[0] === "auth") {
    const token =
      args[1] === "token" ||
      (args[1] === "status" && args.some((a) => a === "-t" || a === "--show-token"));
    if (token) {
      return {
        decision: "deny",
        reason: "Printing the GitHub CLI's stored token puts a credential into the transcript.",
      };
    }
  }
  if (prog === "printenv" && args.some(isSecretVariable)) {
    return {
      decision: "deny",
      reason:
        'Printing a secret-bearing variable puts it in the transcript. Check presence with `[ -n "$VAR" ] && echo set` instead.',
    };
  }
  if (/^(?:docker|podman|nerdctl)$/.test(prog) && args[0] === "inspect") {
    const format = args.findIndex(
      (a) => a === "-f" || a === "--format" || a.startsWith("--format="),
    );
    const value =
      format < 0
        ? ""
        : (args[format] ?? "").startsWith("--format=")
          ? (args[format] ?? "").slice(9)
          : (args[format + 1] ?? "");
    if (format < 0 || INSPECT_LEAKS.test(value)) {
      return {
        decision: "ask",
        reason:
          "`inspect` prints a container's environment, secrets included. Use `--format` with the one field you need.",
      };
    }
  }
  return null;
}
