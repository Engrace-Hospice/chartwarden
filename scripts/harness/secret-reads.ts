/**
 * Ways to read a secret that no file name gives away: a recursive sweep over a directory that holds live
 * environment files, a copy of such a tree, the process environment, the keychain, a CLI's stored token.
 * ----------------------------------------------------------------------------------------------------
 * `grep -r x deploy/production` reads every live .env under it (grep -r ignores .gitignore). A text heuristic over
 * a few known locations and commands; what it does not name it cannot see. Pure.
 */

/** Where live environment files sit in this repo (their `.example` templates are tracked beside them). */
const LIVE_ENV_FILES: readonly string[] = [
  ".env",
  "apps/backend/.env",
  "apps/web/.env",
  "apps/admin/.env",
  "deploy/production/.env.production",
  "deploy/production/.env.tenant",
  "deploy/production/.deploy-alert.env",
];

/**
 * Does a recursive read of the repo-relative directory `dir` (`""` is the root) reach a live environment file that
 * exists? `exists` takes a repo-relative path.
 */
export function reachesLiveEnv(dir: string, exists: (file: string) => boolean): boolean {
  const d = dir.replace(/\/+$/, "").replace(/^\.$/, "");
  return LIVE_ENV_FILES.some((f) => (d === "" || f === d || f.startsWith(`${d}/`)) && exists(f));
}

/** The name of an environment variable that holds a secret. */
const SECRET_VARIABLE =
  /^[A-Z0-9_]*(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|CREDENTIAL|_KEY)S?$/;
export const isSecretVariable = (name: string): boolean => SECRET_VARIABLE.test(name);

const SECRET_WORDS = String.raw`[A-Za-z0-9_]*(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|_KEY)`;
/** What prints or serializes its argument. A script that only PASSES the environment on (`connect(process.env)`) is not one. */
const SINK = String.raw`(?:print|pprint|repr|json\.dumps|console\.(?:log|info|warn|error|dir)|JSON\.stringify|Object\.(?:keys|values|entries)|puts|p)`;
/** A script printing the whole environment: `print(os.environ)`, `console.log(process.env)`, `print %ENV`, `p ENV.to_h`. */
const ENVIRONMENT_DUMP = new RegExp(
  String.raw`\b${SINK}\s*\(?\s*(?:dict\(\s*)?(?:os\.environ|process\.env)\b(?![.\[])|\b(?:print|puts|p)\s+(?:%ENV\b|ENV\.(?:to_h|to_a|inspect)\b)`,
);
/** A script printing one secret variable by name. */
const SECRET_LOOKUP = new RegExp(
  String.raw`\b${SINK}\s*\(?\s*(?:os\.environ(?:\.get)?\s*[\[(]\s*['"]|os\.getenv\s*\(\s*['"]|process\.env\.|process\.env\[\s*['"]|ENV\[\s*['"])${SECRET_WORDS}`,
);

/** What inline or stdin script text prints from the environment: all of it, or a secret by name; null for neither. */
export function environmentLeak(text: string): "dump" | "secret" | null {
  if (ENVIRONMENT_DUMP.test(text)) return "dump";
  return SECRET_LOOKUP.test(text) ? "secret" : null;
}

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
